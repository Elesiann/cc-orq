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
  for f in "$DUMP"/*.leftover "$T"/*.pid; do
    [ -f "$f" ] && kill -KILL "$(cat "$f")" 2>/dev/null || true
  done
  rm -rf "$T"
}
trap cleanup EXIT
PASS=0; FAIL=0

ok() { PASS=$((PASS+1)); echo "ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

cat > "$BIN/codex" <<'EOF'
#!/bin/bash
printf '%s\0' "$@" > "$ARGV_DUMP/codex.argv"
pwd > "$ARGV_DUMP/codex.cwd"
cat > "$ARGV_DUMP/codex.stdin"
exit 0
EOF
cat > "$BIN/opencode" <<'EOF'
#!/bin/bash
printf '%s\0' "$@" > "$ARGV_DUMP/opencode.argv"
pwd > "$ARGV_DUMP/opencode.cwd"
if [ -n "$OPENCODE_LEFTOVER" ]; then
  setsid sleep 300 </dev/null >/dev/null 2>&1 &
  echo $! > "$ARGV_DUMP/opencode.leftover"
fi
if [ -n "$OPENCODE_HOLD" ]; then
  exec python3 -c '
import ctypes, signal, sys, time
ctypes.CDLL(None).prctl(15, b"opencode", 0, 0, 0)
def on_int(*_):
    open(sys.argv[1], "w").write("interrupted\n")
    sys.exit(130)
signal.signal(signal.SIGINT, on_int)
time.sleep(float(sys.argv[2]))
' "$ARGV_DUMP/opencode.int" "$OPENCODE_HOLD"
fi
exit 0
EOF
cat > "$BIN/agy" <<'EOF'
#!/bin/bash
printf '%s\0' "$@" > "$ARGV_DUMP/agy.argv"
pwd > "$ARGV_DUMP/agy.cwd"
if [ -n "$AGY_LEFTOVER" ]; then
  setsid sleep 300 </dev/null >/dev/null 2>&1 &
  echo $! > "$ARGV_DUMP/agy.leftover"
fi
if [ -n "$AGY_SLEEP" ]; then sleep "$AGY_SLEEP"; fi
printf '{"event":"init","conversation_id":"conv-fake","init":{"model":"fake-model"}}\n'
printf '{"event":"result","result":{"conversation_id":"conv-fake","status":"SUCCESS","response":"FAKE-AGY\\n","usage":{"input_tokens":10,"output_tokens":3}}}\n'
exit 0
EOF
cat > "$BIN/claude" <<'EOF'
#!/bin/bash
printf '%s\0' "$@" > "$ARGV_DUMP/claude.argv"
pwd > "$ARGV_DUMP/claude.cwd"
if [ -n "$CLAUDE_LEFTOVER" ]; then
  setsid sleep 300 </dev/null >/dev/null 2>&1 &
  echo $! > "$ARGV_DUMP/claude.leftover"
fi
printf '{"type":"system","subtype":"init","session_id":"ses-fake"}\n'
printf '{"type":"result","subtype":"success","is_error":false,"session_id":"ses-fake","result":"FAKE-CLAUDE","usage":{"input_tokens":11,"output_tokens":4},"modelUsage":{"fake-claude-model":{}}}\n'
exit 0
EOF
chmod +x "$BIN"/codex "$BIN"/opencode "$BIN"/agy "$BIN"/claude
export PATH="$BIN:$PATH" ARGV_DUMP="$DUMP"

# run_job <name> <runner> <model> <effort> <sandbox> <prompt> [flags...]
# leaves job dir in $JOB.
run_job() {
  local name=$1 runner=$2 model=$3 effort=$4 sandbox=$5 prompt=$6
  shift 6
  JOB="$T/$name"
  mkdir -p "$JOB"
  printf '%s' "$prompt" > "$JOB/prompt.txt"
  if [ "$#" -gt 0 ]; then printf '%s\n' "$@" > "$JOB/flags"; fi
  timeout 60 bash "$ROOT/scripts/supervise.sh" "$JOB" "$runner" "$T/work" "$model" "$effort" "$sandbox"
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
timeout 60 bash "$ROOT/scripts/supervise.sh" "$RELJOB" agy "$T/work" m '' ''
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
CLAUDE_LEFTOVER=1 ORQ_JOB_DIR="$T/an-outer-job" timeout 60 bash "$ROOT/scripts/supervise.sh" "$OJOB" claude "$T/work" m '' ''
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

CJOB="$T/job-cancel"
mkdir -p "$CJOB"
printf 'never finishes' > "$CJOB/prompt.txt"
AGY_SLEEP=60 AGY_LEFTOVER=1 ORQ_JOB_DIR="$CJOB" setsid bash "$ROOT/scripts/supervise.sh" "$CJOB" agy "$T/work" m '' '' </dev/null >/dev/null 2>&1 &
CPID=$!
disown "$CPID" 2>/dev/null || true
for _ in $(seq 1 50); do [ -s "$CJOB/pgid" ] && break; sleep 0.2; done
sleep 1
echo cancelled > "$CJOB/cancel"
for _ in $(seq 1 100); do [ -e "$CJOB/exit" ] && break; sleep 0.3; done
expect_file "$CJOB/exit" 124 cancel-exit-124
# The supervisor sends TERM, sleeps 5 s, writes exit 124, then sends KILL. The runner ignores TERM, so
# the group is gone only after KILL; poll for up to 8 s before asserting.
CPGID=$(cat "$CJOB/pgid" 2>/dev/null || true)
for _ in $(seq 1 40); do [ -n "$CPGID" ] && pgrep -g "$CPGID" >/dev/null 2>&1 || break; sleep 0.2; done
if [ -n "$CPGID" ] && ! pgrep -g "$CPGID" >/dev/null 2>&1; then ok cancel-group-gone; else bad "cancel-group-gone (group ${CPGID:-missing} still has processes)"; fi
if await_dead "$(cat "$DUMP/agy.leftover")"; then ok cancel-leftover-ended; else bad cancel-leftover-ended; fi
wait "$CPID" 2>/dev/null || true

rm -f "$DUMP/opencode.int" "$DUMP/opencode.leftover"
OJOB2="$T/job-cancel-opencode"
mkdir -p "$OJOB2"
printf 'hold' > "$OJOB2/prompt.txt"
OPENCODE_HOLD=60 OPENCODE_LEFTOVER=1 ORQ_JOB_DIR="$OJOB2" setsid bash "$ROOT/scripts/supervise.sh" "$OJOB2" opencode "$T/work" m '' '' </dev/null >/dev/null 2>&1 &
OPID=$!
disown "$OPID" 2>/dev/null || true
for _ in $(seq 1 50); do [ -s "$OJOB2/pgid" ] && [ -s "$DUMP/opencode.leftover" ] && break; sleep 0.2; done
sleep 1
CANCEL_AT=$(date +%s.%N)
echo cancelled > "$OJOB2/cancel"
for _ in $(seq 1 100); do [ -e "$OJOB2/exit" ] && break; sleep 0.1; done
CANCEL_TOOK=$(python3 -c "import time; print(round(time.time() - $CANCEL_AT, 1))")
expect_file "$OJOB2/exit" 124 cancel-opencode-exit
if [ -e "$DUMP/opencode.int" ]; then ok cancel-opencode-gets-sigint; else bad cancel-opencode-gets-sigint; fi
if python3 -c "import sys; sys.exit(0 if $CANCEL_TOOK < 4.5 else 1)"; then ok "cancel-opencode-prompt (${CANCEL_TOOK}s)"; else bad "cancel-opencode-prompt (${CANCEL_TOOK}s, a SIGTERM and a wait of 5 s take longer)"; fi
if await_dead "$(cat "$DUMP/opencode.leftover")"; then ok cancel-opencode-leftover-ended; else bad cancel-opencode-leftover-ended; fi
await_dead "$OPID" || true
LEFT=$( (grep -lazsx "ORQ_JOB_DIR=$OJOB2" /proc/[0-9]*/environ 2>/dev/null || true) | sed 's#/proc/\([0-9]*\)/environ#\1#' | while read -r p; do cat "/proc/$p/comm" 2>/dev/null; done | tr '\n' ' ')
if [ -z "$LEFT" ]; then ok cancel-opencode-nothing-left; else bad "cancel-opencode-nothing-left (still carrying the marker: $LEFT)"; fi

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

echo "---"
echo "pass=$PASS fail=$FAIL scratch-cleaned"
[ "$FAIL" -eq 0 ]
