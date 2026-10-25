#!/bin/bash
# question shell suite: a child that asks its parent a question through the job protocol. This runs
# scripts/supervise.sh with a fake CLI and runs opencode/tools/orq_ask.ts against a stub plugin package.
# The start script sets ORQ_JOB_DIR, not supervise.sh, so this suite exports it the same way before it
# calls the supervisor. The claude plugin test kit cannot run scripts, so this suite is the real check.
#
# Usage: bash tests/question-shell.sh
set -e -o pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
T="$ROOT/.ref/tmp/question-shell-$(date +%s)-$$"
BIN="$T/bin"; WORK="$T/work"
mkdir -p "$BIN" "$WORK"
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0

ok() { PASS=$((PASS+1)); echo "ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
expect_file() {
  if [ "$(cat "$1")" = "$2" ]; then ok "$3"; else bad "$3 (got: $(head -c 200 "$1"))"; fi
}

# The fake CLI asks through the protocol: it writes question.txt in the job directory, prints the result
# event with BLOCKED as its final message, and exits 0.
cat > "$BIN/claude" <<'FAKE'
#!/bin/bash
printf '%s' 'Which database should the migration target?' > "$ORQ_JOB_DIR/question.txt"
printf '{"type":"system","subtype":"init","session_id":"ses-fake"}\n'
printf '{"type":"result","subtype":"success","is_error":false,"session_id":"ses-fake","result":"BLOCKED: Which database should the migration target?","usage":{"input_tokens":11,"output_tokens":4},"modelUsage":{"fake-claude-model":{}}}\n'
exit 0
FAKE
chmod +x "$BIN/claude"
export PATH="$BIN:$PATH"

# macOS has no timeout; Linux keeps its own.
command -v timeout >/dev/null 2>&1 || timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }

JOB="$T/job-asked"
mkdir -p "$JOB"
printf '%s' 'Migrate the schema.' > "$JOB/prompt.txt"
ORQ_JOB_DIR="$JOB" timeout 60 bash "$ROOT/scripts/supervise.sh" "$JOB" claude "$WORK" fake-model '' ''

expect_file "$JOB/question.txt" 'Which database should the migration target?' question-file-literal
expect_file "$JOB/last.txt" 'BLOCKED: Which database should the migration target?' blocked-final-message
expect_file "$JOB/exit" 0 question-exit-zero

extracted=$(python3 "$ROOT/scripts/extract.py" "$JOB/events.jsonl" claude)
want='{"tid": "ses-fake", "in": 11, "out": 4, "error": false, "model": "fake-claude-model"}'
if [ "$extracted" = "$want" ]; then ok question-extract-coherent; else bad "question-extract-coherent (got: $extracted)"; fi

# orq_ask runs under OpenCode, which is not installed here. A stub @opencode-ai/plugin provides the tool()
# helper and the string schema, so the real execute() runs against a real job directory.
TOOLS="$T/tools"
mkdir -p "$TOOLS" "$T/node_modules/@opencode-ai/plugin"
cp "$ROOT/opencode/tools/orq_ask.ts" "$TOOLS/orq_ask.ts"
cat > "$T/node_modules/@opencode-ai/plugin/index.js" <<'STUB'
const chain = { min: () => chain, describe: () => chain }
export function tool(definition) { return definition }
tool.schema = { string: () => chain }
STUB
cat > "$T/drive.mjs" <<'DRIVE'
import { pathToFileURL } from 'node:url'
const { default: tool } = await import(pathToFileURL(process.argv[2]).href)
process.stdout.write(`${(await tool.execute({ question: process.argv[3] })).output}\n`)
DRIVE

# Run from an empty directory: a tool that fell back to a relative path would leave question.txt there.
UNSET_CWD="$T/unset-cwd"
mkdir -p "$UNSET_CWD"
unset_out=$(cd "$UNSET_CWD" && env -u ORQ_JOB_DIR node "$T/drive.mjs" "$TOOLS/orq_ask.ts" 'Which database?')
case "$unset_out" in *'ORQ_JOB_DIR is not set'*'BLOCKED:'*) ok orq_ask-refuses-without-job-dir ;; *) bad "orq_ask-refuses-without-job-dir (got: $unset_out)" ;; esac
if [ -z "$(ls -A "$UNSET_CWD")" ]; then ok orq_ask-writes-nothing-without-job-dir; else bad "orq_ask-writes-nothing-without-job-dir (left: $(ls -A "$UNSET_CWD"))"; fi

ASK_JOB="$T/job-tool"
mkdir -p "$ASK_JOB"

tool_out=$(ORQ_JOB_DIR="$ASK_JOB" node "$T/drive.mjs" "$TOOLS/orq_ask.ts" '  Which database should the migration target?  ')
case "$tool_out" in *'Question recorded'*'BLOCKED:'*) ok orq_ask-answers-with-blocked ;; *) bad "orq_ask-answers-with-blocked (got: $tool_out)" ;; esac
expect_file "$ASK_JOB/question.txt" 'Which database should the migration target?' orq_ask-writes-trimmed-question

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
