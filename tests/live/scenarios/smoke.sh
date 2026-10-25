#!/usr/bin/env bash
# smoke: the plugin's MCP server answers capabilities and list without mods, and
# one interactive tmux round calls list.
#
# Proves, with function-hook mods off:
#   - the init event lists exactly the five plugin MCP tools and no mod tool;
#   - the model calls capabilities then list, and both raw results parse as JSON;
#   - the debug log reports the server connected over stdio;
#   - neither excluded CLAUDE.md file loaded (no InstructionsLoaded dispatch and
#     no excluded path in the debug log);
#   - an interactive session passes the trust dialog, calls list and exits.
set -euo pipefail
# shellcheck source=../lib.sh disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

live_setup
EX=${ORQ_EVIDENCE:?}

CAP=mcp__plugin_cc-orq_orq__capabilities
LIST=mcp__plugin_cc-orq_orq__list

printf '%s\n' "$(live_settings off)" > "$EX/claude-settings.json"

cat > "$EX/prompt-headless.txt" <<'EOF'
Call the mcp__plugin_cc-orq_orq__capabilities tool, then call the mcp__plugin_cc-orq_orq__list tool. Do not call any other tool. Then answer with the single word DONE.
EOF
cat > "$EX/prompt-interactive.txt" <<EOF
Call the $LIST tool exactly once, then reply with DONE.
EOF

rc=0
LIVE_MODS=off LIVE_REPO=$LIVE_REPO LIVE_DEBUG=$EX/debug.log \
  bash "$LIVE_LIB_DIR/headless.sh" "$EX/prompt-headless.txt" "$EX" "$CAP" "$LIST" || rc=$?
if [ "$rc" -ne 0 ]; then
  live_fail "headless session exited $rc (see $EX/stderr.txt)"
fi

live_require_file "$EX/stream.jsonl"
live_require_file "$EX/tool_uses.json"
live_require_file "$EX/tool_results.json"

# 1. The init event names the five plugin tools and no mod tool.
if ! jq -e 'select(.type == "system" and .subtype == "init")' "$EX/stream.jsonl" >/dev/null; then
  live_fail "no system/init event in stream.jsonl"
fi
jq -r 'select(.type == "system" and .subtype == "init") | .tools[]' "$EX/stream.jsonl" > "$EX/init-tools.txt"
for tool in "${LIVE_SERVER_TOOLS[@]}"; do
  grep -qxF "$tool" "$EX/init-tools.txt" || live_fail "init event does not list $tool"
done
if grep -q '^mcp__cc-orq__' "$EX/init-tools.txt"; then
  live_fail "init event lists a mod tool with mods off: $(grep '^mcp__cc-orq__' "$EX/init-tools.txt" | head -1)"
fi
if ! jq -e --arg name "$LIVE_SERVER_NAME" \
  'select(.type == "system" and .subtype == "init") | .mcp_servers[] | select(.name == $name and .status == "connected")' \
  "$EX/stream.jsonl" >/dev/null; then
  live_fail "init event does not report $LIVE_SERVER_NAME connected"
fi

# 2. capabilities then list, and both raw results are JSON.
jq -r '.[] | select(.name | startswith("mcp__plugin_cc-orq_orq__")) | .name' \
  "$EX/tool_uses.json" > "$EX/plugin-tool-uses.txt"
expected=$(printf '%s\n%s\n' "$CAP" "$LIST")
actual=$(head -2 "$EX/plugin-tool-uses.txt")
if [ "$actual" != "$expected" ]; then
  live_fail "expected plugin calls capabilities then list, got: $(tr '\n' ' ' < "$EX/plugin-tool-uses.txt")"
fi
while IFS= read -r id; do
  [ -n "$id" ] || continue
  text=$(jq -r --arg id "$id" \
    '.[] | select(.tool_use_id == $id) | [.content[]? | select(.type == "text") | .text] | join("")' \
    "$EX/tool_results.json")
  if [ -z "$text" ]; then
    live_fail "no raw result text for tool_use $id"
  fi
  if ! printf '%s' "$text" | jq -e . >/dev/null 2>&1; then
    live_fail "raw result of tool_use $id is not JSON"
  fi
