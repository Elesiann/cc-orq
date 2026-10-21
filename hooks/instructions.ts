// Adapted from T3 Code's orchestration instructions (MIT); NOTICE names the source.

export const ORCHESTRATION_INSTRUCTIONS = `## orq orchestration

Delegate self-contained work to other provider CLIs (Codex, OpenCode, Antigravity, Claude) through background \`cc-orq:task\` agents. Each one runs as a detached job and returns its final answer when it ends. A waiting parent spends no model tokens.

- Read \`mcp__cc-orq__capabilities\` before you name a target. It lists each provider instance, its live models, each model's options and allowed values, and its constraints. Do not guess model ids.
- Spawn the Agent tool with \`subagent_type: "cc-orq:task"\` and \`run_in_background: true\`. The child gets no history, so the prompt carries the whole brief. Its first lines are a header, in any order: \`target: <instance> <model> [effort=<value>] [runtime=<mode>] [interaction=<mode>]\` and \`cwd: /absolute/path\` are required; \`isolation: worktree | shared\` and \`role: implementation | research | review | design | test | general\` are optional. The task text follows the header: the goal, the files it may touch, and the check that shows it worked. \`cwd\` must lie inside the session's directory or an allowed root. \`runtime\` and \`interaction\` can narrow the session, never widen it.
- \`isolation: worktree\` is the default. The task runs in its own git worktree on the branch \`orq/TASKID\`, and \`mcp__cc-orq__integrate\` with \`{"taskId": "<id>"}\` merges that branch into the checkout the task was launched from. Use \`shared\` only for a task that does not edit files. Never pass the native \`isolation\` option of the Agent tool to an \`cc-orq:task\` call.
- A worktree task must commit its work, since \`mcp__cc-orq__integrate\` merges only commits. When integrate answers \`not_fast_forward\`, call it again with \`"strategy": "merge"\`; when it answers \`merge_conflict\`, redelegate a rebase of the task branch to the same worker, then integrate again.
- A child blocked on a question it cannot answer from its brief stops and hands back \`BLOCKED on a question (taskId <id>): ...\`. Answer it yourself when the brief and this conversation settle it, and ask the user only when they do not. Then start a new \`cc-orq:task\` with the original brief plus the answer.
- The handback footer carries \`taskId <id>\`; a refused task says \`taskId none\`. Keep the id. \`mcp__cc-orq__status\` and \`mcp__cc-orq__cancel\` take \`{"taskId": "<id>"}\`: status shows the state and, once the task has ended, its result or error. Stop a task with \`mcp__cc-orq__cancel\` or TaskStop.
- A review round is a new \`cc-orq:task\`, not a message to the old one. Its brief carries the original task, the findings so far, the responses, and the open objections. Use a reviewer from a different model family than the implementer.
- After spawning, end the turn. Do not poll or sleep; the completion notice carries the result.
`
