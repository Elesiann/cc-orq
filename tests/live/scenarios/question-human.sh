#!/usr/bin/env bash
# question-human: with questions human, the worker's question opens a form and the answer resumes the worker in the same task.
#
# Needs a logged-in claude CLI as the worker and costs a few cents. Proves, in an interactive session with the mods on:
#   - a worker started with questions human, at full-access through the approval form, stops on a question, and the
#     task shows the question in a form instead of ending (question-form.txt is the screen as text);
#   - the answer typed into the form resumes the same worker: its job names the first as its parent, has the same branch,
#     and child.log shows the resume argv with the session id the first job recorded; the next file of the first job says
#     the answer came from the form, and the continuation has no task record of its own;
#   - the worker's final message repeats the answer, and the session wakes with it.
# The Claude worker runs with the same isolation flags as the nested session, through a claude wrapper in the scratch directory.
#
# Environment: ORQ_TASKS_CLAUDE_MODEL (default haiku). Receipts: approval-form.txt, question-form.txt,
# question-form-typed.txt, after-answer.txt, jobs.txt, debug.log.
set -euo pipefail
# shellcheck source=../lib.sh disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

live_setup
EX=${ORQ_EVIDENCE:?}
DELEGATE=mcp__plugin_cc-orq_orq__delegate
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
Do this now and call no other tool. Call $DELEGATE once, with these fields and no others: target "claudeAgent", model "$CLAUDE_MODEL", cwd "$LIVE_REPO", runtime "full-access", questions "human", prompt "Deploy the app in this repository. Nothing here says which environment to deploy to, staging or production, and you must not guess. Marker: $NONCE_Q." Then end your turn and wait: the result arrives by itself, so do not poll. When it arrives, reply with one line: GOT followed by the first line of the result.
EOF

SESSION="${ORQ_LIVE_TMUX_PREFIX}-qhuman-$$"
live_tmux_start "$SESSION" on "$EX/debug.log" "$DELEGATE" || live_fail "could not start the interactive session"
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

if ! live_tmux_wait "$SESSION" 'claudeAgent · haiku asks:' 240; then
  capture failed-question-form.txt
  live_fail "the question form never opened (see failed-question-form.txt)"
fi
sleep 1
capture question-form.txt
grep -qF 'Which environment' "$EX/question-form.txt" || live_fail "the question form does not show the worker's question (see question-form.txt)"
if grep -q 'more line' "$EX/question-form.txt"; then
  live_fail "Claude Code collapsed part of the question form (see question-form.txt)"
fi
key -l "Production. Do not use any tool. Reply with exactly one line: DEPLOY: $NONCE_A"
sleep 1
capture question-form-typed.txt
key Enter
sleep 1
key Enter

if ! live_tmux_wait "$SESSION" "GOT DEPLOY: $NONCE_A" 300; then
  capture failed-answer.txt
  live_fail "the session never reported the result of the resumed worker (see failed-answer.txt)"
fi
capture after-answer.txt

first_prompt=$(grep -l "$NONCE_Q" "$JOBS_DIR"/*/prompt.txt 2> /dev/null | head -n 1 || true)
[ -n "$first_prompt" ] || live_fail "no job in $JOBS_DIR carries the prompt of the task"
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
  jq -c '{kind, questions, instanceId, model, runtimeMode, branch, worktree, cwd}' "$first/meta.json"
  printf 'question: %s\n' "$(head -c 300 "$first/question.txt")"
  printf 'session recorded: %s\n' "$recorded"
  printf 'next: %s\n' "$(cat "$first/next")"
  printf '\nsecond job %s\n' "$second_id"
  jq -c '{kind, questions, parent, instanceId, model, runtimeMode, branch, worktree, cwd}' "$second/meta.json"
  printf 'flags: %s\n' "$(tr '\n' ' ' < "$second/flags")"
  printf 'resume: %s\n' "$(cat "$second/resume")"
  printf 'child.log:\n%s\n' "$(cat "$second/child.log")"
  printf 'last.txt: %s\n' "$(head -c 300 "$second/last.txt")"
  printf '\ntask records of the first job: %s\n' "$(find "$JOBS_DIR/.tasks/$first_id" -type f -printf '%f ')"
  printf 'task record of the second job: %s\n' "$([ -e "$JOBS_DIR/.tasks/$second_id" ] && echo present || echo none)"
} > "$EX/jobs.txt"

[ "$(cat "$first/exit")" = 0 ] || live_fail "the first job did not exit 0"
[ "$(jq -r '.questions' "$first/meta.json")" = human ] || live_fail "the first job does not record questions human"
[ -s "$first/question.txt" ] || live_fail "the first job left no question"
[ -n "$recorded" ] || live_fail "the supervisor recorded no session for the first job"
[ "$(jq -c '[.via, .jobId]' "$first/next")" = "[\"form\",\"$second_id\"]" ] || live_fail "the next file of the first job does not name the continuation, answered by the form"
[ "$(jq -r '.parent' "$second/meta.json")" = "$first_id" ] || live_fail "the continuation does not name the first job as its parent"
[ "$(jq -r '.branch' "$first/meta.json")" = "$(jq -r '.branch' "$second/meta.json")" ] || live_fail "the two jobs are not on the same branch"
[ "$(jq -r '.branch' "$first/meta.json")" != null ] || live_fail "the first job has no branch"
grep -qF "orq: resume: claude -p --resume $recorded " "$second/child.log" || live_fail "child.log of the continuation does not show the resume argv with the recorded session id"
grep -qF "$NONCE_A" "$second/last.txt" || live_fail "the final message of the resumed worker does not repeat the answer"
[ ! -e "$JOBS_DIR/.tasks/$second_id" ] || live_fail "the answer through the form made a task of its own"

live_tmux_exit "$SESSION"

# Claude Code writes its memory lines only in an interactive session, so the excluded-CLAUDE.md check reads this log.
live_assert_no_memory_loaded "$EX/debug.log" "$EX/memory-lines.txt"
