#!/usr/bin/env bash
# A stand-in for the claude CLI in the checks of the live harness (tests/live/check.sh). Where the harness
# depends on Claude Code 2.1.310 it answers as that version did: --settings decides whether the plugin's mod
# and the claude.ai connectors load, --permission-mode decides what the session reports, and a session
# without -p stays up, as the pane of a tmux session does.
#
# Environment:
#   FAKE_CLAUDE_CASE  ok (default), error-result (list answers an error), bad-shape (list answers JSON
#                     without "jobs"), not-json (list answers plain text), connector (the connectors load
#                     whatever --settings says), auto-mode (init reports the auto mode), foreign-server (init
#                     lists an MCP server of the user's own), no-source (the servers carry no source),
#                     memory-loaded (the debug log has the line Claude Code writes when it loads a memory file)
#   FAKE_LOG_DIR      when set, each call appends its working directory to cwd.txt and keeps its arguments
set -uo pipefail

args=("$@")
print=0
settings='{}'
debug=''
mode=''
for i in "${!args[@]}"; do
  case ${args[$i]} in
    -p) print=1 ;;
    --settings) settings=${args[$((i + 1))]:-} ;;
    --debug-file) debug=${args[$((i + 1))]:-} ;;
    --permission-mode) mode=${args[$((i + 1))]:-} ;;
  esac
done

if [ -n "${FAKE_LOG_DIR:-}" ]; then
  mkdir -p "$FAKE_LOG_DIR"
  pwd -P >> "$FAKE_LOG_DIR/cwd.txt"
  printf '%s\n' "${args[@]}" > "$FAKE_LOG_DIR/args.$$.txt"
fi

[ "$print" -eq 1 ] || exec -a claude-fake sleep 300

case_=${FAKE_CLAUDE_CASE:-ok}
mods=1
connectors=1
reported=default
if jq -e '.disableAllHooks == true' <<< "$settings" > /dev/null 2>&1; then mods=0; fi
if jq -e '.disableClaudeAiConnectors == true' <<< "$settings" > /dev/null 2>&1; then connectors=0; fi
[ "$case_" = connector ] && connectors=1
foreign=0
[ "$case_" = foreign-server ] && foreign=1
sourced=1
[ "$case_" = no-source ] && sourced=0
case $mode in '' | manual | default) ;; *) reported=$mode ;; esac
[ "$case_" = auto-mode ] && reported=auto

if [ -n "$debug" ]; then
  {
    echo 'MCP server "plugin:cc-orq:orq": Successfully connected (transport: stdio) in 12 ms'
    if [ "$mods" -eq 1 ]; then echo 'hooks module cc-orq@inline loaded'; fi
    if [ "$case_" = memory-loaded ]; then
      echo '2026-10-25T00:00:00.000Z [DEBUG] hooks module cc-plugin-sec-default@builtin classic.InstructionsLoaded settled in 12.1ms (native link, next() included)'
    fi
  } > "$debug"
fi

prompt=$(cat)

jq -c -n --argjson mods "$mods" --argjson connectors "$connectors" --argjson foreign "$foreign" \
  --argjson sourced "$sourced" --arg mode "$reported" --arg cwd "$(pwd -P)" '
  (["capabilities", "list", "status", "cancel", "integrate"] | map("mcp__plugin_cc-orq_orq__" + .)) as $plugin
  | ([{name: "plugin:cc-orq:orq", status: "connected", source: "plugin"}]
       + (if $mods == 1 then [{name: "cc-orq", status: "connected", source: "plugin"}] else [] end)
       + (if $connectors == 1 then [{name: "claude.ai Gmail", status: "connected", source: "claudeai"},
                                    {name: "claude.ai Supabase", status: "needs-auth", source: "claudeai"}] else [] end)
       + (if $foreign == 1 then [{name: "local-notes", status: "connected", source: "user"}] else [] end)
       | if $sourced == 1 then . else map(del(.source)) end) as $servers
  | {type: "system", subtype: "init", cwd: $cwd, session_id: "fake",
     tools: (["Bash", "Read"] + $plugin
       + (if $mods == 1 then ["mcp__cc-orq__wait"] else [] end)
       + (if $connectors == 1 then ["mcp__claude_ai_Gmail__send", "mcp__claude_ai_Supabase__run_sql"] else [] end)),
     mcp_servers: $servers,
     agents: (["general-purpose"] + (if $mods == 1 then ["cc-orq:task"] else [] end)),
     permissionMode: $mode, claude_code_version: "fake"}'

call() {
  local id=$1 name=$2 text=$3 error=$4
  jq -c -n --arg id "$id" --arg name "$name" \
    '{type: "assistant", message: {content: [{type: "tool_use", id: $id, name: $name, input: {}}]}}'
  jq -c -n --arg id "$id" --arg text "$text" --argjson error "$error" \
    '{type: "user", message: {content: [({type: "tool_result", tool_use_id: $id, content: [{type: "text", text: $text}]}
      + (if $error then {is_error: true} else {} end))]}}'
}

if grep -q capabilities <<< "$prompt"; then
  call toolu_cap mcp__plugin_cc-orq_orq__capabilities '{"runtimeMode":"approval-required","interactionMode":"default","providers":[]}' false
  case $case_ in
    error-result) call toolu_list mcp__plugin_cc-orq_orq__list '{"error":"boom"}' true ;;
    bad-shape) call toolu_list mcp__plugin_cc-orq_orq__list '{"error":"boom"}' false ;;
    not-json) call toolu_list mcp__plugin_cc-orq_orq__list 'oops' false ;;
    *) call toolu_list mcp__plugin_cc-orq_orq__list '{"jobs":[]}' false ;;
  esac
fi

jq -c -n '{type: "result", subtype: "success", is_error: false, result: "DONE"}'
