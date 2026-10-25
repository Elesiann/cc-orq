#!/usr/bin/env bash
# Shared helpers for the live harness under tests/live.
#
# A scenario sources this file, calls `live_setup`, drives nested Claude Code sessions through
# `live_run_headless` and the tmux helpers, and lets the EXIT trap that `live_setup` installs clean up. Cleanup
# touches only what the run started: the tmux session it created, on a tmux server of its own, the processes
# whose working directory is its scratch directory, and that directory. The harness never writes under ~/.claude
# and never talks to the user's default tmux server.
#
# Environment:
#   PLUGIN_DIR                   plugin directory passed to --plugin-dir (default: repository root)
#   CLAUDE_BIN                   claude executable (default: claude from PATH)
#   ORQ_LIVE_MODEL               model alias of the nested session (default: haiku)
#   ORQ_LIVE_PERMISSION_MODE     --permission-mode of the nested session (default: manual, the mode that asks;
#                                auto is refused)
#   ORQ_CLAUDE_MD_EXCLUDE_FILES  CLAUDE.md files to keep out of the nested session, one path per line
#                                (default: $HOME/.claude/CLAUDE.md)
#   ORQ_LIVE_SCRATCH_DIR         private directory for scratch repositories, run state and tmux sockets, without ".."
#                                in its path (default: $XDG_RUNTIME_DIR/cc-orq-live, else $HOME/.cache/cc-orq-live).
#                                A new one gets mode 700; an existing one must already be closed to group and others
#   ORQ_LIVE_TMUX_PREFIX         prefix of tmux session names (default: orq-live)
#   ORQ_EVIDENCE, ORQ_SCENARIO   receipt directory and name of the scenario (set by run.sh)
#   LIVE_REPO, LIVE_WORK         scratch repository and its directory (set by live_acquire and exported, so
#                                headless.sh runs in the same repository)

LIVE_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIVE_ROOT=$(cd "$LIVE_LIB_DIR/../.." && pwd)

