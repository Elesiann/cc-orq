import { expect, test } from 'claude-code/testing'

import { ORCHESTRATION_INSTRUCTIONS } from '../hooks/instructions.ts'

test('the orchestration instructions are under 4,000 bytes', async () => {
  expect(new TextEncoder().encode(ORCHESTRATION_INSTRUCTIONS).length < 4000).toBe(true)
})

test('the orchestration instructions state the header lines, the taskId and the orq tools', async () => {
  const terms = [
    'target:',
    'cwd:',
    'isolation:',
    'role:',
    'taskId',
    'mcp__plugin_cc-orq_orq__capabilities',
    'mcp__plugin_cc-orq_orq__status',
    'mcp__plugin_cc-orq_orq__cancel',
    'mcp__plugin_cc-orq_orq__integrate',
    'cc-orq:task',
    'BLOCKED on a question',
    'merge_conflict',
  ]
  for (const term of terms) {
    expect(ORCHESTRATION_INSTRUCTIONS.includes(term)).toBe(true)
  }
})
