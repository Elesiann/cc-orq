#!/usr/bin/env bash
# question-parent: a worker asks a question, its task ends BLOCKED, and the answer tool resumes the same worker.
#
# Needs a logged-in claude CLI as the worker and costs a few cents. Proves, in an interactive session with the mods on:
#   - a worker that was allowed to go above the ceiling in the approval form stops on a question, and its task ends with
#     the BLOCKED text, which names the answer tool;
#   - the session calls answer with the id in that text, and a continuation job starts: its child.log shows the resume
#     argv with the session id the first job recorded, its meta.json names the first job as its parent and has the same
#     branch, and the worker's final message repeats what the answer said;
#   - the answer needed no second form, since the server's task record for the first job holds the user's approval for
#     this worker at this level.
# The worker runs at full-access, since a worker below auto cannot write its question outside its directory. The Claude
# worker runs with the same isolation flags as the nested session, through a claude wrapper in the scratch directory.
#
# Environment: ORQ_TASKS_CLAUDE_MODEL (default haiku). Receipts: approval-form.txt, after-answer.txt, jobs.txt, debug.log.
set -euo pipefail
# shellcheck source=../lib.sh disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

live_setup
EX=${ORQ_EVIDENCE:?}
DELEGATE=mcp__plugin_cc-orq_orq__delegate
ANSWER=mcp__plugin_cc-orq_orq__answer
CLAUDE_MODEL=${ORQ_TASKS_CLAUDE_MODEL:-haiku}
STAMP="$(date +%s)-$RANDOM"
NONCE_Q="ORQ-ASK-$STAMP"
NONCE_A="ORQ-ANSWER-$STAMP"

