#!/usr/bin/env bash
# smoke: the plugin's MCP server answers capabilities and list without mods, and
# one interactive tmux round calls list.
#
# Proves, with function-hook mods off:
#   - the nested session runs in the pinned permission mode and no claude.ai connector reached it;
#   - the init event lists the five plugin MCP tools and no mod tool, with the server connected, and
#     every MCP server in it comes from the plugin;
#   - the model calls capabilities then list, and the server answers both without an error and with
#     the documented JSON;
#   - the debug log reports the server connected over stdio and no memory file loaded;
#   - an interactive session, in the pinned mode, passes the trust dialog when it shows one, calls
#     list and exits, and its debug log says that no CLAUDE.md or rules file loaded.
set -euo pipefail
# shellcheck source=../lib.sh disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

live_setup
EX=${ORQ_EVIDENCE:?}

CAP=mcp__plugin_cc-orq_orq__capabilities
LIST=mcp__plugin_cc-orq_orq__list

live_settings off > "$EX/claude-settings.json"

cat > "$EX/prompt-headless.txt" << EOF
Call the $CAP tool, then call the $LIST tool. Do not call any other tool. Then answer with the single word DONE.
EOF
cat > "$EX/prompt-interactive.txt" << EOF
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

live_assert_init "$EX"
if grep -q '^mcp__cc-orq__' "$EX/init-tools.txt"; then
  live_fail "init event lists a mod tool with mods off: $(grep -m1 '^mcp__cc-orq__' "$EX/init-tools.txt")"
fi

live_assert_plugin_answers "$EX"

live_debug_connected "$EX/debug.log" || live_fail "debug log has no connected line for $LIVE_SERVER_NAME"
live_assert_no_instructions_loaded "$EX/debug.log" "$EX/memory-lines-headless.txt"

# One interactive round. The TUI occasionally exits right after startup when the CLI's version lock is held by a
# concurrent session, so the round gets one retry. Each attempt writes its own debug log; the successful one
# becomes debug-tmux.log.
run_interactive_round() {
  local session=$1 debug=$2
  live_tmux_start "$session" off "$debug" "$LIST" || return 1
  live_tmux_wait_ready "$session" || return 1
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
  live_tmux_capture "$SESSION" "$EX/pane-failed-$attempt.txt" 2> /dev/null || true
  live_tmux_exit "$SESSION"
done
if [ "$interactive" -ne 1 ]; then
  live_fail "interactive session did not take input and answer within two attempts"
fi

grep -qF "$LIVE_SERVER_NAME" "$EX/pane.txt" || live_fail "pane.txt does not show the MCP server call"
grep -qF '● DONE' "$EX/pane.txt" || live_fail "pane.txt does not show the final answer"
live_assert_pane_mode "$EX/pane.txt"
live_debug_tool_called "$EX/debug-tmux.log" list || live_fail "interactive debug log does not show a list call"
if ! grep -qF "Tool 'list' completed successfully" "$EX/debug-tmux.log"; then
  live_fail "interactive debug log does not show list completing"
fi
live_debug_connected "$EX/debug-tmux.log" || live_fail "interactive debug log has no connected line"

# Claude Code writes its memory lines only in an interactive session, so the excluded-CLAUDE.md check reads that log.
live_assert_no_memory_loaded "$EX/debug-tmux.log" "$EX/memory-lines.txt"
