#!/usr/bin/env bash
# Run one live scenario and print PASS or FAIL.
#
# Usage: bash tests/live/run.sh SCENARIO
#
# Receipts go under $ORQ_EVIDENCE_DIR/SCENARIO (default: ./.live-evidence/SCENARIO).
# The scenario runs under a timeout and every run leaves its tmux session, its
# temporary repository and the processes it started behind only if cleanup
# itself failed. These tests need a logged-in Claude Code CLI and never run in
# CI.
set -uo pipefail

LIVE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$LIVE_DIR/../.." && pwd)
SCENARIO=${1:-}

if [ -z "$SCENARIO" ]; then
  printf 'usage: %s SCENARIO\n' "$0" >&2
  printf 'scenarios: %s\n' "$(cd "$LIVE_DIR/scenarios" && printf '%s ' ./*.sh | sed 's|\./||g; s|\.sh||g')" >&2
  exit 2
fi
case "$SCENARIO" in
  *[!A-Za-z0-9._-]* | .* | *..*)
    printf 'FAIL %s: invalid scenario name\n' "$SCENARIO"
    exit 1
    ;;
esac

SCRIPT=$LIVE_DIR/scenarios/$SCENARIO.sh
if [ ! -f "$SCRIPT" ]; then
  printf 'FAIL %s: no such scenario\n' "$SCENARIO"
  exit 1
fi

EVIDENCE_ROOT=${ORQ_EVIDENCE_DIR:-$ROOT/.live-evidence}
EVIDENCE=$EVIDENCE_ROOT/$SCENARIO
case "$EVIDENCE_ROOT" in
  '' | '/' | "$HOME")
    printf 'FAIL %s: refusing to use %s as the receipt root\n' "$SCENARIO" "$EVIDENCE_ROOT"
    exit 1
    ;;
esac

rm -rf -- "$EVIDENCE"
mkdir -p "$EVIDENCE"

export ORQ_EVIDENCE=$EVIDENCE
export ORQ_SCENARIO=$SCENARIO

TIMEOUT=${ORQ_LIVE_TIMEOUT:-170}
started=$(date +%s)
timeout "$TIMEOUT" bash "$SCRIPT"
rc=$?
elapsed=$(( $(date +%s) - started ))
printf '%s\n' "$elapsed" > "$EVIDENCE/seconds.txt"

if [ "$rc" -eq 0 ]; then
  printf 'PASS %s\n' "$SCENARIO"
  exit 0
fi

if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  reason="timed out after ${TIMEOUT}s"
elif [ -s "$EVIDENCE/failure.txt" ]; then
  reason=$(head -1 "$EVIDENCE/failure.txt")
else
  reason="scenario exited $rc"
fi
printf 'FAIL %s: %s\n' "$SCENARIO" "$reason"
exit 1
