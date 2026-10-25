#!/bin/bash
# hook shell suite: scripts/session-mode-hook.sh, the PreToolUse hook that copies the session's permission mode into
# the input of the orq tools that read it. This runs the script on hook input as Claude Code sends it and checks every
# branch: the mode injected over a forged one, the model's own sessionMode removed when there is no mode to inject,
# and the blocked call (exit 2) when the hook cannot read its input or has no python3. The claude plugin test kit
# cannot run scripts, so this suite is the real check.
#
# Usage: bash tests/hook-shell.sh
set -e -o pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
HOOK="$ROOT/scripts/session-mode-hook.sh"
BASH_BIN=$(command -v bash)
T="$ROOT/.ref/tmp/hook-shell-$(date +%s)-$$"
mkdir -p "$T"
STALL_WRITER=
cleanup() {
  if [ -n "$STALL_WRITER" ]; then kill "$STALL_WRITER" 2>/dev/null || true; fi
  rm -rf "$T"
}
trap cleanup EXIT
PASS=0; FAIL=0; RUNS=0; DECISIONS=0

ok() { PASS=$((PASS+1)); echo "ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# Every run is held to the rule that no branch prints a permission decision: it would approve the call.
no_decision() {
  RUNS=$((RUNS+1))
  if grep -q 'permissionDecision' "$T/out" "$T/err"; then DECISIONS=$((DECISIONS+1)); bad "$1 printed a permission decision"; fi
}

# Runs the hook on the text in $1. The output goes to $T/out, the error stream to $T/err, the exit code to $T/code.
run_hook() {
  set +e
  printf '%s' "$1" | bash "$HOOK" > "$T/out" 2> "$T/err"
  echo $? > "$T/code"
  set -e
  no_decision "the run on $(printf '%s' "$1" | head -c 60)"
}

# Evaluates a Python check against the hook output in $T/out; the program reads it as `out` (text) and args.
check() {
  python3 -I -c 'import json, sys
out = open(sys.argv[1], encoding="utf-8").read()
args = sys.argv[3:]
exec(sys.argv[2])' "$T/out" "$@"
}

input() { # permission_mode_json tool_input_json
  printf '{"session_id":"s-1","transcript_path":"/t.jsonl","cwd":"/work","permission_mode":%s,"hook_event_name":"PreToolUse","tool_name":"mcp__plugin_cc-orq_orq__delegate","tool_input":%s,"tool_use_id":"tu-1"}' "$1" "$2"
}

PLAIN='{"target":"codex","model":"m","cwd":"/work","prompt":"Say OK."}'

# A stdin that never ends and never has data: the hook must give up by itself, well inside the 30 s of hooks.json.
# It runs in the background from here, so its 20 s overlap the checks below, and its verdict is read at the end.
mkfifo "$T/stalled"
sleep 60 > "$T/stalled" &
STALL_WRITER=$!
(
  began=$(date +%s)
  set +e
  bash "$HOOK" < "$T/stalled" > "$T/stall-out" 2> "$T/stall-err"
  echo $? > "$T/stall-code"
  echo $(( $(date +%s) - began )) > "$T/stall-seconds"
) &
STALL_RUN=$!

# A mode is present: it is injected as sessionMode, over any value the model sent.
for mode in default manual acceptEdits auto bypassPermissions dontAsk plan; do
  run_hook "$(input "\"$mode\"" "$PLAIN")"
  if [ "$(cat "$T/code")" = 0 ] && [ ! -s "$T/err" ] && check 'import json
want = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {"target": "codex", "model": "m", "cwd": "/work", "prompt": "Say OK.", "sessionMode": args[0]}}}
sys.exit(0 if json.loads(out) == want else 1)' "$mode"; then ok "injects-$mode"; else bad "injects-$mode (got: $(head -c 300 "$T/out"))"; fi
done

run_hook "$(input '"auto"' "$PLAIN")"
if check 'import json
o = json.loads(out)
sys.exit(0 if list(o) == ["hookSpecificOutput"] and list(o["hookSpecificOutput"]) == ["hookEventName", "updatedInput"] else 1)'; then ok output-keys-exact; else bad "output-keys-exact (got: $(head -c 300 "$T/out"))"; fi