# The nested session runs in another directory, so a path it receives must not depend on where the caller stood.
live_abs() {
  case $1 in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$PWD" "${1#./}" ;;
  esac
}

live_abs_dir() {
  if [ -d "$1" ]; then
    (cd "$1" && pwd)
  else
    live_abs "$1"
  fi
}

live_strip_slashes() {
  local path=$1
  while [ "${#path}" -gt 1 ] && [ "${path%/}" != "$path" ]; do path=${path%/}; done
  printf '%s\n' "$path"
}

live_resolve_bin() {
  local found
  case $1 in
    */*) live_abs "$1" ;;
    *)
      found=$(command -v "$1" 2> /dev/null || true)
      case $found in /*) printf '%s\n' "$found" ;; *) printf '%s\n' "$1" ;; esac
      ;;
  esac
}

live_default_scratch_root() {
  local runtime
  runtime=$(live_strip_slashes "${XDG_RUNTIME_DIR:-}")
  if [ -n "$runtime" ] && [ -d "$runtime" ] && [ -O "$runtime" ]; then
    printf '%s/cc-orq-live\n' "$runtime"
  else
    printf '%s/.cache/cc-orq-live\n' "${HOME:-}"
  fi
}

PLUGIN_DIR=$(live_abs_dir "${PLUGIN_DIR:-$LIVE_ROOT}")
CLAUDE_BIN=$(live_resolve_bin "${CLAUDE_BIN:-claude}")
ORQ_LIVE_MODEL=${ORQ_LIVE_MODEL:-haiku}
ORQ_LIVE_PERMISSION_MODE=${ORQ_LIVE_PERMISSION_MODE:-manual}
ORQ_CLAUDE_MD_EXCLUDE_FILES=${ORQ_CLAUDE_MD_EXCLUDE_FILES:-$HOME/.claude/CLAUDE.md}
ORQ_LIVE_SCRATCH_DIR=$(live_strip_slashes "$(live_abs "${ORQ_LIVE_SCRATCH_DIR:-$(live_default_scratch_root)}")")
ORQ_LIVE_TMUX_PREFIX=${ORQ_LIVE_TMUX_PREFIX:-orq-live}

LIVE_WORK=${LIVE_WORK:-}
LIVE_REPO=${LIVE_REPO:-}
LIVE_STATE=
LIVE_OWNER=
LIVE_TMUX_SESSION=
LIVE_TMUX_SOCKET=
LIVE_SCRATCH_ERROR=

# The longest path a unix socket takes is 107 bytes. The harness leaves room, and fails a run that cannot make
# its socket path instead of falling back to another tmux server.
LIVE_SOCKET_MAX=100

# The server name Claude Code gives the plugin's stdio MCP server.
LIVE_SERVER_NAME='plugin:cc-orq:orq'
# shellcheck disable=SC2034 # scenarios read this array after sourcing the library
LIVE_SERVER_TOOLS=(
  mcp__plugin_cc-orq_orq__capabilities
  mcp__plugin_cc-orq_orq__list
  mcp__plugin_cc-orq_orq__status
  mcp__plugin_cc-orq_orq__cancel
  mcp__plugin_cc-orq_orq__integrate
)
# What the status line of an interactive session shows once it takes input, whatever the permission mode.
# shellcheck disable=SC2034 # scenarios read this after sourcing the library
LIVE_TUI_READY='mode on|\? for shortcuts'
# The option of the dialog that asks to trust the working directory. A directory trusted before shows no dialog.
LIVE_TUI_TRUST='Yes, I trust this folder'

# Record a failure for run.sh to print and exit the scenario.
live_fail() {
  local reason=$1
  if [ -n "${ORQ_EVIDENCE:-}" ]; then
    printf '%s\n' "$reason" > "$ORQ_EVIDENCE/failure.txt"
  fi
  printf '%s\n' "$reason" >&2
  exit 1
}

live_log() {
  printf 'live harness: %s\n' "$*" >&2
}

live_exclude_files() {
  printf '%s\n' "$ORQ_CLAUDE_MD_EXCLUDE_FILES" | sed '/^$/d'
}

live_excludes_json() {
  live_exclude_files | jq -R -n -c '[inputs]'
}

# Both branches keep the account's claude.ai connectors out: they reach Gmail, Supabase and other services that
# a test run has no business calling.
live_settings() {
  local mods=$1 excludes
  excludes=$(live_excludes_json)
  if [ "$mods" = "on" ]; then
    jq -c -n --argjson excludes "$excludes" '{disableClaudeAiConnectors: true, claudeMdExcludes: $excludes}'
  else
    jq -c -n --argjson excludes "$excludes" \
      '{disableAllHooks: true, disableClaudeAiConnectors: true, claudeMdExcludes: $excludes}'
  fi
}

live_check_permission_mode() {
  case $ORQ_LIVE_PERMISSION_MODE in
    auto) live_fail "ORQ_LIVE_PERMISSION_MODE=auto is refused: a nested session in auto mode approves tool calls without asking" ;;
  esac
}

# Claude Code reports the mode that asks, which --permission-mode names manual, as default.
live_expected_init_mode() {
  case $ORQ_LIVE_PERMISSION_MODE in
    manual) printf 'default\n' ;;
    *) printf '%s\n' "$ORQ_LIVE_PERMISSION_MODE" ;;
  esac
}

# The status line text that shows the pinned mode, for the modes whose text was observed.
live_mode_footer() {
  case $ORQ_LIVE_PERMISSION_MODE in
    manual) printf 'manual mode on\n' ;;
  esac
}

# Fill LIVE_CLAUDE_CMD with the common part of every nested session command.
live_build_claude_cmd() {
  local mods=$1 debug_file=$2
  live_check_permission_mode
  LIVE_CLAUDE_CMD=(
    "$CLAUDE_BIN"
    --plugin-dir "$PLUGIN_DIR"
    --setting-sources project
    --settings "$(live_settings "$mods")"
    --permission-mode "$ORQ_LIVE_PERMISSION_MODE"
    --model "$ORQ_LIVE_MODEL"
    --debug-file "$debug_file"
  )
}

live_require_tools() {
  local bin
  for bin in jq git tmux timeout find; do
    command -v "$bin" > /dev/null 2>&1 || live_fail "$bin is required by the live harness"
  done
  command -v "$CLAUDE_BIN" > /dev/null 2>&1 || live_fail "$CLAUDE_BIN is not on PATH"
  [ -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ] || live_fail "$PLUGIN_DIR does not hold a Claude Code plugin"
}

# Print the start time of a live process (field 22 of /proc/PID/stat), and fail when it is gone or a zombie.
# The start time tells a process from a later one that got the same pid.
live_proc_start() {
  local stat fields
  stat=$(cat "/proc/$1/stat" 2> /dev/null) || return 1
  read -r -a fields <<< "${stat##*) }"
  [ "${fields[0]:-Z}" != Z ] || return 1
  printf '%s\n' "${fields[19]}"
}

live_pid_alive() {
  live_proc_start "$1" > /dev/null
}

live_inside_scratch() {
  case $1 in
    *..*) return 1 ;;
    "$ORQ_LIVE_SCRATCH_DIR"/?*) return 0 ;;
  esac
  return 1
}

# A scenario name goes into a path and into the name of a state file, so it is a plain word: letters, digits, dots,
# dashes and underscores, with no leading dot and no "..".
live_valid_scenario_name() {
  case $1 in
    '' | *[!A-Za-z0-9._-]* | .* | *..*) return 1 ;;
  esac
}

live_pids_under() {
  local pattern
  live_inside_scratch "$1" || return 0
  pattern=$(printf '%s' "$1" | sed 's/[][*?\\]/\\&/g')
  find /proc -maxdepth 2 -name cwd \( -lname "$pattern" -o -lname "$pattern/*" \) 2> /dev/null |
    sed -n 's|^/proc/\([0-9][0-9]*\)/cwd$|\1|p' |
    grep -vx -e "$$" -e "$BASHPID" || true
}

live_kill_pids() {
  local pid alive waited=0
  [ "$#" -gt 0 ] || return 0
  kill "$@" 2> /dev/null || true
  while [ "$waited" -lt 15 ]; do
    alive=0
    for pid in "$@"; do
      if live_pid_alive "$pid"; then alive=1; fi
    done
    [ "$alive" -eq 0 ] && return 0
    sleep 0.2
    waited=$((waited + 1))
  done
  for pid in "$@"; do
    if live_pid_alive "$pid"; then kill -9 "$pid" 2> /dev/null || true; fi
  done
}

live_kill_in() {
  local pids
  pids=$(live_pids_under "$1")
  # shellcheck disable=SC2086 # one word per pid
  [ -z "$pids" ] || live_kill_pids $pids
}

# The directory holds run state, repositories and tmux sockets, so it must be private: no predictable path in a
# shared directory. A directory that does not exist is created with mode 700. One that exists is never changed:
# it must be yours, not a symlink, and closed to group and others already. A ".." in the path is refused because
# live_inside_scratch rejects every path with one, which would turn each kill and removal into a silent no-op.
# Sets LIVE_SCRATCH_ERROR and fails otherwise.
live_prepare_scratch_root() {
  local root=$ORQ_LIVE_SCRATCH_DIR mode
  case $root in
    /?*) ;;
    *)
      LIVE_SCRATCH_ERROR="the scratch directory '$root' is not an absolute path"
      return 1
      ;;
  esac
  case $root in
    *..*)
      LIVE_SCRATCH_ERROR="the scratch directory '$root' contains '..': give a path without it, or no kill or removal would run in it"
      return 1
      ;;
  esac
  if [ -L "$root" ]; then
    LIVE_SCRATCH_ERROR="the scratch directory $root is a symlink"
    return 1
  fi
  if [ ! -e "$root" ]; then
    mkdir -p -- "$(dirname -- "$root")" 2> /dev/null
    if ! mkdir -m 700 -- "$root" 2> /dev/null && [ ! -d "$root" ]; then
      LIVE_SCRATCH_ERROR="cannot create the scratch directory $root"
      return 1
    fi
  fi
  if [ -L "$root" ] || [ ! -d "$root" ] || [ ! -O "$root" ]; then
    LIVE_SCRATCH_ERROR="the scratch directory $root is not a directory owned by you"
    return 1
  fi
  if ! mode=$(find "$root" -maxdepth 0 -perm /077 -printf '%m' 2> /dev/null); then
    LIVE_SCRATCH_ERROR="cannot read the mode of the scratch directory $root"
    return 1
  fi
  if [ -n "$mode" ]; then
    LIVE_SCRATCH_ERROR="the scratch directory $root has mode $mode, open to group or others, and the harness does not change a directory it did not create: run chmod 700 on it, or set ORQ_LIVE_SCRATCH_DIR to a new path"
    return 1
  fi
}

# The path is the same on every run, so Claude Code keeps one per-directory entry under ~/.claude instead of one
# per run, and another checkout gets another path, so two checkouts never share one.
live_scratch_path() {
  printf '%s/%s-%s\n' "$ORQ_LIVE_SCRATCH_DIR" "$1" "$(printf '%s' "$PLUGIN_DIR" | cksum | cut -d' ' -f1)"
}

live_remove_work() {
  if live_inside_scratch "$1"; then rm -rf -- "$1"; fi
}

live_state_get() {
  sed -n "s/^$2=//p" "$1" 2> /dev/null | head -1
}

# The state file holds the owner's pid and start time, the scratch directory and the tmux session, which a later
# run needs to clean up after a run that died without its trap. Its existence is also the lock of the scenario.
live_state_write() {
  [ -n "$LIVE_STATE" ] || return 0
  printf 'pid=%s\nstart=%s\nwork=%s\ntmux=%s\n' "$$" "$(live_proc_start "$$")" "$LIVE_WORK" "$LIVE_TMUX_SESSION" \
    > "$LIVE_STATE.tmp.$$" && mv -f "$LIVE_STATE.tmp.$$" "$LIVE_STATE"
}

# Create the state file with all of its content, or fail when it exists: ln does not replace.
live_state_claim() {
  local state=$1 work=$2 tmp=$1.claim.$$
  printf 'pid=%s\nstart=%s\nwork=%s\ntmux=\n' "$$" "$(live_proc_start "$$")" "$work" > "$tmp" || return 1
  if ln "$tmp" "$state" 2> /dev/null; then
    rm -f "$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

live_state_owner_alive() {
  local pid start
  pid=$(live_state_get "$1" pid)
  start=$(live_state_get "$1" start)
  [ -n "$pid" ] && [ -n "$start" ] && [ "$(live_proc_start "$pid" 2> /dev/null)" = "$start" ]
}

# Prints why and fails unless the state file is one this harness wrote: a stale or forged file must not make a
# run kill, remove or close anything outside its own scratch directory.
live_state_check() {
  local state=$1 rest pid start work session name_re='^[A-Za-z0-9._-]+-[0-9]+\.state$' word_re='^[A-Za-z0-9._-]+$'
  case $state in
    "$ORQ_LIVE_SCRATCH_DIR"/?*) rest=${state#"$ORQ_LIVE_SCRATCH_DIR"/} ;;
    *)
      printf 'it is not inside %s' "$ORQ_LIVE_SCRATCH_DIR"
      return 1
      ;;
  esac
  case $rest in
    */* | .* | *..*)
      printf 'it is not directly inside %s under a plain name' "$ORQ_LIVE_SCRATCH_DIR"
      return 1
      ;;
  esac
  if ! [[ $rest =~ $name_re ]]; then
    printf 'its name is not SCENARIO-N.state'
    return 1
  fi
  if [ -L "$state" ] || [ ! -f "$state" ] || [ ! -O "$state" ]; then
    printf 'it is not a regular file of yours'
    return 1
  fi
  pid=$(live_state_get "$state" pid)
  start=$(live_state_get "$state" start)
  if ! [[ $pid =~ ^[0-9]+$ ]] || ! [[ $start =~ ^[0-9]+$ ]]; then
    printf 'it does not hold the pid and start time of its owner'
    return 1
  fi
  work=$(live_state_get "$state" work)
  if [ "$work" != "${state%.state}" ]; then
    printf 'it names the directory %s, not the scratch directory its own name stands for' "$work"
    return 1
  fi
  if [ -L "$work" ]; then
    printf 'its scratch directory is a symlink'
    return 1
  fi
  session=$(live_state_get "$state" tmux)
  if [ -n "$session" ]; then
    case $session in
      "$ORQ_LIVE_TMUX_PREFIX"*) ;;
      *)
        printf 'it names the tmux session %s, which does not start with %s' "$session" "$ORQ_LIVE_TMUX_PREFIX"
        return 1
        ;;
    esac
    if ! [[ $session =~ $word_re ]]; then
      printf 'it names a tmux session with unusual characters'
      return 1
    fi
  fi
  return 0
}

