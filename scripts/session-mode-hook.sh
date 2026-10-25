#!/bin/bash
# PreToolUse hook of delegate, answer and capabilities. The server cannot see the session's permission mode, so the hook
# copies permission_mode into the tool input as sessionMode, over any value the model wrote there. When the hook input
# has no permission_mode key at all, it removes the model's sessionMode, and the server falls back to the config alone.
# It prints updatedInput and nothing else: a permission decision would approve the call for the user.
# It fails closed. With no python3, input it cannot read, or a permission_mode that is present but empty or not text,
# it exits 2: the call is blocked and the reason reaches the model. A call let through that way would reach the server
# without the session's mode, and a sessionMode the model forged would lift the ceiling above the session's real mode.
if ! command -v python3 > /dev/null 2>&1; then
  echo "cc-orq: python3 is required to read the session's permission mode" >&2
  exit 2
fi
python3 -I -c '
import json
import sys


class Unusable(Exception):
    pass


def main():
    data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise Unusable("the input is not a JSON object")
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        raise Unusable("no tool_input object")
    updated = {key: value for key, value in tool_input.items() if key != "sessionMode"}
    if "permission_mode" in data:
        mode = data["permission_mode"]
        if not isinstance(mode, str) or mode == "":
            raise Unusable("permission_mode is empty or not text")
        updated["sessionMode"] = mode
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated}}
    try:
        text = json.dumps(out, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except UnicodeEncodeError:
        text = json.dumps(out, allow_nan=False).encode("ascii")
    sys.stdout.buffer.write(text)


try:
    main()
except Unusable as error:
    sys.stderr.write("cc-orq: the session-mode hook cannot use its input (" + str(error) + "), so this call is blocked\n")
    sys.exit(2)
except Exception as error:
    sys.stderr.write("cc-orq: the session-mode hook could not read its input (" + type(error).__name__ + "), so this call is blocked\n")
    sys.exit(2)
'
status=$?
if [ "$status" -ne 0 ]; then
  [ "$status" -eq 2 ] || echo "cc-orq: python3 exited $status while reading the session's permission mode, so this call is blocked" >&2
  exit 2
fi
