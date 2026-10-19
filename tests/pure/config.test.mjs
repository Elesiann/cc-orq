import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, expandHome } from '../../hooks/config.ts'

const HOME = '/home/u'

test('missing file gives the defaults', () => {
  const r = parseConfig(null, HOME)
  assert.equal(r.source, 'defaults')
  assert.equal(r.warning, undefined)
  assert.equal(r.config.jobsDir, '/home/u/.cache/orq/jobs')
  assert.equal(r.config.waitSeconds, 120)
  assert.deepEqual(r.config.instances.map((i) => i.id), ['codex', 'opencode', 'claudeAgent'])
})

test('jobsDir with ~ becomes absolute and instance env expands ~', () => {
  const r = parseConfig(JSON.stringify({
    jobsDir: '~/jobs',
    waitSeconds: 240,
    instances: [{ id: 'codex-lane', driver: 'codex', env: { CODEX_HOME: '~/.codex-lane' } }],
  }), HOME)
  assert.equal(r.source, 'file')
  assert.equal(r.config.jobsDir, '/home/u/jobs')
  assert.equal(r.config.waitSeconds, 240)
  assert.deepEqual(r.config.instances, [{ id: 'codex-lane', driver: 'codex', env: { CODEX_HOME: '/home/u/.codex-lane' } }])
})

test('invalid JSON gives the defaults and a warning', () => {
  const r = parseConfig('{not json', HOME)
  assert.equal(r.source, 'defaults')
  assert.match(r.warning, /invalid JSON/)
  assert.equal(r.config.jobsDir, '/home/u/.cache/orq/jobs')
})

test('unknown drivers, bad ids and small waitSeconds are dropped', () => {
  const r = parseConfig(JSON.stringify({
    waitSeconds: 3,
    instances: [{ id: 'x', driver: 'gemini' }, { id: '-bad', driver: 'codex' }, { id: 'ok', driver: 'opencode' }],
  }), HOME)
  assert.equal(r.config.waitSeconds, 120)
  assert.deepEqual(r.config.instances, [{ id: 'ok', driver: 'opencode' }])
})

test('expandHome only touches a leading ~', () => {
  assert.equal(expandHome('~', HOME), HOME)
  assert.equal(expandHome('~/a', HOME), '/home/u/a')
  assert.equal(expandHome('/x/~/a', HOME), '/x/~/a')
})