live_reap_state() {
  local state=$1 reason work session
  if ! reason=$(live_state_check "$state"); then
    live_log "ignoring the state file $state: $reason"
    return 1
  fi
  work=$(live_state_get "$state" work)
  session=$(live_state_get "$state" tmux)
  if [ -n "$session" ]; then live_tmux_kill "$session" "$work/tmux.sock"; fi
  live_kill_in "$work"
  live_remove_work "$work"
  rm -f -- "$state"
}

# Reap every run whose owner no longer exists, as after a SIGKILL when the machine ran out of memory.
live_reap_stale() {
  local state reason
  if ! live_prepare_scratch_root; then
    live_log "$LIVE_SCRATCH_ERROR"
    return 1
  fi
  for state in "$ORQ_LIVE_SCRATCH_DIR"/*.state; do
    [ -e "$state" ] || [ -L "$state" ] || continue
    if ! reason=$(live_state_check "$state"); then
      live_log "ignoring the state file $state: $reason"
      continue
    fi
    if live_state_owner_alive "$state"; then continue; fi
    live_log "reaping the leftovers of a run that died: $state"
    live_reap_state "$state" || true
  done
}

# The user's global git configuration may sign every commit or run hooks, so the harness ignores it, and the
# repository carries the same two settings for the git calls of the nested session.
live_git() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$LIVE_REPO" "$@"
}

live_acquire() {
  local name=$1 work state
  live_valid_scenario_name "$name" ||
    live_fail "invalid scenario name '$name': use letters, digits, dots, dashes and underscores, with no leading dot and no '..'"
  live_prepare_scratch_root || live_fail "$LIVE_SCRATCH_ERROR"
  work=$(live_scratch_path "$name")
  live_inside_scratch "$work" || live_fail "the work directory $work is not inside the scratch directory $ORQ_LIVE_SCRATCH_DIR"
  state=$work.state
  if [ "$((${#work} + 10))" -gt "$LIVE_SOCKET_MAX" ]; then
    live_fail "the tmux socket path $work/tmux.sock is $((${#work} + 10)) bytes, over the $LIVE_SOCKET_MAX a unix socket allows: set ORQ_LIVE_SCRATCH_DIR to a shorter directory"
  fi
  if ! live_state_claim "$state" "$work"; then
    if live_state_owner_alive "$state"; then
      live_fail "another live run of $name from this checkout is active ($state)"
    fi
    live_reap_state "$state" || live_fail "the run state $state is not one this harness wrote: remove it and run again"
    live_state_claim "$state" "$work" || live_fail "cannot take the run state $state"
  fi
  LIVE_OWNER=$$
  LIVE_STATE=$state
  LIVE_WORK=$work
  LIVE_REPO=$work/repo
  LIVE_TMUX_SOCKET=$work/tmux.sock
  live_remove_work "$LIVE_WORK"
  mkdir -p "$LIVE_REPO"
  live_git init -q
  live_git config user.name "cc-orq live harness"
  live_git config user.email "live-harness@example.invalid"
  live_git config commit.gpgsign false
  live_git config core.hooksPath /dev/null
  printf 'Scratch repository for the cc-orq live harness.\n' > "$LIVE_REPO/README.md"
  live_git add README.md
  live_git commit -q -m "scratch: initial commit"
  export LIVE_REPO LIVE_WORK
}

# Prepare a run and arrange cleanup. Scenarios call this first.
live_setup() {
  [ -n "${ORQ_EVIDENCE:-}" ] || live_fail "ORQ_EVIDENCE is not set; run the scenario through tests/live/run.sh"
  [ -n "${ORQ_SCENARIO:-}" ] || live_fail "ORQ_SCENARIO is not set; run the scenario through tests/live/run.sh"
  mkdir -p "$ORQ_EVIDENCE"
  trap live_cleanup EXIT
  live_require_tools
  live_acquire "$ORQ_SCENARIO"
  live_git rev-parse --verify HEAD > /dev/null 2>&1 || live_fail "temporary repository has no commit"
}

# The tmux server of the run exits with its last session, so cleanup closes the session and never the server.
live_cleanup() {
  trap - EXIT
  if [ -n "$LIVE_TMUX_SESSION" ]; then
    live_tmux_kill "$LIVE_TMUX_SESSION"
    LIVE_TMUX_SESSION=
  fi
  if [ -n "$LIVE_OWNER" ] && [ "$LIVE_OWNER" = "$$" ] && [ -n "$LIVE_WORK" ]; then
    live_kill_in "$LIVE_WORK"
    live_remove_work "$LIVE_WORK"
    if [ -n "$LIVE_STATE" ]; then rm -f -- "$LIVE_STATE"; fi
    LIVE_WORK=
    LIVE_REPO=
    LIVE_STATE=
    LIVE_TMUX_SOCKET=
    LIVE_OWNER=
  fi
  return 0
}

live_require_file() {
  [ -s "$1" ] || live_fail "missing or empty receipt: $1"
}

# Run one headless prompt and keep the raw stream. Arguments:
#   prompt_file out_dir mods debug_file [allowed_tool...]
live_run_headless() {
  local prompt out mods=$3 debug_file
  prompt=$(live_abs "$1")
  out=$(live_abs "$2")
  debug_file=$(live_abs "$4")
  shift 4
  [ -n "$LIVE_REPO" ] || live_fail "no scratch repository: call live_setup first"
  mkdir -p "$out"
  [ -f "$prompt" ] || live_fail "prompt file not found: $prompt"
  live_build_claude_cmd "$mods" "$debug_file"
  LIVE_CLAUDE_CMD+=(-p --output-format stream-json --verbose)
  if [ "$#" -gt 0 ]; then
    LIVE_CLAUDE_CMD+=(--allowedTools "$@")
  fi
  (cd "$LIVE_REPO" && "${LIVE_CLAUDE_CMD[@]}" < "$prompt" > "$out/stream.jsonl" 2> "$out/stderr.txt")
}

# ---- interactive sessions in tmux ---------------------------------------------------------------------------
# live_tmux_on is the only place that runs tmux, always on the run's own socket: a tmux without -S, or with a
# socket directory it cannot use, talks to the user's default server. Targets are exact ("=name" for a session,
# "=name:" for its pane) because a bare name matches any session whose name starts with it.

# Arguments: socket tmux_arguments...
live_tmux_on() {
  local socket=$1
  shift
  case $socket in
    /?*) ;;
    *) return 125 ;;
  esac
  tmux -f /dev/null -S "$socket" "$@"
}

live_tmux() {
  live_tmux_on "$LIVE_TMUX_SOCKET" "$@"
}

live_tmux_has() {
  live_tmux has-session -t "=$1" 2> /dev/null
}

# Arguments: session_name [socket]
live_tmux_kill() {
  live_tmux_on "${2:-$LIVE_TMUX_SOCKET}" kill-session -t "=$1" 2> /dev/null || true
}

# Arguments: session_name mods debug_file [allowed_tool...]
live_tmux_start() {
  local session=$1 mods=$2 debug_file cmdline
  debug_file=$(live_abs "$3")
  shift 3
  [ -n "$LIVE_REPO" ] || live_fail "no scratch repository: call live_setup first"
  live_build_claude_cmd "$mods" "$debug_file"
  if [ "$#" -gt 0 ]; then
    LIVE_CLAUDE_CMD+=(--allowedTools "$@")
  fi
  printf -v cmdline '%q ' "${LIVE_CLAUDE_CMD[@]}"
  live_tmux new-session -d -s "$session" -x 160 -y 50 -c "$LIVE_REPO" "$cmdline" ||
    live_fail "could not start tmux session $session"
  LIVE_TMUX_SESSION=$session
  live_state_write
}

# Wait until the pane matches an extended regular expression, for up to timeout_seconds.
# Arguments: session_name pattern timeout_seconds
live_tmux_wait() {
  local session=$1 pattern=$2 polls=$(($3 * 2)) waited=0 pane
  while [ "$waited" -lt "$polls" ]; do
    pane=$(live_tmux capture-pane -p -S -200 -t "=$session:" 2> /dev/null || true)
    if grep -qE -e "$pattern" <<< "$pane"; then
      return 0
    fi
    live_tmux_has "$session" || return 1
    sleep 0.5
    waited=$((waited + 1))
  done
  return 1
}

# Pass the workspace trust dialog: wait for the options, move the selection to "Yes, I trust this folder" if
# needed, and confirm.
# Arguments: session_name [timeout_seconds]
live_tmux_accept_trust() {
  local session=$1 pane
  live_tmux_wait "$session" "$LIVE_TUI_TRUST" "${2:-30}" || return 1
  sleep 0.5
  for _ in 1 2 3; do
    pane=$(live_tmux capture-pane -p -S -200 -t "=$session:" 2> /dev/null || true)
    if grep -qE "❯.*$LIVE_TUI_TRUST" <<< "$pane"; then
      live_tmux send-keys -t "=$session:" Enter
      return 0
    fi
    if grep -qE '❯.*No, exit' <<< "$pane"; then
      live_tmux send-keys -t "=$session:" Down
      sleep 0.5
    fi
  done
  return 1
}

# Wait until the session takes input, passing the trust dialog if that comes first. One wait covers both screens:
# a fixed guess for the status line would send a slow start into the wait for a dialog that a trusted directory
# never draws.
# Arguments: session_name [timeout_seconds]
live_tmux_wait_ready() {
  local session=$1 pane
  live_tmux_wait "$session" "$LIVE_TUI_READY|$LIVE_TUI_TRUST" "${2:-40}" || return 1
  pane=$(live_tmux capture-pane -p -S -200 -t "=$session:" 2> /dev/null || true)
  if grep -qE -e "$LIVE_TUI_TRUST" <<< "$pane"; then
    live_tmux_accept_trust "$session" 5 || return 1
    live_tmux_wait "$session" "$LIVE_TUI_READY" 30 || return 1
  fi
}

# Type text, wait, then press Enter in a separate call: an Enter sent with the text does not submit the prompt.
live_tmux_send() {
  local session=$1 text=$2
  live_tmux send-keys -t "=$session:" -l "$text"
  sleep 0.7
  live_tmux send-keys -t "=$session:" Enter
}

live_tmux_capture() {
  local session=$1 file=$2
  live_tmux capture-pane -p -S -400 -t "=$session:" > "$file" 2> /dev/null || true
}

# Leave the run's own session with /exit and close it if it is still around. Any other session is left alone.
live_tmux_exit() {
  local session=$1 waited=0
  [ "$session" = "$LIVE_TMUX_SESSION" ] || return 0
  if live_tmux_has "$session"; then
    live_tmux send-keys -t "=$session:" -l '/exit'
    sleep 0.7
    live_tmux send-keys -t "=$session:" Enter
    while [ "$waited" -lt 40 ]; do
      live_tmux_has "$session" || break
      sleep 0.5
      waited=$((waited + 1))
    done
    live_tmux_kill "$session"
  fi
  LIVE_TMUX_SESSION=
  live_state_write
}

# True when the debug log shows the plugin's MCP server connected over stdio.
live_debug_connected() {
  grep -qF "MCP server \"$LIVE_SERVER_NAME\": Successfully connected (transport: stdio)" "$1"
}

# True when the debug log shows a call of one of the plugin's MCP tools.
live_debug_tool_called() {
  grep -qF "MCP server \"$LIVE_SERVER_NAME\": Calling MCP tool: $2" "$1"
}

# Assert on the init event of the headless stream in the receipt folder $1: the session runs in the pinned
# permission mode, no MCP server but the plugin's reached it (the account's claude.ai connectors least of all), and
# the plugin's five tools are there with the server connected. Writes init.json and init-tools.txt.
live_assert_init() {
  local ex=$1 init='select(.type == "system" and .subtype == "init")' tool found
  jq -e "$init" "$ex/stream.jsonl" > /dev/null || live_fail "no system/init event in stream.jsonl"
  jq -c "$init | {permissionMode, claude_code_version, mcp_servers: [.mcp_servers[]? | {name, status, source}], tools: (.tools | length)}" \
    "$ex/stream.jsonl" > "$ex/init.json"
  jq -r "$init | .tools[]" "$ex/stream.jsonl" > "$ex/init-tools.txt"

  found=$(jq -r "$init | first(.mcp_servers[]?.name | select(startswith(\"claude.ai\"))) // empty" "$ex/stream.jsonl")
  [ -z "$found" ] || live_fail "init event lists a claude.ai connector: $found"
  found=$(grep -m1 '^mcp__claude_ai_' "$ex/init-tools.txt" || true)
  [ -z "$found" ] || live_fail "init event lists a claude.ai connector tool: $found"
  found=$(jq -r "$init | first(.mcp_servers[]? | select(.source != \"plugin\") | .name + \" (source: \" + (.source // \"none\") + \")\") // empty" \
    "$ex/stream.jsonl")
  [ -z "$found" ] || live_fail "init event lists an MCP server that does not come from the plugin: $found"

  found=$(jq -r "$init | .permissionMode" "$ex/stream.jsonl")
  [ "$found" = "$(live_expected_init_mode)" ] ||
    live_fail "init event reports permission mode $found, expected $(live_expected_init_mode) for $ORQ_LIVE_PERMISSION_MODE"

  for tool in "${LIVE_SERVER_TOOLS[@]}"; do
    grep -qxF "$tool" "$ex/init-tools.txt" || live_fail "init event does not list $tool"
  done
  jq -e --arg name "$LIVE_SERVER_NAME" \
    "$init | .mcp_servers[] | select(.name == \$name and .status == \"connected\")" "$ex/stream.jsonl" > /dev/null ||
    live_fail "init event does not report $LIVE_SERVER_NAME connected"
}

# Arguments: receipt_dir tool jq_expression_for_the_shape
live_assert_tool_answer() {
  local ex=$1 tool=$2 shape=$3 id text error
  id=$(jq -r --arg name "$tool" '[.[] | select(.name == $name)][0].id // empty' "$ex/tool_uses.json")
  [ -n "$id" ] || live_fail "the model did not call $tool"
  error=$(jq -r --arg id "$id" '[.[] | select(.tool_use_id == $id)][0].is_error // false' "$ex/tool_results.json")
  text=$(jq -r --arg id "$id" \
    '[.[] | select(.tool_use_id == $id)][0] | [.content[]? | select(.type == "text") | .text] | join("")' \
    "$ex/tool_results.json")
  [ -n "$text" ] || live_fail "no raw result text for $tool"
  [ "$error" = false ] || live_fail "$tool answered with an error: $(printf '%s' "$text" | head -c 200)"
  printf '%s' "$text" | jq -e . > /dev/null 2>&1 || live_fail "raw result of $tool is not JSON"
  printf '%s' "$text" | jq -e "$shape" > /dev/null 2>&1 ||
    live_fail "raw result of $tool has not the documented shape: $(printf '%s' "$text" | head -c 200)"
}

live_assert_plugin_answers() {
  local ex=$1 expected actual
  jq -r '.[] | select(.name | startswith("mcp__plugin_cc-orq_orq__")) | .name' "$ex/tool_uses.json" \
    > "$ex/plugin-tool-uses.txt"
  expected=$(printf '%s\n%s\n' mcp__plugin_cc-orq_orq__capabilities mcp__plugin_cc-orq_orq__list)
  actual=$(head -2 "$ex/plugin-tool-uses.txt")
  [ "$actual" = "$expected" ] ||
    live_fail "expected plugin calls capabilities then list, got: $(tr '\n' ' ' < "$ex/plugin-tool-uses.txt")"
  live_assert_tool_answer "$ex" mcp__plugin_cc-orq_orq__capabilities '.providers | type == "array"'
  live_assert_tool_answer "$ex" mcp__plugin_cc-orq_orq__list '.jobs | type == "array"'
}

# Claude Code logs an InstructionsLoaded line for each memory file it loads, in a headless session too, so with the
# user's CLAUDE.md kept out the headless debug log has none. Arguments: headless_debug_log memory_lines_receipt
live_assert_no_instructions_loaded() {
  local log=$1 lines=$2
  { grep -F 'InstructionsLoaded' "$log" || true; } > "$lines"
  [ ! -s "$lines" ] || live_fail "headless debug log has an InstructionsLoaded line: a memory file may have loaded (see $lines)"
}

# Claude Code says that no memory file loaded only in an interactive session; the headless debug log has no such
# line. Arguments: interactive_debug_log memory_lines_receipt
live_assert_no_memory_loaded() {
  local log=$1 lines=$2 file
  { grep -E 'CLAUDE.md|rules files|InstructionsLoaded' "$log" || true; } > "$lines"
  grep -qF 'No CLAUDE.md/rules files found' "$log" ||
    live_fail "interactive debug log does not say that no CLAUDE.md or rules file loaded"
  while IFS= read -r file; do
    if grep -qF -- "$file" "$log"; then live_fail "interactive debug log names excluded memory file $file"; fi
  done < <(live_exclude_files)
}

live_assert_pane_mode() {
  local pane=$1 footer
  if grep -qF 'auto mode on' "$pane"; then live_fail "pane.txt shows the interactive session in auto mode"; fi
  footer=$(live_mode_footer)
  if [ -n "$footer" ] && ! grep -qF "$footer" "$pane"; then
    live_fail "pane.txt does not show the pinned mode ($footer)"
  fi
}
