#!/bin/bash
# runners shell suite: real argv/extraction/cancel coverage for the orq
# job supervisor and event extractor. This runs under plain bash — the
# `claude plugin test` exercises isolated hook doubles, so it cannot execute
# scripts or put fake executables on PATH. The TypeScript suite pins the same
# public contract; this companion harness invokes the actual shell scripts.
#
# Usage: bash tests/runners-shell.sh
set -e -o pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
T="$ROOT/.ref/tmp/runners-shell-$(date +%s)-$$"
BIN="$T/bin"; DUMP="$T/dump"
mkdir -p "$BIN" "$DUMP"
cleanup() {
  local f
  for f in "$DUMP"/*.leftover "$DUMP"/*.straggler "$T"/*.dump/*.leftover "$T"/*.dump/*.straggler "$T"/*.pid; do
    [ -f "$f" ] && kill -KILL "$(cat "$f")" 2>/dev/null || true
  done
  rm -rf "$T"
}
trap cleanup EXIT
PASS=0; FAIL=0

ok() { PASS=$((PASS+1)); echo "ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

cat > "$BIN/fakelib.sh" <<'EOF'
SLEEP=$(command -v sleep)
# A marked process in a session of its own, like an MCP server the CLI leaves behind. It takes 0.8 s to stop on SIGTERM.
leftover() {
  setsid "$BIN/slow-stop" "$ARGV_DUMP/$1.leftover" 0.8 </dev/null >/dev/null 2>&1 &
  for _ in $(seq 1 100); do [ -s "$ARGV_DUMP/$1.leftover" ] && break; sleep 0.02; done
}
# A member of the CLI's process group with a scrubbed environment that ignores SIGTERM: only a SIGKILL to the group ends it.
straggler() {
  env -i "$SLEEP" 301 </dev/null >/dev/null 2>&1 &
  echo $! > "$ARGV_DUMP/$1.straggler"
}
EOF
cat > "$BIN/slow-stop" <<'EOF'
#!/usr/bin/env python3
import os, signal, sys, time
open(sys.argv[1], 'w').write('%d\n' % os.getpid())
def on_term(*_):
    time.sleep(float(sys.argv[2]))
    sys.exit(0)
signal.signal(signal.SIGTERM, on_term)
time.sleep(300)
EOF
cat > "$BIN/hold" <<'EOF'
#!/usr/bin/env python3
import ctypes, os, signal, sys, time
name, seconds, ends_on = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
dump = os.environ['ARGV_DUMP']
if os.environ.get('HOLD_COMM'):
    ctypes.CDLL(None).prctl(15, os.environ['HOLD_COMM'].encode(), 0, 0, 0)
def ends(word, number):
    def on_signal(*_):
        open('%s/%s.%s' % (dump, name, word), 'w').write('1\n')
        sys.exit(128 + number)
    return on_signal
for word, number in (('int', signal.SIGINT), ('term', signal.SIGTERM)):
    signal.signal(number, ends(word, number) if word in ends_on else signal.SIG_IGN)
open('%s/%s.ready' % (dump, name), 'w').write('1\n')
time.sleep(seconds)
EOF
cat > "$BIN/codex" <<'EOF'
#!/bin/bash
printf '%s\0' "$@" > "$ARGV_DUMP/codex.argv"
pwd > "$ARGV_DUMP/codex.cwd"
cat > "$ARGV_DUMP/codex.stdin"
exit 0
EOF
cat > "$BIN/opencode" <<'EOF'
#!/bin/bash
. "$BIN/fakelib.sh"
printf '%s\0' "$@" > "$ARGV_DUMP/opencode.argv"
pwd > "$ARGV_DUMP/opencode.cwd"
[ -n "$OPENCODE_LEFTOVER" ] && leftover opencode
[ -n "$OPENCODE_STRAGGLER" ] && straggler opencode
[ -n "$OPENCODE_HOLD" ] && exec "$BIN/hold" opencode "$OPENCODE_HOLD" $OPENCODE_ENDS_ON
exit 0
EOF
cat > "$BIN/agy" <<'EOF'
#!/bin/bash
. "$BIN/fakelib.sh"
printf '%s\0' "$@" > "$ARGV_DUMP/agy.argv"
pwd > "$ARGV_DUMP/agy.cwd"
[ -n "$AGY_LEFTOVER" ] && leftover agy
[ -n "$AGY_STRAGGLER" ] && straggler agy
[ -n "$AGY_HOLD" ] && exec "$BIN/hold" agy "$AGY_HOLD" $AGY_ENDS_ON
if [ -n "$AGY_SLEEP" ]; then : > "$ARGV_DUMP/agy.ready"; sleep "$AGY_SLEEP"; fi
printf '{"event":"init","conversation_id":"conv-fake","init":{"model":"fake-model"}}\n'
printf '{"event":"result","result":{"conversation_id":"conv-fake","status":"SUCCESS","response":"FAKE-AGY\\n","usage":{"input_tokens":10,"output_tokens":3}}}\n'
exit 0
EOF
cat > "$BIN/claude" <<'EOF'
#!/bin/bash
. "$BIN/fakelib.sh"
printf '%s\0' "$@" > "$ARGV_DUMP/claude.argv"
pwd > "$ARGV_DUMP/claude.cwd"
[ -n "$CLAUDE_LEFTOVER" ] && leftover claude
[ -n "$CLAUDE_SLEEP" ] && sleep "$CLAUDE_SLEEP"
printf '{"type":"system","subtype":"init","session_id":"ses-fake"}\n'
printf '{"type":"result","subtype":"success","is_error":false,"session_id":"ses-fake","result":"FAKE-CLAUDE","usage":{"input_tokens":11,"output_tokens":4},"modelUsage":{"fake-claude-model":{}}}\n'
exit 0
EOF
chmod +x "$BIN"/codex "$BIN"/opencode "$BIN"/agy "$BIN"/claude "$BIN"/hold "$BIN"/slow-stop
export BIN PATH="$BIN:$PATH" ARGV_DUMP="$DUMP"

# run_job <name> <runner> <model> <effort> <sandbox> <prompt> [flags...]
# leaves job dir in $JOB.
run_job() {
  local name=$1 runner=$2 model=$3 effort=$4 sandbox=$5 prompt=$6
  shift 6
  JOB="$T/$name"
  mkdir -p "$JOB"
  printf '%s' "$prompt" > "$JOB/prompt.txt"
  if [ "$#" -gt 0 ]; then printf '%s\n' "$@" > "$JOB/flags"; fi
  timeout 60 bash "$ROOT/scripts/supervise.sh" "$JOB" "$runner" "$T/work" "$model" "$effort" "$sandbox" > "$JOB/child.log" 2>&1
}

argv_lines() { tr '\0' '\n' < "$DUMP/$1.argv"; }
expect_argv() {
  local name=$1 runner=$2
  shift 2
  local want
  want=$(printf '%s\n' "$@")
  if [ "$(argv_lines "$runner")" = "$want" ]; then ok "$name argv"; else
    bad "$name argv"; echo "--- got ---"; argv_lines "$runner"; echo "--- want ---"; printf '%s\n' "$@"
  fi
}
expect_file() {
  if [ "$(cat "$1")" = "$2" ]; then ok "$3"; else bad "$3 (got: $(cat "$1" | head -c 200))"; fi
}

# dead PID: the process is gone, or is only a zombie that its parent has not collected.
dead() {
  local state
  state=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -c1)
  [ -z "$state" ] || [ "$state" = Z ]
}
await_dead() {
  local i
  for i in $(seq 1 60); do dead "$1" && return 0; sleep 0.1; done
  return 1
}

mkdir -p "$T/work"

run_job job-agy agy 'm-agy' '' '' 'hello agy'
expect_argv agy-plain agy --output-format stream-json --model m-agy --print 'hello agy'
expect_file "$JOB/exit" 0 agy-plain-exit
expect_file "$JOB/last.txt" 'FAKE-AGY' agy-plain-last
[ "$(cat "$DUMP/agy.cwd")" = "$T/work" ] && ok agy-plain-cwd || bad agy-plain-cwd

# The job directory can be relative. Its output paths must be opened before
# the runner subshell changes to the job cwd.
RELJOB="${T#"$ROOT"/}/job-relative"
mkdir -p "$ROOT/$RELJOB"
printf '%s' 'relative dir prompt' > "$ROOT/$RELJOB/prompt.txt"
timeout 60 bash "$ROOT/scripts/supervise.sh" "$RELJOB" agy "$T/work" m '' '' > "$ROOT/$RELJOB/child.log" 2>&1
expect_argv agy-relative-dir agy --output-format stream-json --model m --print 'relative dir prompt'
expect_file "$ROOT/$RELJOB/exit" 0 agy-relative-dir-exit
expect_file "$ROOT/$RELJOB/last.txt" FAKE-AGY agy-relative-dir-last

run_job job-agy-flags agy '' '' '' 'hello' --effort low '' --sandbox '--custom=two words'
expect_argv agy-flags agy --output-format stream-json --effort low --sandbox '--custom=two words' --print hello
expect_file "$JOB/exit" 0 agy-flags-exit

run_job job-claude claude m-claude '' '' 'hello claude' --permission-mode plan
expect_argv claude-flags claude -p --output-format stream-json --verbose --model m-claude --permission-mode plan -- 'hello claude'
expect_file "$JOB/last.txt" FAKE-CLAUDE claude-flags-last
expect_file "$JOB/exit" 0 claude-flags-exit
[ "$(cat "$DUMP/claude.cwd")" = "$T/work" ] && ok claude-flags-cwd || bad claude-flags-cwd

run_job job-claude-dash claude m-claude '' '' '-danger do it'
[ "$(argv_lines claude | tail -2 | tr '\n' '|')" = '--|-danger do it|' ] && ok claude-dash-separator || bad claude-dash-separator
run_job job-agy-dash agy m '' '' '-danger do it'
[ "$(argv_lines agy | tail -2 | tr '\n' '|')" = '--print|-danger do it|' ] && ok agy-dash-print-value || bad agy-dash-print-value
run_job job-agy-newline agy m '' '' $'line one\n'
python3 - "$DUMP/agy.argv" <<'PY'
import sys
argv = open(sys.argv[1], 'rb').read().split(b'\0')[:-1]
if argv[-1] == b'line one\n':
    print('ok: agy trailing newline prompt')
else:
    print('FAIL: agy trailing newline prompt')
    raise SystemExit(1)
PY

# Exercise each real runner without a flags file as well as the flag cases below.
run_job job-codex-plain codex '' '' '' 'plain codex prompt'
expect_argv codex-plain codex exec --json -o "$JOB/last.txt" -C "$T/work" --skip-git-repo-check -
expect_file "$DUMP/codex.stdin" 'plain codex prompt' codex-plain-stdin-prompt

run_job job-opencode-plain opencode plain-model '' '' 'plain opencode prompt'
expect_argv opencode-plain opencode run --standalone --format json -m plain-model -- 'plain opencode prompt'

run_job job-codex codex m1 medium read-only 'do it via codex' -c 'foo=bar'
expect_argv codex-flags codex exec --json -o "$JOB/last.txt" -m m1 -c 'model_reasoning_effort="medium"' -s read-only -C "$T/work" --skip-git-repo-check -c 'foo=bar' -
expect_file "$DUMP/codex.stdin" 'do it via codex' codex-stdin-prompt
expect_file "$JOB/exit" 0 codex-exit

# cc-orq:task passes its policy flags through the flags file, one argv item per line.
run_job job-codex-approve codex m3 '' '' 'approve via codex' --approve-for-me
expect_argv codex-approve-flags codex exec --json -o "$JOB/last.txt" -m m3 -C "$T/work" --skip-git-repo-check --approve-for-me -
expect_file "$JOB/exit" 0 codex-approve-exit

run_job job-opencode opencode m2 '' '' 'do it via opencode' --agent plan
expect_argv opencode-flags opencode run --standalone --format json -m m2 --agent plan -- 'do it via opencode'
expect_file "$JOB/exit" 0 opencode-exit
[ "$(cat "$DUMP/opencode.cwd")" = "$T/work" ] && ok opencode-cwd || bad opencode-cwd

# The job's marker is its ORQ_JOB_DIR. The timeout wrapper carries it too and is an ancestor of the supervisor.
setsid sleep 300 </dev/null >/dev/null 2>&1 &
echo $! > "$T/bystander.pid"
ORQ_JOB_DIR=/another/job setsid sleep 300 </dev/null >/dev/null 2>&1 &
echo $! > "$T/other-job.pid"
LJOB="$T/job-leftover"
mkdir -p "$LJOB"
printf 'leave one behind' > "$LJOB/prompt.txt"
CLAUDE_LEFTOVER=1 ORQ_JOB_DIR="$LJOB" timeout 60 bash "$ROOT/scripts/supervise.sh" "$LJOB" claude "$T/work" m '' '' > "$LJOB/child.log" 2>&1
expect_file "$LJOB/exit" 0 leftover-exit
expect_file "$LJOB/last.txt" FAKE-CLAUDE leftover-last
expect_file "$LJOB/child.log" 'orq: ended 1 process that carried ORQ_JOB_DIR' leftover-reported
if await_dead "$(cat "$DUMP/claude.leftover")"; then ok leftover-ended; else bad leftover-ended; fi
if dead "$(cat "$T/bystander.pid")"; then bad leftover-spares-unmarked; else ok leftover-spares-unmarked; fi
if dead "$(cat "$T/other-job.pid")"; then bad leftover-spares-other-job; else ok leftover-spares-other-job; fi
kill -KILL "$(cat "$T/bystander.pid")" "$(cat "$T/other-job.pid")" 2>/dev/null || true

CJOB0="$T/job-clean"
mkdir -p "$CJOB0"
printf 'leave nothing' > "$CJOB0/prompt.txt"
ORQ_JOB_DIR="$CJOB0" timeout 60 bash "$ROOT/scripts/supervise.sh" "$CJOB0" claude "$T/work" m '' '' > "$CJOB0/child.log" 2>&1
expect_file "$CJOB0/exit" 0 clean-job-exit
expect_file "$CJOB0/child.log" '' clean-job-child-log-empty

# A worker that runs this suite inside another job inherits that job's ORQ_JOB_DIR and must not end its processes.
OJOB="$T/job-not-its-marker"
mkdir -p "$OJOB"
printf 'x' > "$OJOB/prompt.txt"
CLAUDE_LEFTOVER=1 ORQ_JOB_DIR="$T/an-outer-job" timeout 60 bash "$ROOT/scripts/supervise.sh" "$OJOB" claude "$T/work" m '' '' > "$OJOB/child.log" 2>&1
sleep 0.5
if dead "$(cat "$DUMP/claude.leftover")"; then bad foreign-marker-sweeps-nothing; else ok foreign-marker-sweeps-nothing; fi
kill -KILL "$(cat "$DUMP/claude.leftover")" 2>/dev/null || true

check_extract() {
  local got
  got=$(python3 "$ROOT/scripts/extract.py" "$1" "$2")
  if [ "$got" = "$3" ]; then ok "extract $2 $4"; else bad "extract $2 $4 (got: $got)"; fi
}
check_extract "$ROOT/tests/fixtures/agy-stream.jsonl" agy \
  '{"tid": "fixture-agy-session", "in": 14298, "out": 1, "error": false, "model": "fixture-model-agy"}' fixture
check_extract "$ROOT/tests/fixtures/claude-stream.jsonl" claude \
  '{"tid": "fixture-claude-session", "in": 44, "out": 3670, "error": false, "model": "fixture-model-claude"}' fixture
printf '%s\n' '{"event":"result","result":{"conversation_id":"c1","status":"FAILED","response":"x","usage":{"input_tokens":1,"output_tokens":2}}}' > "$T/agy-err.jsonl"
check_extract "$T/agy-err.jsonl" agy '{"tid": "c1", "in": 1, "out": 2, "error": true}' failed-status
printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"session_id":"s9","result":"bad","usage":{"input_tokens":7,"output_tokens":8},"modelUsage":{"m-x":{}}}' > "$T/claude-err.jsonl"
check_extract "$T/claude-err.jsonl" claude '{"tid": "s9", "in": 7, "out": 8, "error": true, "model": "m-x"}' error-result
check_extract "$ROOT/tests/fixtures/opencode-stream.jsonl" opencode \
  '{"tid": "fixture-opencode-session", "in": null, "out": null, "error": false}' no-token-counts
printf '%s\n' '{"type":"step_start","sessionID":"s-tok","part":{"type":"step-start"}}' \
  '{"type":"step_finish","sessionID":"s-tok","part":{"type":"step_finish","tokens":{"input":30,"output":5}}}' \
  '{"type":"text","sessionID":"s-tok","part":{"type":"text","text":"x"}}' \
  '{"type":"step_finish","sessionID":"s-tok","part":{"type":"step-finish","tokens":{"input":12,"output":2}}}' > "$T/opencode-tokens.jsonl"
check_extract "$T/opencode-tokens.jsonl" opencode '{"tid": "s-tok", "in": 42, "out": 7, "error": false}' step-finish-counts

SETSID=$(command -v setsid)
NOPGREP="$T/no-pgrep"
mkdir -p "$NOPGREP"
for tool in python3 env setsid sleep seq dirname mv cat; do ln -s "$(command -v "$tool")" "$NOPGREP/$tool"; done

# cancel_scenario <name> <runner> <marked|unmarked> [VAR=value...]
# One cancel, started as the start script starts a job: a supervisor under setsid with its output in child.log. The
# scenarios run side by side, so each writes what it saw to $T/<name>.res: took_ms (from the request to exit),
# leftover (state of the marked leftover when exit appeared), straggler_ms (how long the straggler lived after exit),
# group_left, marked_left (what still carried the marker, for a marked job) and sigint (the CLI got SIGINT).
cancel_scenario() {
  local name=$1 runner=$2 marked=$3; shift 3
  local job="$T/$name" d="$T/$name.dump" mark=() i sup pgid sp t0 t1 left=none straggler=none group marked_left=na
  mkdir -p "$job" "$d"
  printf 'never finishes' > "$job/prompt.txt"
  [ "$marked" = marked ] && mark=(ORQ_JOB_DIR="$job")
  env ARGV_DUMP="$d" "${mark[@]}" "$@" "$SETSID" "$BASH" "$ROOT/scripts/supervise.sh" "$job" "$runner" "$T/work" m '' '' </dev/null > "$job/child.log" 2>&1 &
  sup=$!
  for i in $(seq 1 100); do [ -s "$job/pgid" ] && [ -e "$d/$runner.ready" ] && break; sleep 0.1; done
  sleep 1
  t0=$(date +%s%N)
  echo cancelled > "$job/cancel"
  for i in $(seq 1 1250); do [ -e "$job/exit" ] && break; sleep 0.02; done
  if [ -s "$d/$runner.leftover" ]; then if dead "$(cat "$d/$runner.leftover")"; then left=dead; else left=alive; fi; fi
  t1=$(date +%s%N)
  if [ -s "$d/$runner.straggler" ]; then
    sp=$(cat "$d/$runner.straggler")
    straggler=never
    for i in $(seq 1 100); do
      if dead "$sp"; then straggler=$(( ($(date +%s%N) - t1) / 1000000 )); break; fi
      sleep 0.02
    done
  fi
  pgid=$(cat "$job/pgid")
  for i in $(seq 1 100); do pgrep -g "$pgid" >/dev/null 2>&1 || break; sleep 0.05; done
  group=$( (pgrep -g "$pgid" 2>/dev/null || true) | wc -l)
  if [ "$marked" = marked ]; then
    marked_left=$( (grep -lazsx "ORQ_JOB_DIR=$job" /proc/[0-9]*/environ 2>/dev/null || true) | sed 's#/proc/\([0-9]*\)/environ#\1#' | while read -r p; do cat "/proc/$p/comm" 2>/dev/null; done | tr '\n' ' ')
  fi
  {
    echo "took_ms=$(( (t1 - t0) / 1000000 ))"
    echo "leftover=$left"
    echo "straggler_ms=$straggler"
    echo "group_left=$group"
    echo "marked_left=$marked_left"
    echo "sigint=$([ -e "$d/$runner.int" ] && echo yes || echo no)"
  } > "$T/$name.res"
  wait "$sup" 2>/dev/null || true
}
res() { sed -n "s/^$2=//p" "$T/$1.res"; }

