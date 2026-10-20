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
    'mcp__orq__capabilities',
    'mcp__orq__status',
    'mcp__orq__cancel',
    'mcp__orq__integrate',
    'orq:task',
  ]
  for (const term of terms) {
    expect(ORCHESTRATION_INSTRUCTIONS.includes(term)).toBe(true)
  }
})
