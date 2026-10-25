#!/usr/bin/env bash
# tasks: delegate returns MCP tasks, and a request above the ceiling asks for approval.
#
# Needs a logged-in codex CLI and a logged-in claude CLI as workers, and costs a few cents. Proves, in an
# interactive session with the mods on:
#   - two delegate calls, one to Codex and one to Claude, become two background tasks that run at once and that
#     /tasks lists, each with its detail;
#   - the session wakes by itself for each result, and each result carries the text that its worker wrote;
#   - a request above the ceiling opens the approval form, which shows the level and the place without being
#     expanded, and accepting it starts the job at the level that was asked, with the task record beside the job.
# The Claude worker runs with the same isolation flags as the nested session, through a claude wrapper in the
# scratch directory, so the hooks and connectors of the user stay out of it.
#
# Environment: ORQ_TASKS_CODEX_MODEL (default gpt-6-luna), ORQ_TASKS_CLAUDE_MODEL (default haiku). Receipts:
# tasks-list.txt, tasks-detail-1.txt, tasks-detail-2.txt, approval-form.txt, after-wake.txt, after-approval.txt,
# debug.log, jobs.txt.
set -euo pipefail
# shellcheck source=../lib.sh disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

live_setup
EX=${ORQ_EVIDENCE:?}
DELEGATE=mcp__plugin_cc-orq_orq__delegate
CODEX_MODEL=${ORQ_TASKS_CODEX_MODEL:-gpt-6-luna}
CLAUDE_MODEL=${ORQ_TASKS_CLAUDE_MODEL:-haiku}
STAMP="$(date +%s)-$RANDOM"
NONCE_A="ORQ-CODEX-$STAMP"
NONCE_B="ORQ-CLAUDE-$STAMP"
NONCE_C="ORQ-FORM-$STAMP"

CONFIG=$HOME/.config/orq/config.json
JOBS_DIR=$HOME/.cache/orq/jobs
if [ -f "$CONFIG" ]; then
  configured=$(jq -r '.jobsDir // empty' "$CONFIG")
  [ -z "$configured" ] || JOBS_DIR=${configured/#\~/$HOME}
  allowed=$(jq -r '.ceiling.runtime // "auto-accept-edits"' "$CONFIG")
  case $allowed in
    auto | full-access) live_fail "the ceiling.runtime of $CONFIG is $allowed, so auto-accept-edits is not above it and no form would open" ;;
  esac
fi

WRAP=$LIVE_WORK/bin
mkdir -p "$WRAP"
printf '#!/bin/bash\nexec %q --setting-sources project --settings %q "$@"\n' "$CLAUDE_BIN" "$(live_settings off)" > "$WRAP/claude"
chmod +x "$WRAP/claude"
export PATH="$WRAP:$PATH"

cat > "$EX/prompt-fanout.txt" << EOF
Do this now and call no other tool. In ONE message, call $DELEGATE twice, as two parallel calls, with these fields and no others.
Call A: target "codex", model "$CODEX_MODEL", cwd "$LIVE_REPO", prompt "Write the numbers from 1 to 2000, one per line, and then a last line with exactly this text: $NONCE_A. Do not use any tool."
Call B: target "claudeAgent", model "$CLAUDE_MODEL", cwd "$LIVE_REPO", prompt "Write the numbers from 1 to 2000, one per line, and then a last line with exactly this text: $NONCE_B. Do not use any tool."
Then end your turn and wait: each result arrives by itself, so do not poll. When a result arrives, reply with one line, GOT followed by the line of the result that starts with ORQ-.
EOF
cat > "$EX/prompt-form.txt" << EOF
Call $DELEGATE once, with these fields and no others: target "claudeAgent", model "$CLAUDE_MODEL", cwd "$LIVE_REPO", runtime "auto-accept-edits", prompt "Reply with exactly this text and nothing else: $NONCE_C. Do not use any tool." Then end your turn and wait for the result. When it arrives, reply with one line, GOT followed by the line of the result that starts with ORQ-.
EOF

SESSION="${ORQ_LIVE_TMUX_PREFIX}-tasks-$$"
live_tmux_start "$SESSION" on "$EX/debug.log" "$DELEGATE" || live_fail "could not start the interactive session"
live_tmux_wait_ready "$SESSION" || live_fail "the interactive session did not take input"

