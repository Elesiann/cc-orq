#!/usr/bin/env bash
# Shared helpers for the live harness under tests/live.
#
# A scenario sources this file, calls `live_setup`, drives nested Claude Code
# sessions through `live_run_headless` and the tmux helpers, and lets the EXIT
# trap in `live_setup` clean up the temporary repository and every process the
# run started. Nothing here touches sessions, directories or processes that the
# current run did not create.
#
# Environment:
#   PLUGIN_DIR                    plugin directory passed to --plugin-dir (default: repository root)
#   CLAUDE_BIN                    claude executable (default: claude from PATH)
#   ORQ_LIVE_MODEL                model alias for the nested session (default: haiku)
#   ORQ_CLAUDE_MD_EXCLUDE_FILES   space-separated CLAUDE.md files to exclude (default: $HOME/.claude/CLAUDE.md $HOME/.claude/RTK.md)
#   ORQ_EVIDENCE                  receipt directory of the current scenario (set by run.sh)
#   ORQ_LIVE_TMUX_PREFIX          prefix for tmux session names (default: orq-live)
#   LIVE_MODS                     on|off, whether the plugin's function-hook mod runs (default: off)
#   LIVE_REPO                     temporary git repository (set by live_setup, exported for headless.sh)

LIVE_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIVE_ROOT=$(cd "$LIVE_LIB_DIR/../.." && pwd)

PLUGIN_DIR=${PLUGIN_DIR:-$LIVE_ROOT}
CLAUDE_BIN=${CLAUDE_BIN:-claude}
ORQ_LIVE_MODEL=${ORQ_LIVE_MODEL:-haiku}
ORQ_CLAUDE_MD_EXCLUDE_FILES=${ORQ_CLAUDE_MD_EXCLUDE_FILES:-"$HOME/.claude/CLAUDE.md $HOME/.claude/RTK.md"}
ORQ_LIVE_TMUX_PREFIX=${ORQ_LIVE_TMUX_PREFIX:-orq-live}
LIVE_MODS=${LIVE_MODS:-off}

LIVE_WORK=
LIVE_REPO=
LIVE_TMUX_SESSION=

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

# Print the excluded memory files as a JSON array.
live_excludes_json() {
  local file
  for file in $ORQ_CLAUDE_MD_EXCLUDE_FILES; do
    printf '%s\n' "$file"
  done | jq -R . | jq -s -c .
}

# Print the --settings JSON for mods on or off.
live_settings() {
  local mods=$1 excludes
  excludes=$(live_excludes_json)
  if [ "$mods" = "on" ]; then
    jq -c -n --argjson excludes "$excludes" '{claudeMdExcludes: $excludes}'
  else
    jq -c -n --argjson excludes "$excludes" '{disableAllHooks: true, claudeMdExcludes: $excludes}'
  fi
}

# Fill LIVE_CLAUDE_CMD with the common part of every nested session command.
live_build_claude_cmd() {
  local mods=$1 debug_file=$2
  LIVE_CLAUDE_CMD=(
    "$CLAUDE_BIN"
    --plugin-dir "$PLUGIN_DIR"
    --setting-sources project
    --settings "$(live_settings "$mods")"
    --model "$ORQ_LIVE_MODEL"
    --debug-file "$debug_file"
  )
}

live_require_tools() {
  local bin
  for bin in jq git tmux; do
    command -v "$bin" >/dev/null 2>&1 || live_fail "$bin is required by the live harness"
  done
  command -v "$CLAUDE_BIN" >/dev/null 2>&1 || live_fail "$CLAUDE_BIN is not on PATH"
  [ -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ] || live_fail "$PLUGIN_DIR does not hold a Claude Code plugin"
}

# Create a fresh git repository with one commit and make it the session cwd.
live_new_repo() {
  LIVE_WORK=$(mktemp -d "${TMPDIR:-/tmp}/cc-orq-live.XXXXXX")
  LIVE_REPO=$LIVE_WORK/repo
  mkdir -p "$LIVE_REPO"
  git -C "$LIVE_REPO" init -q
  git -C "$LIVE_REPO" config user.name "cc-orq live harness"
  git -C "$LIVE_REPO" config user.email "live-harness@example.invalid"
  printf 'Scratch repository for the cc-orq live harness.\n' > "$LIVE_REPO/README.md"
  git -C "$LIVE_REPO" add README.md
  git -C "$LIVE_REPO" commit -q -m "scratch: initial commit"
  export LIVE_REPO
  export LIVE_WORK
}

# Prepare a run and arrange cleanup. Scenarios call this first.
live_setup() {
  [ -n "${ORQ_EVIDENCE:-}" ] || live_fail "ORQ_EVIDENCE is not set; run the scenario through tests/live/run.sh"
  mkdir -p "$ORQ_EVIDENCE"
  trap live_cleanup EXIT
  live_require_tools
  live_new_repo
  git -C "$LIVE_REPO" rev-parse --verify HEAD >/dev/null 2>&1 || live_fail "temporary repository has no commit"
}