CONFIG=$HOME/.config/orq/config.json
JOBS_DIR=$HOME/.cache/orq/jobs
if [ -f "$CONFIG" ]; then
  configured=$(jq -r '.jobsDir // empty' "$CONFIG")
  [ -z "$configured" ] || JOBS_DIR=${configured/#\~/$HOME}
  allowed=$(jq -r '.ceiling.runtime // "auto-accept-edits"' "$CONFIG")
  [ "$allowed" != full-access ] || live_fail "the ceiling.runtime of $CONFIG is full-access, so the worker needs no form and none would open"
fi

WRAP=$LIVE_WORK/bin
mkdir -p "$WRAP"
printf '#!/bin/bash\nexec %q --setting-sources project --settings %q "$@"\n' "$CLAUDE_BIN" "$(live_settings off)" > "$WRAP/claude"
chmod +x "$WRAP/claude"
export PATH="$WRAP:$PATH"

cat > "$EX/prompt.txt" << EOF
Do this now, in order, and call no other tool.
1. Call $DELEGATE once, with these fields and no others: target "claudeAgent", model "$CLAUDE_MODEL", cwd "$LIVE_REPO", runtime "full-access", prompt "Deploy the app in this repository. Nothing here says which environment to deploy to, staging or production, and you must not guess. Marker: $NONCE_Q."
2. End your turn and wait: the result arrives by itself, so do not poll.
3. When it arrives and starts with BLOCKED on a question, call $ANSWER once with taskId set to the id that the BLOCKED text names, and answer "Production. Do not use any tool. Reply with exactly one line: DEPLOY: $NONCE_A". Then end your turn and wait again.
4. When that result arrives, reply with one line: GOT followed by the first line of the result.
EOF

SESSION="${ORQ_LIVE_TMUX_PREFIX}-qparent-$$"
live_tmux_start "$SESSION" on "$EX/debug.log" "$DELEGATE" "$ANSWER" || live_fail "could not start the interactive session"
live_tmux_wait_ready "$SESSION" || live_fail "the interactive session did not take input"

capture() {
  live_tmux_capture "$SESSION" "$EX/$1"
}
key() {
  live_tmux send-keys -t "=$SESSION:" "$@"
}

live_tmux_send "$SESSION" "$(cat "$EX/prompt.txt")"
if ! live_tmux_wait "$SESSION" 'more than your ceiling' 120; then
  capture failed-form.txt
  live_fail "no approval form opened for the full-access worker (see failed-form.txt)"
fi
sleep 1
capture approval-form.txt
key Down
sleep 1
key Enter

if ! live_tmux_wait "$SESSION" "GOT DEPLOY: $NONCE_A" 300; then
  capture failed-answer.txt
  live_fail "the session never reported the result of the resumed worker (see failed-answer.txt)"
fi
capture after-answer.txt

first_prompt=$(grep -l "$NONCE_Q" "$JOBS_DIR"/*/prompt.txt 2> /dev/null | head -n 1 || true)
[ -n "$first_prompt" ] || live_fail "no job in $JOBS_DIR carries the prompt of the first task"
first=$(dirname "$first_prompt")
second_prompt=$(grep -l "$NONCE_A" "$JOBS_DIR"/*/prompt.txt 2> /dev/null | head -n 1 || true)
[ -n "$second_prompt" ] || live_fail "no job in $JOBS_DIR carries the answer"
second=$(dirname "$second_prompt")
[ "$first" != "$second" ] || live_fail "the answer ran in the job that asked"
first_id=$(basename "$first")
second_id=$(basename "$second")
recorded=$(tr -d '\n' < "$first/session")

{
  printf 'first job %s\n' "$first_id"
  jq -c '{kind, instanceId, model, runtimeMode, branch, worktree, cwd}' "$first/meta.json"
  printf 'question: %s\n' "$(head -c 300 "$first/question.txt")"
  printf 'session recorded: %s\n' "$recorded"
  printf 'next: %s\n' "$(cat "$first/next")"
  printf '\nsecond job %s\n' "$second_id"
  jq -c '{kind, parent, instanceId, model, runtimeMode, branch, worktree, cwd}' "$second/meta.json"
  printf 'flags: %s\n' "$(tr '\n' ' ' < "$second/flags")"
  printf 'resume: %s\n' "$(cat "$second/resume")"
  printf 'session recorded: %s\n' "$(cat "$second/session")"
  printf 'child.log:\n%s\n' "$(cat "$second/child.log")"
  printf 'last.txt: %s\n' "$(head -c 300 "$second/last.txt")"
  printf '\ntask records: %s | %s\n' "$(find "$JOBS_DIR/.tasks/$first_id" -type f -printf '%f ')" "$(find "$JOBS_DIR/.tasks/$second_id" -type f -printf '%f ')"
} > "$EX/jobs.txt"

[ "$(cat "$first/exit")" = 0 ] || live_fail "the first job did not exit 0"
[ -s "$first/question.txt" ] || live_fail "the first job left no question"
[ -n "$recorded" ] || live_fail "the supervisor recorded no session for the first job"
[ "$(jq -r '.parent' "$second/meta.json")" = "$first_id" ] || live_fail "the continuation does not name the first job as its parent"
[ "$(jq -r '.branch' "$first/meta.json")" = "$(jq -r '.branch' "$second/meta.json")" ] || live_fail "the two jobs are not on the same branch"
[ "$(jq -r '.branch' "$first/meta.json")" != null ] || live_fail "the first job has no branch"
grep -qF "orq: resume: claude -p --resume $recorded " "$second/child.log" || live_fail "child.log of the continuation does not show the resume argv with the recorded session id"
[ "$(cat "$second/resume")" = "$recorded" ] || live_fail "the resume file does not hold the recorded session id"
grep -qF "$NONCE_A" "$second/last.txt" || live_fail "the final message of the resumed worker does not repeat the answer"
[ "$(jq -r '.tool' "$JOBS_DIR/.tasks/$second_id/task.json")" = answer ] || live_fail "the continuation has no task record of the answer tool"

live_tmux_exit "$SESSION"

# Claude Code writes its memory lines only in an interactive session, so the excluded-CLAUDE.md check reads this log.
live_assert_no_memory_loaded "$EX/debug.log" "$EX/memory-lines.txt"
