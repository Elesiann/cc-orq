import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, expandHome, loadConfig, defaultConfig } from '../../hooks/config.ts'

const HOME = '/home/u'
const j = (o) => JSON.stringify(o)

test('missing file gives the defaults', () => {
  const r = parseConfig(null, HOME)
  assert.equal(r.source, 'defaults')
  assert.equal(r.warning, undefined)
  assert.equal(r.config.jobsDir, '/home/u/.cache/orq/jobs')
  assert.equal(r.config.waitSeconds, 120)
  assert.deepEqual(r.config.instances.map((i) => i.id), ['codex', 'opencode', 'claudeAgent'])
})

test('defaultConfig returns a fresh instances array each call', () => {
  const a = defaultConfig(HOME)
  a.instances.push({ id: 'x', driver: 'codex' })
  assert.equal(defaultConfig(HOME).instances.length, 3)
})

test('a full valid file is read: ~ expands in jobsDir and env, waitSeconds is floored', () => {
  const r = parseConfig(j({
    jobsDir: '~/jobs',
    waitSeconds: 240.9,
    instances: [{ id: 'codex-work', driver: 'codex', env: { CODEX_HOME: '~/.codex-work' } }, { id: 'agy', driver: 'antigravity' }],
  }), HOME)
  assert.equal(r.source, 'file')
  assert.equal(r.warning, undefined)
  assert.equal(r.config.jobsDir, '/home/u/jobs')
  assert.equal(r.config.waitSeconds, 240)
  assert.deepEqual(r.config.instances, [
    { id: 'codex-work', driver: 'codex', env: { CODEX_HOME: '/home/u/.codex-work' } },
    { id: 'agy', driver: 'antigravity' },
  ])
})

test('invalid JSON gives the defaults and a warning without the parser message', () => {
  const r = parseConfig('{not json', HOME)
  assert.equal(r.source, 'defaults')
  assert.equal(r.warning, 'config: invalid JSON, using defaults')
  assert.equal(r.config.jobsDir, '/home/u/.cache/orq/jobs')
})

test('a non-object root gives the defaults and a warning', () => {
  for (const text of ['[]', 'null', '"x"', '3']) {
    const r = parseConfig(text, HOME)
    assert.equal(r.source, 'defaults', text)
    assert.match(r.warning, /root is not an object/, text)
  }
})

test('bad jobsDir values keep the default and warn', () => {
  for (const jobsDir of ['', '   ', 'jobs', '../x', '~bob/x', 5]) {
    const r = parseConfig(j({ jobsDir }), HOME)
    assert.equal(r.config.jobsDir, '/home/u/.cache/orq/jobs', String(jobsDir))
    assert.match(r.warning, /jobsDir must be an absolute path/, String(jobsDir))
  }
  assert.equal(parseConfig(j({ jobsDir: '  /abs/jobs  ' }), HOME).config.jobsDir, '/abs/jobs')
})

test('bad waitSeconds values keep the default and warn', () => {
  for (const text of ['{"waitSeconds":3}', '{"waitSeconds":"120"}', '{"waitSeconds":1e999}', '{"waitSeconds":601}', '{"waitSeconds":null}']) {
    const r = parseConfig(text, HOME)
    assert.equal(r.config.waitSeconds, 120, text)
    assert.match(r.warning, /waitSeconds must be a number between 10 and 600/, text)
  }
  assert.equal(parseConfig(j({ waitSeconds: 10 }), HOME).config.waitSeconds, 10)
  assert.equal(parseConfig(j({ waitSeconds: 600 }), HOME).config.waitSeconds, 600)
})

test('invalid instances are dropped one by one, each with a warning', () => {
  const r = parseConfig(j({
    instances: [
      { id: 'x', driver: 'notadriver' },
      { id: '-bad', driver: 'codex' },
      'text',
      { id: 'ok', driver: 'opencode' },
      { id: 'ok', driver: 'codex' },
      { id: 'envy', driver: 'codex', env: { http_proxy: 'x', GOOD: 'y', NUM: 1 } },
      { id: 'envarr', driver: 'codex', env: ['x'] },
    ],
  }), HOME)
  assert.deepEqual(r.config.instances, [
    { id: 'ok', driver: 'opencode' },
    { id: 'envy', driver: 'codex', env: { GOOD: 'y' } },
    { id: 'envarr', driver: 'codex' },
  ])
  for (const re of [/instances\[0\] \(x\) has an unknown driver/, /instances\[1\] has no valid id/, /instances\[2\] is not an object/, /instances\[4\] repeats the id ok/, /env key http_proxy must be UPPER_CASE/, /env NUM must be a string/, /instances\[6\] \(envarr\) env is not an object/]) {
    assert.match(r.warning, re)
  }
})

test('an instances list with no valid entry keeps the defaults and warns', () => {
  for (const instances of [[], [{ id: 'x', driver: 'nope' }], 'codex']) {
    const r = parseConfig(j({ instances }), HOME)
    assert.deepEqual(r.config.instances.map((i) => i.id), ['codex', 'opencode', 'claudeAgent'], j(instances))
    assert.match(r.warning, /instances (has no valid entry|must be an array)/, j(instances))
  }
})

test('expandHome only touches a leading ~', () => {
  assert.equal(expandHome('~', HOME), HOME)
  assert.equal(expandHome('~/a', HOME), '/home/u/a')
  assert.equal(expandHome('/x/~/a', HOME), '/x/~/a')
  assert.equal(expandHome('~bob/a', HOME), '~bob/a')
})

function fakeEngine({ home = HOME, exists = true, text = null, readError = null } = {}) {
  const calls = []
  return {
    calls,
    env: { get: async (name) => { calls.push(['env.get', name]); return home === 'UNSET' ? undefined : home } },
    fs: {
      exists: async (p) => { calls.push(['fs.exists', p]); return exists },
      read: async (p) => { calls.push(['fs.read', p]); if (readError) throw readError; return text },
    },
  }
}

test('loadConfig reads ~/.config/orq/config.json when it exists', async () => {
  const $ = fakeEngine({ text: j({ waitSeconds: 30 }) })
  const r = await loadConfig($)
  assert.equal(r.source, 'file')
  assert.equal(r.config.waitSeconds, 30)
  assert.deepEqual($.calls, [['env.get', 'HOME'], ['fs.exists', '/home/u/.config/orq/config.json'], ['fs.read', '/home/u/.config/orq/config.json']])
})

test('loadConfig uses the defaults when the file is absent', async () => {
  const $ = fakeEngine({ exists: false })
  const r = await loadConfig($)
  assert.equal(r.source, 'defaults')
  assert.equal(r.warning, undefined)
  assert.equal($.calls.filter((c) => c[0] === 'fs.read').length, 0)
})

test('loadConfig warns and uses the defaults when the read fails', async () => {
  const r = await loadConfig(fakeEngine({ readError: new Error('EACCES') }))
  assert.equal(r.source, 'defaults')
  assert.match(r.warning, /cannot read \/home\/u\/.config\/orq\/config.json \(Error: EACCES\)/)
})

test('loadConfig treats an unset or empty HOME as unset', async () => {
  for (const home of ['UNSET', '', '  ']) {
    const $ = fakeEngine({ home })
    const r = await loadConfig($)
    assert.equal(r.source, 'defaults', String(home))
    assert.match(r.warning, /HOME is not set/, String(home))
    assert.equal($.calls.filter((c) => c[0] !== 'env.get').length, 0, String(home))
  }
})
