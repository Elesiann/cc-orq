import { expect, test } from 'claude-code/testing'

const ENGINE_SECTION = { id: 'intro', text: 'You are a coding assistant.', scope: 'shared' }

const FACTS = {
  model: 'fixture-model',
  promptModel: 'fixture-model',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
}

function stubs(on: any) {
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.compose', () => ({ sections: [ENGINE_SECTION] }))
}

test('the composed system prompt ends with the orchestration section, in the session scope', async ($, on) => {
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const prompt: any = await $.prompt.compose(FACTS as any)
  expect(prompt.sections.map((s: any) => s.id)).toEqual(['intro', 'orq:orchestration'])
  expect(prompt.sections[0]).toEqual(ENGINE_SECTION)
  expect(prompt.sections[1].scope).toBe('session')
})

test('the orchestration section is under 4,000 bytes and names the orq tools and orq:task', async ($, on) => {
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const prompt: any = await $.prompt.compose(FACTS as any)
  const text: string = prompt.sections[1].text
  expect(new TextEncoder().encode(text).length < 4000).toBe(true)
  for (const name of ['mcp__orq__capabilities', 'mcp__orq__status', 'mcp__orq__cancel', 'orq:task']) {
    expect(text.includes(name)).toBe(true)
  }
})
