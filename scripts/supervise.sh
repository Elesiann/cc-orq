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
# Files in <dir>: prompt.txt (input), pgid, events.jsonl (CLI stdout),
# stderr.txt, last.txt (final message), exit (numeric exit code).
#
# Started as the main process of a transient user unit (systemd makes it a
# session and group leader), or under setsid when no user manager is
# reachable, so $$ is the process-group leader. The watcher kills the whole
# group on cancel (SIGTERM, then SIGKILL after 5 s). If the launching session
# dies, nothing is killed: the job runs to completion on its own.
dir=$1; runner=$2; cwd=$3; model=${4:-}; effort=${5:-}; sandbox=${6:-}

echo $$ > "$dir/pgid"
trap '' TERM

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

run_codex() {
  args=(exec --json -o "$dir/last.txt")
  [ -n "$model" ] && args+=(-m "$model")
  [ -n "$effort" ] && args+=(-c "model_reasoning_effort=\"$effort\"")
  [ -n "$sandbox" ] && args+=(-s "$sandbox")
  args+=(-C "$cwd" --skip-git-repo-check "${flags[@]}" -)
  codex "${args[@]}" < "$dir/prompt.txt" > "$dir/events.jsonl" 2> "$dir/stderr.txt"
}

run_opencode() {
  read_prompt
  ( cd "$cwd" && opencode run --format json -m "$model" "${flags[@]}" -- "$prompt" ) > "$dir/events.jsonl" 2> "$dir/stderr.txt"
  code=$?
  if [ -e "$dir/cancel" ]; then write_exit 124; return $code; fi
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
  [ -n "$model" ] && args+=(--model "$model")
  args+=("${flags[@]}" --print "$prompt")
  ( cd "$cwd" && agy "${args[@]}" </dev/null ) > "$dir/events.jsonl" 2> "$dir/stderr.txt"
  code=$?
  if [ -e "$dir/cancel" ]; then write_exit 124; return $code; fi
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
  [ -n "$model" ] && args+=(--model "$model")
  args+=("${flags[@]}" -- "$prompt")
  ( cd "$cwd" && claude "${args[@]}" </dev/null ) > "$dir/events.jsonl" 2> "$dir/stderr.txt"
  code=$?
  if [ -e "$dir/cancel" ]; then write_exit 124; return $code; fi
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
      kill -TERM -$$ 2>/dev/null
      sleep 5
      if [ ! -e "$dir/exit" ]; then write_exit 124; fi
      kill -KILL -$$ 2>/dev/null
      exit 0
    fi
    sleep 2
  done
) &
watcher=$!

wait "$child"
code=$?
kill "$watcher" 2>/dev/null
if [ -e "$dir/cancel" ]; then write_exit 124; elif [ ! -e "$dir/exit" ]; then write_exit "$code"; fi
exit 0