# check_cancel <name> <label> <max ms to exit>: what every cancel must leave behind, whichever way the CLI ended.
check_cancel() {
  local name=$1 label=$2 limit=$3 v
  expect_file "$T/$name/exit" 124 "$label-exit-124"
  v=$(res "$name" took_ms)
  if [ "${v:-$limit}" -lt "$limit" ]; then ok "$label-exit-in-time (${v} ms)"; else bad "$label-exit-in-time (${v:-no result} ms, limit $limit ms)"; fi
  v=$(res "$name" group_left)
  if [ "$v" = 0 ]; then ok "$label-group-gone"; else bad "$label-group-gone (${v:-no result} processes still in the group)"; fi
  v=$(res "$name" leftover)
  case "$v" in
    dead) ok "$label-leftover-dead-at-exit" ;;
    none) ;;
    *) bad "$label-leftover-dead-at-exit (a marked leftover that needs 0.8 s to stop was $v when exit appeared)" ;;
  esac
  v=$(res "$name" straggler_ms)
  case "$v" in
    none) ;;
    never) bad "$label-straggler-gone (a member of the group with no marker and no SIGTERM handler outlived the job)" ;;
    *) if [ "$v" -le 1000 ]; then ok "$label-straggler-gone (${v} ms after exit)"; else bad "$label-straggler-gone (${v} ms after exit)"; fi ;;
  esac
  v=$(res "$name" marked_left)
  case "$v" in
    na) ;;
    '') ok "$label-nothing-left" ;;
    *) bad "$label-nothing-left (still carrying the marker: $v)" ;;
  esac
}

