#!/bin/bash
# orq supervisor: runs one CLI job in its own process group, watches for a
# cancel file, and leaves the job's artifacts in the job directory.
#
# Usage: supervise.sh <dir> <runner> <cwd> [model] [effort] [sandbox]
#   runner: codex | opencode | agy | claude
#   instance env (e.g. CODEX_HOME) arrives in the environment.
#   When <dir>/flags exists, each non-empty line is one extra CLI argument,
#   appended in order to the runner's argv before the prompt. Callers pass
#   effort and sandbox empty and put everything in flags.
#
# Files in <dir>: prompt.txt (input), pgid, cli.pid (OpenCode only: the pid of
# the client), events.jsonl (CLI stdout), stderr.txt, last.txt (final
# message), session (the worker's session id, when the stream names one),
# exit (numeric exit code). session goes in before exit, so whoever reads
# exit finds it.
#
# When <dir>/resume exists, its first line is the id of a session to continue:
# the CLI resumes it, with prompt.txt as the next message, instead of starting
# a new one, and child.log gets one line with the argv that ran, minus the prompt.
#
# Started as the main process of a transient user unit (systemd makes it a
# session and group leader), or under setsid when no user manager is
# reachable, so $$ is the process-group leader. If the launching session
# dies, nothing is killed: the job runs to completion on its own. When the CLI
# is gone, however it ended, sweep.py ends what it left running outside the
# group: every process that still carries ORQ_JOB_DIR=<dir>.
#
# A <dir>/cancel file ends the job. The watcher looks for it every 2 s, then:
#   1. OpenCode only: SIGINT to the client, and up to 3 s for it to end. A
#      client still running after that gets one line in child.log.
#   2. If the CLI is still running, SIGTERM to the process group.
#   3. When the CLI has ended, the main flow stops the watcher, sweeps, writes
#      exit 124 and sends SIGKILL to the group, itself included. When the CLI
#      is still running 5 s after the SIGTERM, the watcher takes the same
#      steps, except that it leaves an existing exit alone; its sweep may end
#      run_cli, which wakes the main flow to repeat them.
# So exit appears after the sweep and just before the group's SIGKILL.
dir=$1; runner=$2; cwd=$3; model=${4:-}; effort=${5:-}; sandbox=${6:-}

echo $$ > "$dir/pgid"
trap '' TERM
sweep=$(cd "$(dirname "$0")" && pwd)/sweep.py
extract=$(cd "$(dirname "$0")" && pwd)/extract.py

flags=()
if [ -f "$dir/flags" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] && flags+=("$line")
  done < "$dir/flags"
fi

# Keep prompt.txt as one exact argv value, including trailing newlines. Bash
# command substitution strips trailing newlines, so read through EOF using
# NUL as a delimiter (NUL cannot be represented in an argv value).
read_prompt() {
  prompt=
  IFS= read -r -d '' prompt < "$dir/prompt.txt" || :
}

# $BASHPID, not $$: the runner and the watcher are subshells, and bash keeps $$
# at the supervisor's pid inside them.
write_exit() {
  local tmp="$dir/exit.$BASHPID.tmp"
  printf '%s\n' "$1" > "$tmp" && mv -f "$tmp" "$dir/exit"
}

# A session id reaches the CLI as one argument, so only a plain one is resumed. fd 3 is child.log, where a resumed job
# says which argv it ran; a job that starts afresh writes nothing there.
resume=
if [ -s "$dir/resume" ]; then
  IFS= read -r resume < "$dir/resume" || :
  case "$resume" in
    '' | -* | *[!A-Za-z0-9._:-]*)
      echo "orq: the session to resume is not a plain id, so no worker was started" > "$dir/stderr.txt"
      write_exit 4
      exit 0
      ;;
  esac
  exec 3>&1
fi
log_resume() {
  local tail=$1
  shift
  { printf 'orq: resume:'; printf ' %q' "$@"; [ -z "$tail" ] || printf ' %s' "$tail"; printf '\n'; } >&3
}

# The session id the stream names, or else the one this job resumed, for a later answer to continue. A cancelled job
# has no use for it.
write_session() {
  [ -e "$dir/cancel" ] && return 0
  python3 "$extract" "$dir/events.jsonl" "$runner" "$dir/session" > /dev/null 2>&1
  if [ ! -s "$dir/session" ] && [ -n "$resume" ]; then printf '%s\n' "$resume" > "$dir/session"; fi
  return 0
}