RICH='{"prompt":"ação ✓ 😀 \"quoted\" back\\slash\nsecond line\ttab","nested":{"a":[1,2,{"b":null}],"c":{"d":"e"}},"decimal":2.5,"whole":7,"big":12345678901234567890,"nothing":null,"yes":true,"no":false,"empty":"","list":["x",3,false]}'
run_hook "$(input '"plan"' "$RICH")"
if check 'import json
want = json.loads(args[0])
got = json.loads(out)["hookSpecificOutput"]["updatedInput"]
mode = got.pop("sessionMode")
sys.exit(0 if mode == "plan" and got == want and list(got) == list(want) else 1)' "$RICH"; then ok keeps-every-other-key; else bad "keeps-every-other-key (got: $(head -c 400 "$T/out"))"; fi

run_hook "$(input '"plan"' '{"prompt":"p","sessionMode":"bypassPermissions"}')"
if check 'import json
got = json.loads(out)["hookSpecificOutput"]["updatedInput"]
sys.exit(0 if got == {"prompt": "p", "sessionMode": "plan"} and out.count("sessionMode") == 1 else 1)'; then ok overwrites-a-forged-sessionMode; else bad "overwrites-a-forged-sessionMode (got: $(head -c 300 "$T/out"))"; fi

BIG=$(python3 -I -c 'import json; print(json.dumps({"prompt": "x" * 2000000}))')
run_hook "$(input '"auto"' "$BIG")"
if check 'import json
got = json.loads(out)["hookSpecificOutput"]["updatedInput"]
sys.exit(0 if len(got["prompt"]) == 2000000 and got["sessionMode"] == "auto" else 1)'; then ok keeps-a-large-prompt; else bad keeps-a-large-prompt; fi

# A lone surrogate escape is valid JSON text. The hook must still answer, or a prompt could switch the injection off.
run_hook "$(input '"auto"' '{"prompt":"a \ud800 b"}')"
if [ "$(cat "$T/code")" = 0 ] && check 'import json
got = json.loads(out)["hookSpecificOutput"]["updatedInput"]
sys.exit(0 if got["prompt"] == "a \ud800 b" and got["sessionMode"] == "auto" else 1)'; then ok answers-a-lone-surrogate; else bad "answers-a-lone-surrogate (got: $(head -c 300 "$T/out"))"; fi

# The key is absent: the model's own sessionMode is removed, so the server falls back to the config alone.
FORGED='{"target":"codex","sessionMode":"bypassPermissions","prompt":"p"}'
strips() { # name hook_input_text
  run_hook "$2"
  if [ "$(cat "$T/code")" = 0 ] && [ ! -s "$T/err" ] && check 'import json
want = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {"target": "codex", "prompt": "p"}}}
sys.exit(0 if json.loads(out) == want and "sessionMode" not in out else 1)'; then ok "$1"; else bad "$1 (exit $(cat "$T/code"), out: $(head -c 300 "$T/out"), err: $(head -c 200 "$T/err"))"; fi
}
strips strips-a-forged-sessionMode-without-permission_mode "{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"x\",\"tool_input\":$FORGED}"
run_hook "{\"tool_input\":{\"prompt\":\"p\"}}"
if [ "$(cat "$T/code")" = 0 ] && check 'import json
sys.exit(0 if json.loads(out)["hookSpecificOutput"]["updatedInput"] == {"prompt": "p"} else 1)'; then ok leaves-an-input-without-sessionMode-as-it-is; else bad leaves-an-input-without-sessionMode-as-it-is; fi

# The hook cannot read its input: exit 2 blocks the call, and a one-line reason goes to stderr.
blocked() { # name hook_input_text
  run_hook "$2"
  if [ "$(cat "$T/code")" = 2 ] && [ ! -s "$T/out" ] && [ "$(wc -l < "$T/err")" = 1 ] && grep -q '^cc-orq: ' "$T/err"; then ok "$1"; else bad "$1 (exit $(cat "$T/code"), out: $(head -c 200 "$T/out"), err: $(head -c 200 "$T/err"))"; fi
}
# permission_mode is present but not a usable mode: the session's limit would be lost, so the call is blocked.
blocked blocks-an-empty-permission_mode "{\"permission_mode\":\"\",\"tool_input\":$FORGED}"
for value in null 7 0 1.5 true false '{"mode":"auto"}' '["auto"]'; do
  blocked "blocks-when-permission_mode-is-$(printf '%s' "$value" | tr -c 'A-Za-z0-9' '_')" "{\"permission_mode\":$value,\"tool_input\":$FORGED}"