near_tick_job() {
  local job="$T/job-near-tick"
  mkdir -p "$job" "$T/job-near-tick.dump"
  printf 'x' > "$job/prompt.txt"
  ARGV_DUMP="$T/job-near-tick.dump" CLAUDE_SLEEP=1.94 ORQ_JOB_DIR="$job" timeout 60 bash "$ROOT/scripts/supervise.sh" "$job" claude "$T/work" m '' '' > "$job/child.log" 2>&1
}

SCENARIOS=()
cancel_scenario cancel-hung-agy agy unmarked AGY_SLEEP=60 AGY_STRAGGLER=1 & SCENARIOS+=($!)
cancel_scenario cancel-hung-agy-marked agy marked AGY_SLEEP=60 AGY_LEFTOVER=1 AGY_STRAGGLER=1 & SCENARIOS+=($!)
cancel_scenario cancel-agy-ends-on-term agy marked AGY_HOLD=60 AGY_ENDS_ON=term AGY_LEFTOVER=1 AGY_STRAGGLER=1 & SCENARIOS+=($!)
cancel_scenario cancel-opencode-ends-on-sigint opencode marked OPENCODE_HOLD=60 OPENCODE_ENDS_ON=int HOLD_COMM=opencode OPENCODE_LEFTOVER=1 OPENCODE_STRAGGLER=1 & SCENARIOS+=($!)
cancel_scenario cancel-opencode-no-pgrep opencode marked PATH="$NOPGREP:$BIN" OPENCODE_HOLD=60 OPENCODE_ENDS_ON=int OPENCODE_LEFTOVER=1 OPENCODE_STRAGGLER=1 & SCENARIOS+=($!)
cancel_scenario cancel-opencode-ignores-sigint opencode marked OPENCODE_HOLD=60 HOLD_COMM=opencode OPENCODE_LEFTOVER=1 OPENCODE_STRAGGLER=1 & SCENARIOS+=($!)
near_tick_job & SCENARIOS+=($!)
for p in "${SCENARIOS[@]}"; do wait "$p" || true; done