capture() {
  live_tmux_capture "$SESSION" "$EX/$1"
}
key() {
  live_tmux send-keys -t "=$SESSION:" "$@"
}
# An Escape that reaches the prompt after the panel is closed interrupts the turn that the queued notifications start,
# so Escape goes only to a screen that still says it closes or goes back.
close_panel() {
  local _
  for _ in 1 2 3 4; do
    capture panel-state.txt
    grep -qE 'Esc to (close|go back)' "$EX/panel-state.txt" || return 0
    key Escape
    sleep 1
  done
}

live_tmux_send "$SESSION" "$(cat "$EX/prompt-fanout.txt")"
if ! live_tmux_wait "$SESSION" '2 MCP tasks' 120; then
  capture failed-fanout.txt
  live_fail "the footer never showed 2 MCP tasks after two delegate calls (see failed-fanout.txt)"
fi

# Each worker has a last action once its CLI has started, which takes a few seconds, and 2000 lines take longer.
sleep 3
live_tmux_send "$SESSION" '/tasks'
sleep 3
capture tasks-list.txt
if grep -q 'No tasks currently running' "$EX/tasks-list.txt"; then
  live_fail "/tasks listed no task while both workers should still run (see tasks-list.txt)"
fi
key Enter
sleep 2
capture tasks-detail-1.txt
key Escape
sleep 1
capture panel-state.txt
if grep -q 'Esc to close' "$EX/panel-state.txt"; then
  key Down
  sleep 1
  key Enter
  sleep 2
  capture tasks-detail-2.txt
fi
close_panel

live_tmux_wait "$SESSION" "GOT.*$NONCE_A" 180 || {
  capture failed-wake.txt
  live_fail "the session did not wake with the Codex result (see failed-wake.txt)"
}
live_tmux_wait "$SESSION" "GOT.*$NONCE_B" 120 || {
  capture failed-wake.txt
  live_fail "the session did not wake with the Claude result (see failed-wake.txt)"
}
capture after-wake.txt

turns=$(grep -o 'cc_turn_origin=task_notification; cc_prompt_index=[0-9]*; cc_turn_index=[0-9]*' "$EX/debug.log" | sort -u | wc -l)
printf '%s\n' "$turns" > "$EX/task-notification-turns.txt"
[ "$turns" -ge 1 ] || live_fail "the debug log has no turn that a task notification started"

live_tmux_send "$SESSION" "$(cat "$EX/prompt-form.txt")"
if ! live_tmux_wait "$SESSION" 'more than your ceiling' 90; then
  capture failed-form.txt
  live_fail "no approval form opened for a request above the ceiling (see failed-form.txt)"
fi
sleep 1
capture approval-form.txt
for shown in 'A task asks for more than your ceiling allows: runtime auto-accept-edits' 'It runs in its own worktree' 'Worker "claudeAgent", model "haiku"'; do
  grep -qF "$shown" "$EX/approval-form.txt" || live_fail "the form does not show '$shown' without being expanded (see approval-form.txt)"
done
if grep -q 'more line' "$EX/approval-form.txt"; then
  live_fail "Claude Code collapsed part of the form message (see approval-form.txt)"
fi
key Down
sleep 1
key Enter
live_tmux_wait "$SESSION" "GOT.*$NONCE_C" 150 || {
  capture failed-approval.txt
  live_fail "the session did not wake with the result of the approved task (see failed-approval.txt)"
}
capture after-approval.txt

job=$(grep -l "$NONCE_C" "$JOBS_DIR"/*/prompt.txt 2> /dev/null | head -n 1 || true)
[ -n "$job" ] || live_fail "no job in $JOBS_DIR carries the prompt of the approved task"
dir=$(dirname "$job")
id=$(basename "$dir")
{
  printf 'job %s\n' "$id"
  jq -c '{kind, instanceId, model, runtimeMode, interactionMode, branch}' "$dir/meta.json"
  printf 'flags: %s\n' "$(tr '\n' ' ' < "$dir/flags")"
  ls "$JOBS_DIR/.tasks/$id"
} > "$EX/jobs.txt"
[ "$(jq -r '.runtimeMode' "$dir/meta.json")" = auto-accept-edits ] || live_fail "the approved job did not run at the level that was asked"
[ "$(tr '\n' ' ' < "$dir/flags")" = '--permission-mode acceptEdits ' ] || live_fail "the approved job's flags are not those of auto-accept-edits"
[ -f "$JOBS_DIR/.tasks/$id/approved" ] || live_fail "the task record has no approved marker"

live_tmux_exit "$SESSION"

# Claude Code writes its memory lines only in an interactive session, so the excluded-CLAUDE.md check reads this log.
live_assert_no_memory_loaded "$EX/debug.log" "$EX/memory-lines.txt"
