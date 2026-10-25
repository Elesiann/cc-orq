#!/usr/bin/env bash
# smoke-mods: with function-hook mods on (the Claude Code default), the plugin
# still exposes the five MCP tools and adds the mod tool mcp__cc-orq__wait and
# the agent type cc-orq:task, in the pinned permission mode, with no MCP server
# but the plugin's (the account's claude.ai connectors least of all) and no
# memory file loaded.
set -euo pipefail
# shellcheck source=../lib.sh disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

live_setup
EX=${ORQ_EVIDENCE:?}

WAIT=mcp__cc-orq__wait

live_settings on > "$EX/claude-settings.json"

cat > "$EX/prompt-headless.txt" << 'EOF'
Answer with the single word DONE. Do not call any tool.
EOF

rc=0
LIVE_MODS=on LIVE_REPO=$LIVE_REPO LIVE_DEBUG=$EX/debug.log \
  bash "$LIVE_LIB_DIR/headless.sh" "$EX/prompt-headless.txt" "$EX" || rc=$?
if [ "$rc" -ne 0 ]; then
  live_fail "headless session exited $rc (see $EX/stderr.txt)"
fi

live_require_file "$EX/stream.jsonl"

live_assert_init "$EX"
grep -qxF "$WAIT" "$EX/init-tools.txt" || live_fail "init event does not list the mod tool $WAIT"

jq -r 'select(.type == "system" and .subtype == "init") | .agents[]' "$EX/stream.jsonl" > "$EX/init-agents.txt"
grep -qxF 'cc-orq:task' "$EX/init-agents.txt" || live_fail "init event does not offer the agent type cc-orq:task"

live_debug_connected "$EX/debug.log" || live_fail "debug log has no connected line for $LIVE_SERVER_NAME"
live_assert_no_instructions_loaded "$EX/debug.log" "$EX/memory-lines-headless.txt"
grep -qF 'hooks module cc-orq@inline loaded' "$EX/debug.log" ||
  live_fail "debug log does not show the plugin's function-hook mod loaded"