# The original check: no marker, a CLI that ignores SIGTERM, so only the watcher's SIGKILL can end the group.
check_cancel cancel-hung-agy cancel 12000
check_cancel cancel-hung-agy-marked cancel-marked 12000

check_cancel cancel-agy-ends-on-term cancel-agy-sigterm 5000

check_cancel cancel-opencode-ends-on-sigint cancel-opencode 4500
if [ "$(res cancel-opencode-ends-on-sigint sigint)" = yes ]; then ok cancel-opencode-gets-sigint; else bad cancel-opencode-gets-sigint; fi

if PATH="$NOPGREP:$BIN" command -v pgrep >/dev/null; then bad no-pgrep-path-hides-pgrep; else ok no-pgrep-path-hides-pgrep; fi
check_cancel cancel-opencode-no-pgrep cancel-opencode-no-pgrep 4500
if [ "$(res cancel-opencode-no-pgrep sigint)" = yes ]; then ok cancel-opencode-no-pgrep-gets-sigint; else bad cancel-opencode-no-pgrep-gets-sigint; fi

check_cancel cancel-opencode-ignores-sigint cancel-opencode-ignores-sigint 12000
if grep -q 'did not end on SIGINT' "$T/cancel-opencode-ignores-sigint/child.log"; then ok cancel-opencode-ignores-sigint-says-so; else bad cancel-opencode-ignores-sigint-says-so; fi