# A CLI can leave a process running outside its process group, such as an MCP server that OpenCode was still
# starting when it exited. The start script puts ORQ_JOB_DIR in every job's environment, which finds it.
# sweep.py needs /proc, so on macOS the sweep does nothing.
sweep_job() {
  [ "${ORQ_JOB_DIR:-}" = "$dir" ] && python3 "$sweep" "ORQ_JOB_DIR=$dir"
  return 0
}

# OpenCode takes SIGTERM for a server restart: the session keeps its claim, and the shared background service
# resumes it on its next start. SIGINT aborts the session, as Ctrl-C does. run_opencode records the client's pid
# where it execs it, so the signal needs neither pgrep nor the process name.
interrupt_cli() {
  [ "$runner" = opencode ] || return 0
  local cli i
  { read -r cli < "$dir/cli.pid"; } 2>/dev/null
  [[ "$cli" =~ ^[0-9]+$ ]] || return 0
  kill -INT "$cli" 2>/dev/null || return 0
  for i in $(seq 1 30); do
    kill -0 "$child" 2>/dev/null || return 0
    sleep 0.1
  done
  echo "orq: OpenCode did not end on SIGINT within 3 s, so the cancel falls back to SIGTERM" >&2
}

# The watcher's sleep outlives it, and a cancel's sleep lasts 5 s. Stopping the watcher first keeps it from
# starting another before its children are collected, and from sweeping while the main flow does. pgrep finds
# the children; without it the sweep ends the watcher's sleep and says so in child.log.
stop_watcher() {
  local kids stat i
  kill -STOP "$watcher" 2>/dev/null
  for i in $(seq 1 50); do
    { read -r stat < "/proc/$watcher/stat"; } 2>/dev/null || break
    [[ "${stat##*) }" == T* ]] && break
    sleep 0.002
  done
  kids=$(pgrep -P "$watcher" 2>/dev/null)
  kill -KILL "$watcher" $kids 2>/dev/null
  wait "$watcher" 2>/dev/null
}

# `codex exec resume` takes no -s, -C or --approve-for-me. The sandbox travels as config, and --approve-for-me is the
# three settings it stands for. A resume that names no sandbox runs in the one of the user's config.toml, which can be
# broader than the one the job started in, so every mode names its own.
codex_resume_flags() {
  cflags=()
  local i=0 flag
  while [ "$i" -lt "${#flags[@]}" ]; do
    flag=${flags[$i]}
    case "$flag" in
      -s)
        i=$((i + 1))
        if [ -n "${flags[$i]:-}" ]; then cflags+=(-c "sandbox_mode=\"${flags[$i]}\""); fi
        ;;
      --approve-for-me) cflags+=(-c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"' -c 'sandbox_mode="workspace-write"') ;;
      *) cflags+=("$flag") ;;
    esac
    i=$((i + 1))
  done
}

run_codex() {
  if [ -n "$resume" ]; then
    codex_resume_flags
    rargs=(exec resume --json -o "$dir/last.txt")
    [ -n "$model" ] && rargs+=(-m "$model")
    [ -n "$effort" ] && rargs+=(-c "model_reasoning_effort=\"$effort\"")
    rargs+=(--skip-git-repo-check)
    [ -n "$sandbox" ] && rargs+=(-c "sandbox_mode=\"$sandbox\"")
    rargs+=("${cflags[@]}" "$resume" -)
    log_resume '' codex "${rargs[@]}"
    ( cd "$cwd" && codex "${rargs[@]}" ) < "$dir/prompt.txt" > "$dir/events.jsonl" 2> "$dir/stderr.txt"
    return
  fi
  args=(exec --json -o "$dir/last.txt")
  [ -n "$model" ] && args+=(-m "$model")
  [ -n "$effort" ] && args+=(-c "model_reasoning_effort=\"$effort\"")
  [ -n "$sandbox" ] && args+=(-s "$sandbox")
  args+=(-C "$cwd" --skip-git-repo-check "${flags[@]}" -)
  codex "${args[@]}" < "$dir/prompt.txt" > "$dir/events.jsonl" 2> "$dir/stderr.txt"
}

