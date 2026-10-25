import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Runs scripts/catalog.py with fake provider executables first on PATH. Each fake prints one
// fixture file, so the probe exercises the real script without starting any provider CLI.
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const fixtures = join(root, 'tests', 'fixtures')

const RECORD_ARGV = `printf '%s\\n' "$*" >> "$ORQ_TEST_ARGV"`
const recordedCalls = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean)

function fakeBin(dir) {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const cat = (name) => `cat '${join(fixtures, name)}'`
  const fakes = {
    codex: `if [ "$1" = debug ] && [ "$2" = models ]; then ${cat('codex-models.json')}; exit 0; fi\nif [ "$1" = login ]; then exit 0; fi\nexit 1`,
    opencode: `${RECORD_ARGV}\nif [ "$1" = models ]; then ${cat('opencode-models.txt')}; exit 0; fi\nexit 1`,
    agy: `if [ "$1" = models ]; then ${cat('agy-models.txt')}; exit 0; fi\nexit 1`,
    claude: 'exit 0',
  }
  for (const [name, body] of Object.entries(fakes)) {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/bash\n${body}\n`)
    chmodSync(path, 0o755)
  }
  return bin
}

test('catalog.py probes each configured driver and reports models, auth and unknown drivers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orq-catalog-'))
  try {
    const bin = fakeBin(dir)
    const config = [
      { instanceId: 'codex', driver: 'codex', env: { CODEX_HOME: '/srv/example/sentinel-home' } },
      { instanceId: 'opencode', driver: 'opencode' },
      { instanceId: 'antigravity', driver: 'antigravity' },
      { instanceId: 'claudeAgent', driver: 'claudeAgent' },
      { instanceId: 'odd', driver: 'nonexistent' },
    ]
    const argvFile = join(dir, 'opencode.argv')
    const run = spawnSync('python3', [join(root, 'scripts', 'catalog.py')], {
      input: JSON.stringify(config),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORQ_TEST_ARGV: argvFile },
    })
    assert.equal(run.status, 0, run.stderr)
    const instances = JSON.parse(run.stdout)
    const byId = Object.fromEntries(instances.map((i) => [i.instanceId, i]))
    assert.deepEqual(byId.codex.models.map((m) => m.id), ['fixture-model-1', 'fixture-model-2'])
    assert.equal(byId.codex.authenticated, true)
    assert.equal(byId.codex.installed, true)
    assert.deepEqual(byId.opencode.models.map((m) => m.id), [
      'fixture-provider-1/fixture-model-4',
      'fixture-provider-1/fixture-model-5',
      'fixture-provider-2/fixture-model-6',
      'fixture-provider-4/fixture-model-7',
    ])
    assert.equal(byId.opencode.authenticated, true)
    assert.equal(byId.opencode.unavailableReason, null)
    assert.deepEqual(recordedCalls(argvFile), ['models --standalone'], 'the probe lists models on a private server, not through the shared background service')
    assert.deepEqual(byId.antigravity.models.map((m) => m.id), ['fixture-model-8-high', 'fixture-model-8-low', 'fixture-model-9'])
    assert.deepEqual(byId.claudeAgent.models.map((m) => m.id), ['haiku', 'sonnet', 'opus'])
    assert.equal(byId.odd.installed, false)
    assert.equal(byId.odd.unavailableReason, "Unknown driver 'nonexistent'.")
    assert.equal(run.stdout.includes('sentinel-home'), false, 'the configured env is never echoed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog.py refuses input that is not a JSON list', () => {
  const run = spawnSync('python3', [join(root, 'scripts', 'catalog.py')], { input: '{"not": "a list"}', encoding: 'utf8' })
  assert.equal(run.status, 2)
  assert.deepEqual(JSON.parse(run.stdout), { error: 'instances config must be a JSON list.' })
})

function runProbe(opencodeBody) {
  const dir = mkdtempSync(join(tmpdir(), 'orq-catalog-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'opencode'), `#!/bin/bash\n${RECORD_ARGV}\n${opencodeBody}\n`)
    chmodSync(join(bin, 'opencode'), 0o755)
    const argvFile = join(dir, 'opencode.argv')
    const run = spawnSync('python3', [join(root, 'scripts', 'catalog.py')], {
      input: JSON.stringify([{ instanceId: 'opencode', driver: 'opencode' }]),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORQ_TEST_STATE: join(dir, 'state'), ORQ_TEST_ARGV: argvFile },
    })
    assert.equal(run.status, 0, run.stderr)
    return { instance: JSON.parse(run.stdout)[0], calls: recordedCalls(argvFile) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('catalog.py retries opencode models once after a failed run', () => {
  const flaky = `if [ "$1" = models ]; then\n  if [ ! -e "$ORQ_TEST_STATE" ]; then : > "$ORQ_TEST_STATE"; exit 1; fi\n  echo fixture-provider-1/fixture-model-4; exit 0\nfi\nexit 1`
  const { instance, calls } = runProbe(flaky)
  assert.deepEqual(instance.models.map((m) => m.id), ['fixture-provider-1/fixture-model-4'])
  assert.equal(instance.unavailableReason, null)
  assert.deepEqual(calls, ['models --standalone', 'models --standalone'], 'the retry runs on a private server too')
})

test('catalog.py reports an opencode that lists no models as unavailable, not as logged out', () => {
  const { instance } = runProbe('if [ "$1" = models ]; then exit 0; fi\nexit 1')
  assert.deepEqual(instance.models, [])
  assert.equal(instance.authenticated, null)
  assert.equal(instance.unavailableReason, 'OpenCode is available, but it did not report any connected upstream providers.')
})