expect_file "$T/job-near-tick/exit" 0 near-tick-exit
expect_file "$T/job-near-tick/child.log" '' near-tick-child-log-empty
# The main flow stops the watcher first now, so a clean job rarely finds it gone; a watcher that is already collected must still be silent.
GONE=$(bash -c 'eval "$(sed -n "/^stop_watcher() {/,/^}/p" "$1")"; watcher=2147483000; stop_watcher' _ "$ROOT/scripts/supervise.sh" 2>&1 || true)
if [ -z "$GONE" ]; then ok stop-watcher-silent-when-watcher-gone; else bad "stop-watcher-silent-when-watcher-gone ($GONE)"; fi

BURST="$T/burst"
mkdir -p "$BURST"
for n in $(seq 1 200); do
  mkdir -p "$BURST/job-$n"
  printf '%s' "burst $n" > "$BURST/job-$n/prompt.txt"
done
python3 - "$BURST" 200 "$T/burst.json" <<'PY' &
import json, re, sys, time
root, jobs, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
pending = set(range(1, jobs + 1))
good = {}
reads = empty = malformed = 0
deadline = time.monotonic() + 60
while pending and time.monotonic() < deadline:
    for n in sorted(pending):
        try:
            with open(f"{root}/job-{n}/exit", "rb") as f:
                data = f.read()
        except FileNotFoundError:
            continue
        reads += 1
        if not data:
            empty += 1
        elif re.fullmatch(rb"\d+\n", data):
            good[n] = data
            pending.discard(n)
        else:
            malformed += 1
