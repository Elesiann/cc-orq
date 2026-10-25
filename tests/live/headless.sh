#!/usr/bin/env bash
# Run one prompt through a nested, headless Claude Code session and split the
# stream into the receipts a scenario asserts on.
#
# Usage: bash tests/live/headless.sh PROMPT_FILE OUT_DIR [ALLOWED_TOOL...]
#
# Environment:
#   LIVE_MODS    on|off, function-hook mods for the nested session (default: off)
#   LIVE_REPO    repository to run in; when unset, a temporary one is created
#   LIVE_DEBUG   debug log path (default: OUT_DIR/debug.log)
#
# Writes under OUT_DIR: stream.jsonl, debug.log, stderr.txt, exit.txt,
# tool_uses.json, tool_results.json and result.txt.
set -uo pipefail
# shellcheck source=lib.sh disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [ "$#" -lt 2 ]; then
  printf 'usage: %s PROMPT_FILE OUT_DIR [ALLOWED_TOOL...]\n' "$0" >&2
  exit 2
fi

PROMPT=$1
OUT=$2
shift 2
MODS=${LIVE_MODS:-off}
DEBUG=${LIVE_DEBUG:-$OUT/debug.log}
OWN_REPO=0

mkdir -p "$OUT"
if [ -z "${LIVE_REPO:-}" ]; then
  trap live_cleanup EXIT
  live_require_tools
  live_new_repo
  OWN_REPO=1
fi

rc=0
live_run_headless "$PROMPT" "$OUT" "$MODS" "$DEBUG" "$@" || rc=$?
printf '%s\n' "$rc" > "$OUT/exit.txt"

jq -s '[.[] | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use")]' \
  "$OUT/stream.jsonl" > "$OUT/tool_uses.json"
jq -s '[.[] | select(.type == "user") | .message.content[]? | select(.type == "tool_result")]' \
  "$OUT/stream.jsonl" > "$OUT/tool_results.json"
jq -r 'select(.type == "result") | (.result // "")' "$OUT/stream.jsonl" > "$OUT/result.txt"

live_copy_server_stderr "$DEBUG" "$OUT"

if [ "$OWN_REPO" -eq 1 ]; then
  live_cleanup
fi
exit "$rc"
