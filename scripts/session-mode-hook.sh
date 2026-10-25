#!/bin/bash
# PreToolUse hook of delegate, answer and capabilities. The server cannot see the session's permission mode, so the hook
# copies permission_mode into the tool input as sessionMode, over any value the model wrote there. With no mode in the
# hook input it removes the model's sessionMode, and the server falls back to the config alone. It prints updatedInput
# and nothing else: a permission decision would approve the call for the user.
# It fails closed. With no python3, or input it cannot read, it exits 2: the call is blocked and the reason reaches the
# model, because a call let through unread could carry a sessionMode the model forged, which lifts the ceiling above
# the session's real mode.
if ! command -v python3 > /dev/null 2>&1; then
  echo "cc-orq: python3 is required to read the session's permission mode" >&2
  exit 2
fi
python3 -I -c '
import json
import sys


def main():
    data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    tool_input = data.get("tool_input") if isinstance(data, dict) else None
    if not isinstance(tool_input, dict):
        raise ValueError("no tool_input object")
    mode = data.get("permission_mode")
    updated = {key: value for key, value in tool_input.items() if key != "sessionMode"}
    if isinstance(mode, str):
        updated["sessionMode"] = mode
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated}}
    try:
        text = json.dumps(out, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except UnicodeEncodeError:
        text = json.dumps(out, allow_nan=False).encode("ascii")
    sys.stdout.buffer.write(text)


try:
    main()
except Exception as error:
    sys.stderr.write("cc-orq: the session-mode hook could not read its input (" + type(error).__name__ + "), so this call is blocked\n")
    sys.exit(2)
'
status=$?
if [ "$status" -ne 0 ]; then
  [ "$status" -eq 2 ] || echo "cc-orq: python3 exited $status while reading the session's permission mode, so this call is blocked" >&2
  exit 2
fi
