// The orchestration section of the parent session's system prompt. Its rules follow T3 Code's
// orchestration instructions (MIT), adapted to orq: a delegated task is a background orq:task
// agent, and its status and cancel are the orq tools. Kept under 4,000 bytes, so a provider that
// cuts longer instruction entries still delivers it whole.

import type { On } from 'claude-code'

export const ORCHESTRATION_SECTION_ID = 'orq:orchestration'

export const ORCHESTRATION_INSTRUCTIONS = `## orq orchestration

Delegate self-contained work to other provider CLIs (Codex, OpenCode, Antigravity, Claude) through background \`orq:task\` agents. Each one runs as a detached job and returns its final answer when it ends. A waiting parent spends no model tokens.

- Read \`mcp__orq__capabilities\` before you name a target. It lists each provider instance, its live models, each model's options and allowed values, and its constraints. Do not guess model ids.
- Spawn the Agent tool with \`subagent_type: "orq:task"\` and \`run_in_background: true\`. The child gets no history, so the prompt carries the whole brief: the goal, the files it may touch, and the check that shows it worked.
- Use \`isolation: worktree\` for every task that edits files; it is the default. Use \`shared\` only for a task that does not edit. Never pass the native \`isolation\` option of the Agent tool to an \`orq:task\` call.
- Keep the \`taskId\` from the handback. Read progress with \`mcp__orq__status\` and \`{"taskId": "<id>"}\`: it shows the status and, once the task has ended, its result or error. Stop a task with \`mcp__orq__cancel\` or TaskStop.
- A review round is a new \`orq:task\`, not a message to the old one. Its brief carries the original task, the findings so far, the responses, and the open objections. Use a reviewer from a different model family than the implementer.
- After spawning, end the turn. Do not poll or sleep; the completion notice carries the result.`

/** Appends the orchestration section to every system prompt the engine composes. */
export function registerInstructions(on: On): void {
  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)
    return {
      sections: [...composed.sections, { id: ORCHESTRATION_SECTION_ID, text: ORCHESTRATION_INSTRUCTIONS, scope: 'session' }],
    }
  })
}
