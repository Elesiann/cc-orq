#!/usr/bin/env bash
# Run one live scenario and print PASS or FAIL.
#
# Usage: bash tests/live/run.sh SCENARIO
#
# Receipts go under $ORQ_EVIDENCE_DIR/SCENARIO (default: .live-evidence/SCENARIO in the repository). A receipt
# directory that holds files this harness did not write is refused, never emptied. The scenario runs under a
# timeout. Before and after it, run.sh reaps what an earlier run left when it died without its cleanup. These
# tests need a logged-in Claude Code CLI and never run in CI.
set -uo pipefail

LIVE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$LIVE_DIR/../.." && pwd)
SCENARIO=${1:-}
# shellcheck source=lib.sh disable=SC1091
source "$LIVE_DIR/lib.sh"

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

if ! live_prepare_scratch_root; then
  printf 'FAIL %s: %s\n' "$SCENARIO" "$LIVE_SCRATCH_ERROR"
  exit 1
fi

EVIDENCE_ROOT=$(live_abs "${ORQ_EVIDENCE_DIR:-$ROOT/.live-evidence}")
EVIDENCE=$EVIDENCE_ROOT/$SCENARIO
RECEIPT_MARK=.cc-orq-live-receipts
case "$EVIDENCE_ROOT" in
  '' | '/' | "$HOME" | "$HOME"/)
    printf 'FAIL %s: refusing to use %s as the receipt root\n' "$SCENARIO" "$EVIDENCE_ROOT"
    exit 1
    ;;
esac

if [ -e "$EVIDENCE" ] || [ -L "$EVIDENCE" ]; then
  if [ -f "$EVIDENCE/$RECEIPT_MARK" ]; then
    rm -rf -- "$EVIDENCE"
  elif [ -d "$EVIDENCE" ] && [ -z "$(ls -A "$EVIDENCE")" ]; then
    :
  else
    printf 'FAIL %s: refusing to overwrite %s, which holds files this harness did not write (no %s in it); pick another ORQ_EVIDENCE_DIR\n' \
      "$SCENARIO" "$EVIDENCE" "$RECEIPT_MARK"
    exit 1
  fi
fi
mkdir -p "$EVIDENCE"
: > "$EVIDENCE/$RECEIPT_MARK"

export ORQ_EVIDENCE=$EVIDENCE
export ORQ_SCENARIO=$SCENARIO

live_reap_stale || true

TIMEOUT=${ORQ_LIVE_TIMEOUT:-170}
started=$(date +%s)
timeout -k 10 "$TIMEOUT" bash "$SCRIPT"
rc=$?
elapsed=$(($(date +%s) - started))
printf '%s\n' "$elapsed" > "$EVIDENCE/seconds.txt"

live_reap_stale || true

if [ "$rc" -eq 0 ]; then
  printf 'PASS %s\n' "$SCENARIO"
  exit 0
fi

if [ "$rc" -eq 124 ]; then
  reason="timed out after ${TIMEOUT}s"
elif [ "$rc" -eq 137 ]; then
  reason="killed by SIGKILL (out of memory?) after ${elapsed}s"
elif [ -s "$EVIDENCE/failure.txt" ]; then
  reason=$(head -1 "$EVIDENCE/failure.txt")
else
  reason="scenario exited $rc"
fi
printf 'FAIL %s: %s\n' "$SCENARIO" "$reason"
exit 1
