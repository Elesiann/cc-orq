import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from '../../hooks/register.ts'

function harness({ home = '/home/u', text = null, failEnv = false } = {}) {
  const handlers = {}
  const logs = []
  const on = (event, handler) => { handlers[event] = handler }
  register(on, {})
  const $ = {
    command: { register: async () => ({ command: 'orq' }) },
    tool: { register: async () => ({ tool: 'mcp__orq__wait' }) },
    agent: { register: async () => ({ agent: 'orq:task' }) },
    env: { get: async () => { if (failEnv) throw new Error('env down'); return home } },
    clock: { every: () => ({ cancel() {} }), now: async () => 0 },
    fs: { exists: async () => text !== null, read: async () => text, list: async () => [] },
    tool: { register: async (spec) => ({ tool: `mcp__orq__${spec.name}` }) },
    ui: { log: async (line, opts) => { logs.push([line, opts]) } },
  }
  return { handlers, logs, $ }
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