done
run_hook "{\"permission_mode\":null,\"tool_input\":$FORGED}"
if grep -q 'permission_mode is empty or not text' "$T/err"; then ok names-permission_mode-in-the-reason; else bad "names-permission_mode-in-the-reason (err: $(head -c 200 "$T/err"))"; fi

blocked blocks-empty-input ''
blocked blocks-text-that-is-not-json 'this is not JSON'
blocked blocks-a-json-array '[1,2]'
blocked blocks-a-json-string '"auto"'
blocked blocks-a-json-number '7'
blocked blocks-without-tool_input '{"permission_mode":"auto"}'
blocked blocks-null-tool_input '{"permission_mode":"auto","tool_input":null}'
blocked blocks-array-tool_input '{"permission_mode":"auto","tool_input":[1]}'
blocked blocks-text-tool_input '{"permission_mode":"auto","tool_input":"p"}'
blocked blocks-truncated-json '{"permission_mode":"auto","tool_input":{"prompt":"p"'
blocked blocks-a-number-the-output-could-not-carry '{"permission_mode":"auto","tool_input":{"limit":NaN}}'
blocked blocks-input-nested-too-deep "$(python3 -I -c 'print("[" * 200000)')"
printf '\xff\xfe{"permission_mode":"auto"}' > "$T/bad-bytes"
set +e; bash "$HOOK" < "$T/bad-bytes" > "$T/out" 2> "$T/err"; code=$?; set -e
no_decision "the run on bytes that are not UTF-8"
if [ "$code" = 2 ] && [ ! -s "$T/out" ] && grep -q '^cc-orq: ' "$T/err"; then ok blocks-bytes-that-are-not-utf-8; else bad "blocks-bytes-that-are-not-utf-8 (exit $code)"; fi

# The hook reads at most 8 MiB. Exactly that much valid JSON is read, and one byte more is refused before it is parsed.
python3 -I -c 'import sys
head = b"{\"permission_mode\":\"auto\",\"tool_input\":{\"prompt\":\""
tail = b"\"}}"
sys.stdout.buffer.write(head + b"x" * (8 * 1024 * 1024 - len(head) - len(tail)) + tail)' > "$T/exact-8-mib.json"
set +e; bash "$HOOK" < "$T/exact-8-mib.json" > "$T/out" 2> "$T/err"; echo $? > "$T/code"; set -e
no_decision "the run on exactly 8 MiB"
if [ "$(wc -c < "$T/exact-8-mib.json")" = 8388608 ] && [ "$(cat "$T/code")" = 0 ] && check 'import json
got = json.loads(out)["hookSpecificOutput"]["updatedInput"]
sys.exit(0 if len(got["prompt"]) > 8000000 and got["sessionMode"] == "auto" else 1)'; then ok reads-exactly-8-MiB; else bad "reads-exactly-8-MiB (exit $(cat "$T/code"))"; fi
printf ' ' >> "$T/exact-8-mib.json"
set +e; bash "$HOOK" < "$T/exact-8-mib.json" > "$T/out" 2> "$T/err"; echo $? > "$T/code"; set -e
no_decision "the run on 8 MiB and a byte"
if [ "$(cat "$T/code")" = 2 ] && [ ! -s "$T/out" ] && [ "$(wc -l < "$T/err")" = 1 ] && grep -q 'the input is over 8 MiB' "$T/err"; then ok blocks-8-MiB-and-a-byte; else bad "blocks-8-MiB-and-a-byte (exit $(cat "$T/code"), err: $(head -c 200 "$T/err"))"; fi
set +e; head -c 20000000 /dev/zero | bash "$HOOK" > "$T/out" 2> "$T/err"; echo $? > "$T/code"; set -e
no_decision "the run on 20 MB of zeros"
if [ "$(cat "$T/code")" = 2 ] && [ ! -s "$T/out" ] && grep -q 'the input is over 8 MiB' "$T/err"; then ok blocks-20-MB-without-reading-it-all; else bad "blocks-20-MB-without-reading-it-all (exit $(cat "$T/code"))"; fi

# bash is given by its path, because the PATH this run gives the hook holds nothing.
mkdir -p "$T/empty-path"
set +e; printf '%s' "$(input '"auto"' "$PLAIN")" | env PATH="$T/empty-path" "$BASH_BIN" "$HOOK" > "$T/out" 2> "$T/err"; code=$?; set -e
no_decision "the run without python3"
if [ "$code" = 2 ] && [ ! -s "$T/out" ] && [ "$(cat "$T/err")" = "cc-orq: python3 is required to read the session's permission mode" ]; then ok blocks-without-python3; else bad "blocks-without-python3 (exit $code, err: $(head -c 200 "$T/err"))"; fi

# Any other failure of python3 must block too: exit 1 would be a non-blocking error, and the call would go through.
mkdir -p "$T/broken-bin"
printf '#!/bin/sh\necho "python3: fake failure" >&2\nexit 1\n' > "$T/broken-bin/python3"
chmod +x "$T/broken-bin/python3"
set +e; printf '%s' "$(input '"auto"' "$PLAIN")" | PATH="$T/broken-bin:$PATH" bash "$HOOK" > "$T/out" 2> "$T/err"; code=$?; set -e
no_decision "the run with a broken python3"
if [ "$code" = 2 ] && [ ! -s "$T/out" ] && grep -q 'python3 exited 1 while reading' "$T/err"; then ok blocks-when-python3-fails; else bad "blocks-when-python3-fails (exit $code, err: $(head -c 200 "$T/err"))"; fi

# A json.py planted on PYTHONPATH or in the working directory must never be imported.
mkdir -p "$T/planted"
printf 'import os\nopen(os.environ["PLANT_MARKER"], "w").write("loaded")\nraise SystemExit(3)\n' > "$T/planted/json.py"
rm -f "$T/marker"
set +e
(cd "$T/planted" && printf '%s' "$(input '"auto"' "$PLAIN")" | PLANT_MARKER="$T/marker" PYTHONPATH="$T/planted" bash "$HOOK" > "$T/out" 2> "$T/err")
code=$?
set -e
if [ "$code" = 0 ] && [ ! -e "$T/marker" ] && check 'import json
sys.exit(0 if json.loads(out)["hookSpecificOutput"]["updatedInput"]["sessionMode"] == "auto" else 1)'; then ok runs-python-isolated; else bad "runs-python-isolated (exit $code, planted module loaded: $([ -e "$T/marker" ] && echo yes || echo no))"; fi

start=$(date +%s%N)
for _ in 1 2 3 4 5; do printf '%s' "$(input '"auto"' "$PLAIN")" | bash "$HOOK" > /dev/null; done
elapsed_ms=$(( ($(date +%s%N) - start) / 5000000 ))
if [ "$elapsed_ms" -lt 500 ]; then ok "runs-quickly (${elapsed_ms} ms a run)"; else bad "runs-quickly (${elapsed_ms} ms a run)"; fi

wait "$STALL_RUN"
kill "$STALL_WRITER" 2>/dev/null || true
STALL_WRITER=
seconds=$(cat "$T/stall-seconds")
cp "$T/stall-out" "$T/out"; cp "$T/stall-err" "$T/err"
no_decision "the run on a stdin that never ends"
if [ "$(cat "$T/stall-code")" = 2 ] && [ ! -s "$T/stall-out" ] && [ "$(wc -l < "$T/stall-err")" = 1 ] && grep -q 'it did not finish within 20 s' "$T/stall-err" && [ "$seconds" -ge 19 ] && [ "$seconds" -le 27 ]; then ok "gives-up-on-a-stalled-input-after-20-s (${seconds} s)"; else bad "gives-up-on-a-stalled-input-after-20-s (exit $(cat "$T/stall-code"), ${seconds} s, err: $(head -c 200 "$T/stall-err"))"; fi

if [ "$DECISIONS" -eq 0 ]; then ok "never-prints-a-permission-decision (in $RUNS runs of every branch)"; fi

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
