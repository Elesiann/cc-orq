import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { register } from '../../hooks/register.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function harness({ home = '/home/u', text = null, failEnv = false } = {}) {
  const handlers = {}
  const logs = []
  const registered = []
  const agents = []
  const on = (event, handler) => { handlers[event] = handler }
  register(on, {})
  const $ = {
    command: { register: async () => ({ command: 'orq' }) },
    tool: { register: async (spec) => { registered.push(spec.name); return { tool: 'mcp__cc-orq__wait' } } },
    agent: { register: async (spec) => { agents.push(spec); return { agent: 'cc-orq:task' } } },
    env: { get: async () => { if (failEnv) throw new Error('env down'); return home } },
    clock: { every: () => ({ cancel() {} }), now: async () => 0 },
    fs: { exists: async () => text !== null, read: async () => text, list: async () => [] },
    ui: { log: async (line, opts) => { logs.push([line, opts]) } },
  }
  return { handlers, logs, registered, agents, $ }
}

test('session.start logs the loaded config and returns next(e)', async () => {
  const { handlers, logs, $ } = harness({ text: '{"waitSeconds": 60}' })
  const e = { cwd: '/w', surface: 'terminal', isInteractive: true }
  const result = await handlers['session.start']($, e, async (x) => ({ cwd: x.cwd }))
  assert.deepEqual(result, { cwd: '/w' })
  assert.equal(logs.length, 1)
  assert.match(logs[0][0], /^orq loaded: config file, jobsDir \/home\/u\/.cache\/orq\/jobs, 3 instances$/)
  assert.deepEqual(logs[0][1], { to: 'debug' })
})

test('session.start logs the warning line before the loaded line', async () => {
  const { handlers, logs, $ } = harness({ text: '{bad' })
  await handlers['session.start']($, {}, async () => ({ cwd: '/w' }))
  assert.equal(logs[0][0], 'orq: config: invalid JSON, using defaults')
  assert.match(logs[1][0], /^orq loaded: config defaults/)
})

test('session.start still returns next(e) when loading throws', async () => {
  const { handlers, logs, $ } = harness({ failEnv: true })
  const result = await handlers['session.start']($, {}, async () => ({ cwd: '/w' }))
  assert.deepEqual(result, { cwd: '/w' })
  assert.match(logs[0][0], /^orq: session.start failed: Error: env down/)
})

test('session.start registers the wait tool and none of the tools the MCP server serves', async () => {
  const { handlers, registered, $ } = harness()
  await handlers['session.start']($, {}, async () => ({ cwd: '/w' }))
  assert.deepEqual(registered, ['wait'])
})

// Everything the parent needs to start a task is the agent's description, since no hook injects text at session start.
const GUIDANCE = [
  'run_in_background: true',
  'no history',
  '`target: <instance> <model>',
  '`cwd: /absolute/path`',
  '`isolation: worktree | shared`',
  '`role: implementation',
  "Never pass the Agent tool's own `isolation` option",
  'end the turn',
  '`taskId <id>`',
  '`BLOCKED on a question`',
  'a new `cc-orq:task` with the original brief plus the answer',
  'a different model family',
]

test('session.start registers the cc-orq:task agent with the guidance for the parent in its description', async () => {
  const { handlers, agents, $ } = harness()
  await handlers['session.start']($, {}, async () => ({ cwd: '/w' }))
  assert.equal(agents.length, 1)
  assert.equal(agents[0].name, 'task')
  const { description } = agents[0]
  for (const term of GUIDANCE) assert.ok(description.includes(term), `the description lacks: ${term}`)
  assert.ok(description.length < 1500, `the description takes ${description.length} characters of every session's context`)
  assert.equal(/`(?:capabilities|status|cancel|integrate|list)`/.test(description), false, 'the tools are described by the server, not repeated here')
})

test('hooks/hooks.json loads the mod and injects no text at session start', () => {
  const hooks = JSON.parse(readFileSync(`${ROOT}/hooks/hooks.json`, 'utf8'))
  assert.deepEqual(hooks.modules, ['./register.ts'])
  assert.equal(hooks.hooks, undefined)
})
