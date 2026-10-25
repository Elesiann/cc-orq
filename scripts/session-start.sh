#!/bin/bash
# The snippet teaches the cc-orq:task agent, which exists only when function hooks are on.
[ "${CLAUDE_CODE_ENABLE_FUNCTION_HOOKS:-}" = "1" ] || exit 0
FILE="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/instructions.md"
[ -r "$FILE" ] || exit 0
if command -v python3 >/dev/null 2>&1; then
  python3 -I -c 'import json, sys; print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": open(sys.argv[1], encoding="utf-8").read()}}))' "$FILE"
  exit 0
fi
text=$(cat "$FILE"; printf x)
text=${text%x}
text=${text//\\/\\\\}
text=${text//\"/\\\"}
text=${text//$'\t'/\\t}
text=${text//$'\r'/\\r}
text=${text//$'\n'/\\n}
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$text"
