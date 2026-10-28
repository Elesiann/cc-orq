import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Runs scripts/catalog.py with fake provider executables first on PATH. Each fake prints one
// fixture file, so the probe exercises the real script without starting any provider CLI.
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const fixtures = join(root, 'tests', 'fixtures')

const RECORD_ARGV = `printf '%s\\n' "$*" >> "$ORQ_TEST_ARGV"; printf '%s\\n' "$ORQ_PROBE_ID" >> "$ORQ_TEST_IDS"`
const recordedCalls = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean)
const isDead = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')
  } catch {
    return true
  }
}
const untilDead = async (pid) => {
  for (let i = 0; i < 40 && !isDead(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  return isDead(pid)
}

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
    const idsFile = join(dir, 'opencode.ids')
    const run = spawnSync('python3', [join(root, 'scripts', 'catalog.py')], {
      input: JSON.stringify(config),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORQ_TEST_ARGV: argvFile, ORQ_TEST_IDS: idsFile },
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
    assert.match(recordedCalls(idsFile)[0] ?? '', /^[0-9a-f]{32}$/, 'the call carries a probe id that nothing else shares')
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
    const idsFile = join(dir, 'opencode.ids')
    const run = spawnSync('python3', [join(root, 'scripts', 'catalog.py')], {
      input: JSON.stringify([{ instanceId: 'opencode', driver: 'opencode' }]),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORQ_TEST_STATE: join(dir, 'state'), ORQ_TEST_ARGV: argvFile, ORQ_TEST_IDS: idsFile },
    })
    assert.equal(run.status, 0, run.stderr)
    return { instance: JSON.parse(run.stdout)[0], calls: recordedCalls(argvFile), ids: recordedCalls(idsFile) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('catalog.py retries opencode models once after a failed run', () => {
  const flaky = `if [ "$1" = models ]; then\n  if [ ! -e "$ORQ_TEST_STATE" ]; then : > "$ORQ_TEST_STATE"; exit 1; fi\n  echo fixture-provider-1/fixture-model-4; exit 0\nfi\nexit 1`
  const { instance, calls, ids } = runProbe(flaky)
  assert.deepEqual(instance.models.map((m) => m.id), ['fixture-provider-1/fixture-model-4'])
  assert.equal(instance.unavailableReason, null)
  assert.deepEqual(calls, ['models --standalone', 'models --standalone'], 'the retry runs on a private server too')
  assert.equal(new Set(ids).size, 2, 'each call has a probe id of its own')
})

const hasSetsid = spawnSync('sh', ['-c', 'command -v setsid']).status === 0
const sweepsHere = { skip: !(existsSync('/proc/self') && hasSetsid) && 'the sweep needs /proc, and the leftover is started with setsid' }

test('catalog.py ends what an opencode models call leaves running, and nothing else', sweepsHere, async () => {
  const bystander = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  const dir = mkdtempSync(join(tmpdir(), 'orq-leftover-'))
  const pidFile = join(dir, 'leftover.pid')
  let leftover = 0
  try {
    const body = `setsid sleep 60 </dev/null >/dev/null 2>&1 &\necho $! > '${pidFile}'\nif [ "$1" = models ]; then echo fixture-provider-1/fixture-model-4; exit 0; fi\nexit 1`
    const { instance } = runProbe(body)
    leftover = Number(readFileSync(pidFile, 'utf8'))
    assert.deepEqual(instance.models.map((m) => m.id), ['fixture-provider-1/fixture-model-4'])
    assert.equal(await untilDead(leftover), true, 'the process the call left running is still there')
    assert.equal(isDead(bystander.pid), false, 'a process the call did not start was ended')
  } finally {
    bystander.kill('SIGKILL')
    if (leftover > 0) {
      try {
        process.kill(leftover, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog.py stops its commands at its deadline, sweeps the one it cut short, and starts none after it', sweepsHere, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orq-deadline-'))
  const pidFile = join(dir, 'leftover.pid')
  const argvFile = join(dir, 'opencode.argv')
  let leftover = 0
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'opencode'),
      `#!/bin/bash\n${RECORD_ARGV}\nsetsid sleep 60 </dev/null >/dev/null 2>&1 &\necho $! > '${pidFile}'\nsleep 8\nexit 1\n`,
    )
    chmodSync(join(bin, 'opencode'), 0o755)
    const scripts = join(root, 'scripts')
    const startedAt = Date.now()
    const run = spawnSync(
      'python3',
      ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(scripts)}); import catalog; catalog.DEADLINE_S = 2; sys.exit(catalog.main())`],
      {
        input: JSON.stringify([{ instanceId: 'first', driver: 'opencode' }, { instanceId: 'second', driver: 'opencode' }]),
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORQ_TEST_ARGV: argvFile, ORQ_TEST_IDS: join(dir, 'opencode.ids') },
      },
    )
    const elapsedMs = Date.now() - startedAt
    assert.equal(run.status, 0, run.stderr)
    assert.ok(elapsedMs < 6000, `the probe ran ${elapsedMs} ms, past its deadline of 2 s`)
    const instances = JSON.parse(run.stdout)
    assert.deepEqual(instances.map((i) => i.unavailableReason), Array(2).fill("'opencode models --standalone' failed (exit 127)."))
    assert.deepEqual(recordedCalls(argvFile), ['models --standalone'], 'no command starts once the deadline has passed')
    leftover = Number(readFileSync(pidFile, 'utf8'))
    assert.equal(await untilDead(leftover), true, 'the call cut short at the deadline was swept')
  } finally {
    if (leftover > 0) {
      try {
        process.kill(leftover, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog.py reports an opencode that lists no models as unavailable, not as logged out', () => {
  const { instance } = runProbe('if [ "$1" = models ]; then exit 0; fi\nexit 1')
  assert.deepEqual(instance.models, [])
  assert.equal(instance.authenticated, null)
  assert.equal(instance.unavailableReason, 'OpenCode is available, but it did not report any connected upstream providers.')
})