done < <(jq -r --arg cap "$CAP" --arg list "$LIST" \
  '.[] | select(.name == $cap or .name == $list) | .id' "$EX/tool_uses.json")

# 3. The server connected over stdio.
live_debug_connected "$EX/debug.log" || live_fail "debug log has no connected line for $LIVE_SERVER_NAME"

# 4. Neither excluded CLAUDE.md loaded. Claude Code writes one
#    classic.InstructionsLoaded dispatch line for each memory file it loads and
#    names the file when it loads or rejects it; with the excludes in place
#    there is no dispatch and no mention of an excluded path.
{
  grep -i 'InstructionsLoaded' "$EX/debug.log" || true
  for file in $ORQ_CLAUDE_MD_EXCLUDE_FILES; do
    grep -F "$file" "$EX/debug.log" || true
  done
} > "$EX/memory-lines.txt"
if grep -q 'InstructionsLoaded' "$EX/debug.log"; then
  live_fail "debug log reports a loaded instruction file; an excluded CLAUDE.md may have loaded"
fi
for file in $ORQ_CLAUDE_MD_EXCLUDE_FILES; do
  if grep -qF "$file" "$EX/debug.log"; then
    live_fail "debug log names excluded memory file $file"
  fi
done

live_copy_server_stderr "$EX/debug.log" "$EX"

# 5. One interactive round: trust dialog, a list call, pane capture, /exit.
#    The TUI occasionally exits right after startup when the CLI's version lock
#    is held by a concurrent session, so the round gets one retry. Each attempt
#    writes its own debug log; the successful one becomes debug-tmux.log.
run_interactive_round() {
  local session=$1 debug=$2
  live_tmux_start "$session" off "$debug" "$LIST" || return 1
  if ! live_tmux_wait "$session" 'auto mode on|shift\+tab to cycle' 10; then
    live_tmux_wait "$session" 'Yes, I trust this folder' 30 || return 1
    live_tmux_accept_trust "$session" || return 1
    live_tmux_wait "$session" 'auto mode on|shift\+tab to cycle' 30 || return 1
  fi
  live_tmux_send "$session" "$(cat "$EX/prompt-interactive.txt")"
  live_tmux_wait "$session" '● DONE' 45 || return 1
  sleep 1
  live_tmux_capture "$session" "$EX/pane.txt"
  live_tmux_exit "$session"
  return 0
}

interactive=0
for attempt in 1 2; do
  SESSION="${ORQ_LIVE_TMUX_PREFIX}-smoke-$$-$attempt"
  if run_interactive_round "$SESSION" "$EX/debug-tmux-$attempt.log"; then
    cp "$EX/debug-tmux-$attempt.log" "$EX/debug-tmux.log"
    interactive=1
    break
  fi
  live_tmux_capture "$SESSION" "$EX/pane-failed-$attempt.txt" 2>/dev/null || true
  live_tmux_exit "$SESSION"
done
if [ "$interactive" -ne 1 ]; then
  live_fail "interactive session did not show the trust dialog and answer within two attempts"
fi

grep -qF "$LIVE_SERVER_NAME" "$EX/pane.txt" || live_fail "pane.txt does not show the MCP server call"
grep -qF '● DONE' "$EX/pane.txt" || live_fail "pane.txt does not show the final answer"
live_debug_tool_called "$EX/debug-tmux.log" list || live_fail "interactive debug log does not show a list call"
if ! grep -qF "Tool 'list' completed successfully" "$EX/debug-tmux.log"; then
  live_fail "interactive debug log does not show list completing"
fi
live_debug_connected "$EX/debug-tmux.log" || live_fail "interactive debug log has no connected line"
live_copy_server_stderr "$EX/debug-tmux.log" "$EX"