# Stop the tmux session this run started, reap processes whose cwd is the
# temporary repository, and remove that repository.
live_cleanup() {
  trap - EXIT
  if [ -n "$LIVE_TMUX_SESSION" ]; then
    tmux kill-session -t "$LIVE_TMUX_SESSION" 2>/dev/null || true
    LIVE_TMUX_SESSION=
  fi
  if [ -n "$LIVE_WORK" ]; then
    local pid cwd
    for pid in $(pgrep -f 'claude|server/main' 2>/dev/null || true); do
      cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
      case "$cwd" in
        "$LIVE_WORK"/*) kill "$pid" 2>/dev/null || true ;;
      esac
    done
    case "$LIVE_WORK" in
      '' | '/' | "$HOME") ;;
      *) rm -rf -- "$LIVE_WORK" ;;
    esac
    LIVE_WORK=
    LIVE_REPO=
  fi
}

# Record a failure for run.sh to print and exit the scenario.
live_fail() {
  local reason=$1
  if [ -n "${ORQ_EVIDENCE:-}" ]; then
    printf '%s\n' "$reason" > "$ORQ_EVIDENCE/failure.txt"
  fi
  printf '%s\n' "$reason" >&2
  exit 1
}

live_require_file() {
  [ -s "$1" ] || live_fail "missing or empty receipt: $1"
}

# Run one headless prompt and keep the raw stream. Arguments:
#   prompt_file out_dir mods debug_file [allowed_tool...]
live_run_headless() {
  local prompt=$1 out=$2 mods=$3 debug_file=$4
  shift 4
  mkdir -p "$out"
  [ -f "$prompt" ] || live_fail "prompt file not found: $prompt"
  live_build_claude_cmd "$mods" "$debug_file"
  LIVE_CLAUDE_CMD+=(-p --output-format stream-json --verbose)
  if [ "$#" -gt 0 ]; then
    LIVE_CLAUDE_CMD+=(--allowedTools "$@")
  fi
  ( cd "$LIVE_REPO" && "${LIVE_CLAUDE_CMD[@]}" < "$prompt" > "$out/stream.jsonl" 2> "$out/stderr.txt" )
}

# Start a nested interactive session in its own tmux session.
# Arguments: session_name mods debug_file [allowed_tool...]
live_tmux_start() {
  local session=$1 mods=$2 debug_file=$3 cmdline
  shift 3
  live_build_claude_cmd "$mods" "$debug_file"
  if [ "$#" -gt 0 ]; then
    LIVE_CLAUDE_CMD+=(--allowedTools "$@")
  fi
  printf -v cmdline '%q ' "${LIVE_CLAUDE_CMD[@]}"
  LIVE_TMUX_SESSION=$session
  tmux new-session -d -s "$session" -x 160 -y 50 -c "$LIVE_REPO" "$cmdline" ||
    live_fail "could not start tmux session $session"
}

# Wait until the pane matches an extended regular expression.
# Arguments: session_name pattern timeout_seconds
live_tmux_wait() {
  local session=$1 pattern=$2 timeout=$3 waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if tmux capture-pane -p -S -200 -t "$session" 2>/dev/null | grep -qE "$pattern"; then
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  return 1
}

# Pass the workspace trust dialog: wait for the options, move the selection to
# "Yes, I trust this folder" if needed, and confirm.
live_tmux_accept_trust() {
  local session=$1 pane
  live_tmux_wait "$session" 'Yes, I trust this folder' 120 || return 1
  sleep 0.5
  for _ in 1 2 3; do
    pane=$(tmux capture-pane -p -S -200 -t "$session" 2>/dev/null || true)
    if printf '%s\n' "$pane" | grep -qE '❯.*Yes, I trust this folder'; then
      tmux send-keys -t "$session" Enter
      return 0
    fi
    if printf '%s\n' "$pane" | grep -qE '❯.*No, exit'; then
      tmux send-keys -t "$session" Down
      sleep 0.5
    fi
  done
  return 1
}

# Type text, wait, then press Enter in a separate call: an Enter sent with the
# text does not submit the prompt.
live_tmux_send() {
  local session=$1 text=$2
  tmux send-keys -t "$session" -l "$text"
  sleep 0.7
  tmux send-keys -t "$session" Enter
}

live_tmux_capture() {
  local session=$1 file=$2
  tmux capture-pane -p -S -400 -t "$session" > "$file" 2>/dev/null || true
}

# Leave the session with /exit and close it if it is still around.
live_tmux_exit() {
  local session=$1 waited=0
  if ! tmux has-session -t "$session" 2>/dev/null; then
    return 0
  fi
  tmux send-keys -t "$session" -l '/exit'
  sleep 0.7
  tmux send-keys -t "$session" Enter
  while [ "$waited" -lt 20 ]; do
    if ! tmux has-session -t "$session" 2>/dev/null; then
      LIVE_TMUX_SESSION=
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  tmux kill-session -t "$session" 2>/dev/null || true
  LIVE_TMUX_SESSION=
}

# True when the debug log shows the plugin's MCP server connected over stdio.
live_debug_connected() {
  grep -qF "MCP server \"$LIVE_SERVER_NAME\": Successfully connected (transport: stdio)" "$1"
}

# True when the debug log shows a call of one of the plugin's MCP tools.
live_debug_tool_called() {
  grep -qF "MCP server \"$LIVE_SERVER_NAME\": Calling MCP tool: $2" "$1"
}

# Copy the server's stderr into the receipt folder when the debug log names a
# file for it. Current Claude Code writes no such line; the helper stays so a
# later version that does keeps its stderr for the report.
live_copy_server_stderr() {
  local debug_file=$1 out=$2 line path
  line=$(grep -iE "$LIVE_SERVER_NAME.*stderr|stderr.*$LIVE_SERVER_NAME" "$debug_file" 2>/dev/null | head -1 || true)
  [ -n "$line" ] || return 0
  path=$(printf '%s\n' "$line" | grep -oE '/[^"[:space:]]+\.(log|txt|err)' | tail -1 || true)
  if [ -n "$path" ] && [ -f "$path" ]; then
    cp "$path" "$out/server-stderr.txt"
  fi
}