result = {"jobs": jobs, "reads": reads, "empty": empty, "malformed": malformed,
          "nonzero": sum(1 for d in good.values() if d != b"0\n"),
          "missing": len(pending)}
with open(out, "w") as f:
    json.dump(result, f)
PY
READER=$!
for w in $(seq 0 9); do
  pids=()
  for i in $(seq 1 20); do
    timeout 60 bash "$ROOT/scripts/supervise.sh" "$BURST/job-$((w * 20 + i))" agy "$T/work" m '' '' >/dev/null 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || true; done
done
wait "$READER" || true
if burst=$(python3 - "$T/burst.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
line = f"exit-reads {d['jobs']} jobs, {d['reads']} reads, {d['empty']} empty"
if d["empty"] or d["malformed"] or d["nonzero"] or d["missing"]:
    print(f"{line}, {d['malformed']} malformed, {d['nonzero']} not 0, {d['missing']} missing")
    raise SystemExit(1)
print(line)
PY
); then ok "$burst"; else bad "${burst:-exit-reads: no reader result}"; fi
if [ -z "$(find "$BURST" -name 'exit.*.tmp')" ]; then ok exit-tmp-clean; else bad "exit-tmp-clean (exit.*.tmp left in a job dir)"; fi

NOISY=$( (grep -lE 'Killed|Terminated|No such file or directory|/proc/' "$T"/*/child.log "$ROOT/$RELJOB/child.log" 2>/dev/null || true) | sed "s#$T/##" | tr '\n' ' ')
if [ -z "$NOISY" ]; then ok "child-logs-free-of-bash-noise ($(ls "$T"/*/child.log | wc -l) logs)"; else bad "child-logs-free-of-bash-noise (bash printed into: $NOISY)"; fi

echo "---"
echo "pass=$PASS fail=$FAIL scratch-cleaned"
[ "$FAIL" -eq 0 ]