run_opencode() {
  read_prompt
  # --standalone runs a private server that ends with the job. Without it OpenCode hands the run to
  # its shared background service, which leaves the user's MCP servers running and keeps the
  # environment it started with.
  head=(run --standalone --format json)
  [ -n "$resume" ] && head+=(--session "$resume")
  head+=(-m "$model")
  [ -n "$resume" ] && log_resume '-- <prompt.txt>' opencode "${head[@]}" "${flags[@]}"
  ( echo "$BASHPID" > "$dir/cli.pid"; cd "$cwd" && exec opencode "${head[@]}" "${flags[@]}" -- "$prompt" ) > "$dir/events.jsonl" 2> "$dir/stderr.txt"
  code=$?
  if [ -e "$dir/cancel" ]; then return $code; fi
  python3 - "$dir/events.jsonl" "$dir/last.txt" <<'PY' 2>/dev/null
import json, sys
last = None
try:
    for line in open(sys.argv[1]):
        try:
            o = json.loads(line)
        except Exception:
            continue
        p = o.get('part') or {}
        if p.get('type') == 'text' and p.get('text'):
            last = p['text']
except Exception:
    pass
if last is not None:
    open(sys.argv[2], 'w').write(last)
PY
  return $code
}

run_agy() {
  read_prompt
  : > "$dir/last.txt"
  args=(--output-format stream-json)
  [ -n "$resume" ] && args=(--conversation "$resume" --output-format stream-json)
  [ -n "$model" ] && args+=(--model "$model")
  [ -n "$resume" ] && log_resume '--print <prompt.txt>' agy "${args[@]}" "${flags[@]}"
  args+=("${flags[@]}" --print "$prompt")
  ( cd "$cwd" && agy "${args[@]}" </dev/null ) > "$dir/events.jsonl" 2> "$dir/stderr.txt"
  code=$?
  if [ -e "$dir/cancel" ]; then return $code; fi
  python3 - "$dir/events.jsonl" "$dir/last.txt" <<'PY' 2>/dev/null
import json, sys
last = None
try:
    for line in open(sys.argv[1]):
        try:
            o = json.loads(line)
        except Exception:
            continue
        if isinstance(o, dict) and o.get('event') == 'result':
            r = o.get('result')
            if isinstance(r, dict) and isinstance(r.get('response'), str):
                last = r['response']
except Exception:
    pass
if last is not None:
    open(sys.argv[2], 'w').write(last)
PY
  return $code
}

run_claude() {
  read_prompt
  : > "$dir/last.txt"
  args=(-p --output-format stream-json --verbose)
  [ -n "$resume" ] && args=(-p --resume "$resume" --output-format stream-json --verbose)
  [ -n "$model" ] && args+=(--model "$model")
  [ -n "$resume" ] && log_resume '-- <prompt.txt>' claude "${args[@]}" "${flags[@]}"
  args+=("${flags[@]}" -- "$prompt")
  ( cd "$cwd" && claude "${args[@]}" </dev/null ) > "$dir/events.jsonl" 2> "$dir/stderr.txt"
  code=$?
  if [ -e "$dir/cancel" ]; then return $code; fi
  python3 - "$dir/events.jsonl" "$dir/last.txt" <<'PY' 2>/dev/null
import json, sys
last = None
try:
    for line in open(sys.argv[1]):
        try:
            o = json.loads(line)
        except Exception:
            continue
        if isinstance(o, dict) and o.get('type') == 'result' and isinstance(o.get('result'), str):
            last = o['result']
except Exception:
    pass
if last is not None:
    open(sys.argv[2], 'w').write(last)
PY
  return $code
}

case "$runner" in
  codex) run_cli() { run_codex; } ;;
  opencode) run_cli() { run_opencode; } ;;
  agy) run_cli() { run_agy; } ;;
  claude) run_cli() { run_claude; } ;;
  *) echo "orq: unknown runner $runner" > "$dir/stderr.txt"; write_exit 3; exit 0 ;;
esac

run_cli > /dev/null 2>&1 &
child=$!

(
  while kill -0 "$child" 2>/dev/null; do
    if [ -e "$dir/cancel" ]; then
      interrupt_cli
      kill -0 "$child" 2>/dev/null || exit 0
      kill -TERM -$$ 2>/dev/null
      sleep 5
      sweep_job
      if [ ! -e "$dir/exit" ]; then write_exit 124; fi
      kill -KILL -$$ 2>/dev/null
      exit 0
    fi
    sleep 2
  done
) &
watcher=$!

# The watcher's sweep can kill run_cli, and bash would print that into child.log.
wait "$child" 2>/dev/null
code=$?
# The watcher goes before the sweep: its sleep and its own sweep carry the marker, so each sweep would end the
# other's helpers.
stop_watcher
sweep_job
if [ -e "$dir/cancel" ]; then
  # The KILL takes the supervisor too, so exit comes first.
  write_exit 124
  kill -KILL -$$ 2>/dev/null
elif [ ! -e "$dir/exit" ]; then
  write_session
  write_exit "$code"
fi
exit 0
