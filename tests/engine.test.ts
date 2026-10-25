import { expect, test } from 'claude-code/testing'

import { parseLaunch } from '../hooks/engine.ts'
import { LAUNCH_GRACE_MS, sha256Hex } from '../hooks/lock.ts'
import { QUESTION_PROTOCOL } from '../hooks/question.ts'
import {
  buildFooter,
  failureSnippet,
  formatDuration,
  isSafeJobId,
  redactSecrets,
  renderTable,
  shellWord,
} from '../hooks/types.ts'

// The job directory, the config file and the CODEX_HOME an instance overrides.
const JOBS = '/srv/example/jobs'
const CODEX_HOME = '/srv/example/codex-home'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({
  jobsDir: JOBS,
  instances: [
    { id: 'codex', driver: 'codex' },
    { id: 'codex-work', driver: 'codex', env: { CODEX_HOME } },
    { id: 'claudeAgent', driver: 'claudeAgent' },
  ],
})

type State = {
  now: number
  files: Map<string, string>
  writes: { path: string; text: string }[]
  dirEntries: { name: string; kind: string }[]
  mkdirScripts: string[]
  startScripts: string[]
  probeScripts: string[]
  commands: { name: string }[]
  mkdirExit: number
  startExit: number
  stderrTail: string
  extractFail: boolean
  extractSummary: { tid: string; in: number | null; out: number | null; error: boolean; model?: string }
  rolloutPath: string
  mtimes: Map<string, number>
  goneJobs: Set<string>
  livenessScripts: string[]
  failWritesTo: string
  /** False: every lock script succeeds and holds nothing, as in the other kit files. True: the stub keeps the lock directories. */
  locking: boolean
  /** The lock directories that exist, each with the owner id inside it; null while the claim has not written one. */
  locks: Map<string, string | null>
  /** The exit code the claim script answers with when it is not 0: 1 means the lock directory is there already. */
  lockExit: number
  /** The exit code the aside script answers with; when it is not 0 the lock stays where it is. */
  asideExit: number
  /** Jobs whose supervisor has not written its pgid yet. */
  noPgid: Set<string>
  /** Paths that are symlinks, each with the real path fs.stat resolves it to. */
  realPaths: Map<string, string>
  /** The steps of a launch in the order they ran: mkdir, lock claim, write meta.json, start. */
  events: string[]
  /** Runs when the start script does, or when a mutex is taken: another launcher acting in that window. */
  onStart: (() => void) | null
  onMutex: (() => void) | null
  /** Runs when a file is read, with its path: a slow disk, or another launcher acting during the scan. */
  onRead: ((path: string) => void) | null
  /** Runs after a file is written, with its path: a slow disk, or another launcher acting while the job files are written. */
  onWrite: ((path: string) => void) | null
}

function fresh(o: Partial<State> = {}): State {
  return {
    now: 1000000,
    files: new Map([[CONFIG_PATH, CONFIG]]),
    writes: [],
    dirEntries: [],
    mkdirScripts: [],
    startScripts: [],
    probeScripts: [],
    commands: [],
    mkdirExit: 0,
    startExit: 0,
    stderrTail: '',
    extractFail: false,
    extractSummary: { tid: '', in: 0, out: 0, error: false },
    rolloutPath: '',
    mtimes: new Map(),
    goneJobs: new Set(),
    livenessScripts: [],
    failWritesTo: '',
    locking: false,
    locks: new Map(),
    lockExit: 0,
    asideExit: 0,
    noPgid: new Set(),
    realPaths: new Map(),
    events: [],
    onStart: null,
    onMutex: null,
    onRead: null,
    onWrite: null,
    ...o,
  }
}

const result = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

function stubs(on: any, s: State) {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', (_$: unknown, e: any) => {
    s.commands.push(e)
    return { value: { command: e.name } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/test' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('clock.now', () => ({ value: s.now }))
  on('fs.exists', (_$: unknown, e: any) => ({ value: s.files.has(e.path) || s.locks.has(e.path) }))
  on('fs.read', (_$: unknown, e: any) => {
    s.onRead?.(String(e.path))
    if (s.files.has(e.path)) return { value: s.files.get(e.path) }
    if (String(e.path).endsWith('/pgid') && !s.noPgid.has(String(e.path).slice(JOBS.length + 1, -'/pgid'.length))) {
      return { value: '4242\n' }
    }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', (_$: unknown, e: any) => {
    if (s.failWritesTo && String(e.path).endsWith(s.failWritesTo)) throw new Error(`EIO: ${e.path}`)
    s.events.push(`write ${String(e.path).split('/').pop()}`)
    s.writes.push({ path: e.path, text: e.text })
    s.files.set(e.path, e.text)
    s.onWrite?.(String(e.path))
    return { value: undefined }
  })
  on('fs.list', (_$: unknown, e: any) => {
    if (e.path !== JOBS) throw new Error(`ENOENT: ${e.path}`)
    return { value: s.dirEntries.map((d) => ({ name: d.name, kind: d.kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_$: unknown, e: any) => {
    const realPath = s.realPaths.get(e.path)
    if (realPath !== undefined) return { value: { kind: 'dir', size: 0, mtimeMs: s.now, isLink: true, realPath } }
    if (s.locks.has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: s.mtimes.get(e.path) ?? s.now, isLink: false } }
    if (!s.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 0, mtimeMs: s.mtimes.get(e.path) ?? s.now, isLink: false } }
  })
  on('process.run', (_$: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'python3') {
      if (s.extractFail) return result(1)
      return result(0, JSON.stringify(s.extractSummary) + '\n')
    }
    const script = argv[2] ?? ''
    if (script.includes('# orq:mkdir')) {
      s.events.push('mkdir')
      s.mkdirScripts.push(script)
      return result(s.mkdirExit)
    }
    if (script.includes('# orq:lock')) return result(runLockScript(s, script))
    if (script.includes('# orq:start')) {
      s.events.push('start')
      s.startScripts.push(script)
      s.onStart?.()
      return result(s.startExit)
    }
    if (script.includes('# orq:rollout')) {
      s.probeScripts.push(script)
      return result(0, s.rolloutPath ? `${s.rolloutPath}\n` : '\n')
    }
    if (script.includes('# orq:stderr')) return result(0, s.stderrTail)
    if (script.includes('# orq:liveness')) {
      s.livenessScripts.push(script)
      const gone = [...s.goneJobs].some((id) => script.includes(`${JOBS}/${id}/pgid`))
      return result(gone ? 12 : 11)
    }
    throw new Error(`unexpected process.run: ${script.slice(0, 80)}`)
  })
}

// What the lock scripts do to a real directory, applied to the state the stub keeps: the claim fails when the
// lock directory exists, a mutex is always granted, and the aside moves a lock away.
function runLockScript(s: State, script: string): number {
  const action = /^# orq:lock (\w+)/.exec(script)?.[1] ?? ''
  s.events.push(`lock ${action}`)
  if (!s.locking) return 0
  if (action === 'claim') {
    if (s.lockExit !== 0) return s.lockExit
    const dir = /mkdir (\S+\/\.locks\/[0-9a-f]{64}) /.exec(script)?.[1] ?? ''
    if (s.locks.has(dir)) return 1
    const owner = /printf '%s\\n' (\S+) > \S+\/owner/.exec(script)?.[1] ?? ''
    s.locks.set(dir, owner)
    s.files.set(`${dir}/owner`, `${owner}\n`)
    s.mtimes.set(dir, s.now)
  }
  if (action === 'mutex') s.onMutex?.()
  if (action === 'touch') {
    const dir = /touch -c (\S+) /.exec(script)?.[1] ?? ''
    const owner = /= (\S+) \] \|\| exit/.exec(script)?.[1] ?? ''
    if (s.locks.get(dir) !== owner) return 3
    s.mtimes.set(dir, s.now)
  }
  if (action === 'aside') {
    if (s.asideExit !== 0) return s.asideExit
    const dir = /^mv (\S+) /m.exec(script)?.[1] ?? ''
    s.locks.delete(dir)
    s.files.delete(`${dir}/owner`)
  }
  return 0
}

// The kit's command.run also takes the origin and presentation the engine sets; a test sends the name and args only.
async function orq($: any, args: string): Promise<string> {
  const r = await $.command.run({ command: 'orq', args })
  return r.text ?? ''
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

function seedJob(s: State, id: string, extra: Record<string, unknown> = {}, startedAt = 1000000) {
  s.files.set(
    `${JOBS}/${id}/meta.json`,
    JSON.stringify({
      id,
      kind: 'manual',
      agentId: 'manual',
      cwd: '/work',
      startedAt,
      startedAtIso: new Date(startedAt).toISOString(),
      runner: 'codex',
      model: 'fixture-model',
      instanceId: 'codex',
      driver: 'codex',
      ...extra,
    }),
  )
}

function launchedId(text: string): string {
  const prefix = 'orq: launched '
  expect(text.startsWith(prefix)).toBe(true)
  return text.slice(prefix.length)
}

test('session.start declares /orq in the typeahead', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect(s.commands.map((c) => c.name)).toEqual(['orq', 'orq-panel'])
})

test('launch prints the job id, writes meta.json and prompt.txt, and creates the directory atomically', async ($, on) => {
  const s = fresh({ now: 2000000 })
  stubs(on, s)
  await start($)
  const r = await orq($, 'launch codex fixture-model -- Do the thing')
  const id = launchedId(r)
  expect(id.startsWith('manual-2000000-manual-')).toBe(true)
  expect(s.mkdirScripts.length).toBe(1)
  expect(s.mkdirScripts[0]).toContain(`mkdir -p ${JOBS}`)
  expect(s.mkdirScripts[0]).toContain(`mkdir ${JOBS}/${id}`)
  const meta = JSON.parse(s.writes.find((w) => w.path.endsWith('/meta.json'))?.text ?? 'null')
  expect(meta).toEqual({
    id,
    kind: 'manual',
    agentId: 'manual',
    cwd: '/work',
    startedAt: 2000000,
    startedAtIso: new Date(2000000).toISOString(),
    runner: 'codex',
    model: 'fixture-model',
    instanceId: 'codex',
    driver: 'codex',
  })
  expect(s.writes.find((w) => w.path.endsWith('/prompt.txt'))?.text).toBe(`Do the thing\n\n${QUESTION_PROTOCOL}`)
  expect(s.startScripts.length).toBe(1)
})

test('two launches in the same millisecond get different job ids', async ($, on) => {
  const s = fresh({ now: 2100000 })
  stubs(on, s)
  await start($)
  const a = launchedId((await orq($, 'launch codex fixture-model -- one')))
  const b = launchedId((await orq($, 'launch codex fixture-model -- two')))
  expect(a === b).toBe(false)
})

test('a failed mkdir refuses the launch, and a name clash retries once', async ($, on) => {
  const clash = fresh({ mkdirExit: 7 })
  stubs(on, clash)
  await start($)
  const refused = await orq($, 'launch codex fixture-model -- go')
  expect(refused).toContain('could not create its job directory (exit 7)')
  expect(clash.mkdirScripts.length).toBe(2)
  expect(clash.startScripts.length).toBe(0)
})

test('a supervisor that never reports refuses the launch and records exit 125', async ($, on) => {
  const s = fresh({ startExit: 11 })
  stubs(on, s)
  await start($)
  const r = await orq($, 'launch codex fixture-model -- go')
  expect(r).toContain('did not report within 5 s')
  expect(s.writes.find((w) => w.path.endsWith('/exit'))?.text).toBe('125')
})

test('the instance env reaches the systemd unit and the setsid fallback', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  await orq($, 'launch codex-work fixture-model -- with env')
  const withEnv = s.startScripts[0] ?? ''
  expect(withEnv).toContain(`--setenv=CODEX_HOME=${CODEX_HOME}`)
  expect(withEnv).toContain(`setsid env CODEX_HOME=${CODEX_HOME} ORQ_JOB_DIR=`)
  const metaWithEnv = JSON.parse(s.writes.find((w) => w.path.endsWith('/meta.json'))?.text ?? '{}')
  expect(metaWithEnv.codexHome).toBe(CODEX_HOME)
  expect(metaWithEnv.env).toBeUndefined()
  await orq($, 'launch codex fixture-model -- no env')
  expect(s.startScripts[1]?.includes('CODEX_HOME')).toBe(false)
  expect(s.startScripts[1]).toContain('--unit=orq-manual-')
})

test('a launch whose prompt.txt cannot be written lists as failed, not interrupted', async ($, on) => {
  const s = fresh({ now: 2200000, failWritesTo: '/prompt.txt' })
  stubs(on, s)
  await start($)
  const refused = await orq($, 'launch codex fixture-model -- go')
  expect(refused).toContain('could not write its job directory')
  expect(s.startScripts.length).toBe(0)
  const metaPath = [...s.files.keys()].find((path) => path.startsWith(JOBS) && path.endsWith('/meta.json')) ?? ''
  const id = metaPath.slice(JOBS.length + 1, -'/meta.json'.length)
  expect(s.writes.find((w) => w.path === `${JOBS}/${id}/exit`)?.text).toBe('125')
  s.dirEntries = [{ name: id, kind: 'dir' }]
  expect(rowStatus(await orq($, 'list'), id)).toBe('failed')
})

test('refused launches say what is wrong', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect((await orq($, 'launch nope fixture-model -- go'))).toContain(
    'unknown instance nope (configured: codex, codex-work, claudeAgent)',
  )
  expect((await orq($, 'launch codex fixture-model --'))).toBe(
    'orq: the prompt after -- is empty',
  )
  expect((await orq($, 'launch codex -x -- go'))).toBe(
    'orq: the model must not start with "-"',
  )
  expect((await orq($, 'launch codex fixture-model go'))).toBe(
    'orq: usage: /orq launch [--worktree] INSTANCE MODEL -- PROMPT',
  )
  expect(s.mkdirScripts.length).toBe(0)
})

test('list shows the newest jobs with running, cancelling, done, failed and cancelled status', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [
    { name: 'job-running', kind: 'dir' },
    { name: 'job-cancelling', kind: 'dir' },
    { name: 'job-done', kind: 'dir' },
    { name: 'job-failed', kind: 'dir' },
    { name: 'job-cancelled', kind: 'dir' },
    { name: 'stray.txt', kind: 'file' },
  ]
  seedJob(s, 'job-running', {}, 4000000)
  seedJob(s, 'job-cancelling', {}, 3000000)
  s.files.set(`${JOBS}/job-cancelling/cancel`, 'cancelled at now\n')
  seedJob(s, 'job-done', {}, 2000000)
  s.files.set(`${JOBS}/job-done/exit`, '0')
  s.files.set(`${JOBS}/job-done/last.txt`, 'OK')
  seedJob(s, 'job-failed', {}, 1500000)
  s.files.set(`${JOBS}/job-failed/exit`, '1')
  seedJob(s, 'job-cancelled', {}, 1200000)
  s.files.set(`${JOBS}/job-cancelled/exit`, '124')
  stubs(on, s)
  await start($)
  const text = (await orq($, 'list'))
  const lines = text.split('\n')
  expect(lines.length).toBe(6)
  expect(lines[0]).toMatch(/^id\s+kind\s+status\s+elapsed\s+cwd$/)
  const statusOf = (id: string) => lines.find((l) => l.startsWith(id))?.split(/\s+/)[2]
  expect(lines.map((l) => l.split(/\s+/)[0])).toEqual([
    'id',
    'job-running',
    'job-cancelling',
    'job-done',
    'job-failed',
    'job-cancelled',
  ])
  expect(statusOf('job-running')).toBe('running')
  expect(statusOf('job-cancelling')).toBe('cancelling')
  expect(statusOf('job-done')).toBe('done')
  expect(statusOf('job-failed')).toBe('failed')
  expect(statusOf('job-cancelled')).toBe('cancelled')
})

test('list reads a job whose meta.json has only the required fields', async ($, on) => {
  const s = fresh({ now: 1000900 })
  s.dirEntries = [{ name: 'job-min', kind: 'dir' }]
  s.files.set(`${JOBS}/job-min/meta.json`, JSON.stringify({ id: 'job-min', kind: 'manual', agentId: 'manual', cwd: '/w', startedAt: 1000000 }))
  stubs(on, s)
  await start($)
  const lines = (await orq($, 'list')).split('\n')
  expect(lines[1]?.split(/\s+/)).toEqual(['job-min', 'manual', 'running', '0s', '/w'])
})

test('list shows a job without exit and a gone supervisor as interrupted, and a live one as running', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [
    { name: 'job-gone', kind: 'dir' },
    { name: 'job-live', kind: 'dir' },
  ]
  seedJob(s, 'job-gone', {}, 4000000)
  seedJob(s, 'job-live', {}, 4000000)
  s.goneJobs.add('job-gone')
  stubs(on, s)
  await start($)
  const lines = (await orq($, 'list')).split('\n')
  const rowOf = (id: string) => lines.find((l) => l.startsWith(id))?.split(/\s+/)
  expect(rowOf('job-gone')).toEqual(['job-gone', 'manual', 'interrupted', '—', '/work'])
  expect(rowOf('job-live')).toEqual(['job-live', 'manual', 'running', '10m', '/work'])
  expect(s.livenessScripts.some((sc) => sc.includes(`${JOBS}/job-gone/pgid`))).toBe(true)
})

test('a finished job keeps the duration of its exit file however late list runs', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [{ name: 'job-done', kind: 'dir' }]
  seedJob(s, 'job-done', {}, 1000000)
  s.files.set(`${JOBS}/job-done/exit`, '0')
  s.files.set(`${JOBS}/job-done/last.txt`, 'OK')
  s.mtimes.set(`${JOBS}/job-done/exit`, 1090000)
  stubs(on, s)
  await start($)
  const elapsedOf = (text: string) => text.split('\n')[1]?.split(/\s+/)[3]
  expect(elapsedOf(await orq($, 'list'))).toBe('1m30s')
  s.now = 9000000
  expect(elapsedOf(await orq($, 'list'))).toBe('1m30s')
})

function rowStatus(listText: string, id: string): string | undefined {
  return listText.split('\n').find((l) => l.startsWith(id))?.split(/\s+/)[2]
}

test('a finished job with an empty last.txt is failed in both list and result', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [{ name: 'job-empty', kind: 'dir' }]
  seedJob(s, 'job-empty', {}, 4000000)
  s.files.set(`${JOBS}/job-empty/exit`, '0')
  s.files.set(`${JOBS}/job-empty/last.txt`, '')
  stubs(on, s)
  await start($)
  expect(rowStatus(await orq($, 'list'), 'job-empty')).toBe('failed')
  expect(await orq($, 'result job-empty')).toBe('orq: job-empty failed (exit 0)')
})

test('a finished job whose extractor reports an error is failed in both list and result', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [{ name: 'job-err', kind: 'dir' }]
  seedJob(s, 'job-err', {}, 4000000)
  s.files.set(`${JOBS}/job-err/exit`, '0')
  s.files.set(`${JOBS}/job-err/last.txt`, 'partial answer')
  s.extractSummary = { tid: 'thread-err', in: 1, out: 1, error: true }
  stubs(on, s)
  await start($)
  expect(rowStatus(await orq($, 'list'), 'job-err')).toBe('failed')
  expect(await orq($, 'result job-err')).toBe('orq: job-err failed (exit 0)')
})

test('an exit file that is not one whole number is failed, not done', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [{ name: 'job-blank', kind: 'dir' }]
  seedJob(s, 'job-blank', {}, 4000000)
  s.files.set(`${JOBS}/job-blank/exit`, '')
  s.files.set(`${JOBS}/job-blank/last.txt`, 'OK')
  stubs(on, s)
  await start($)
  expect(rowStatus(await orq($, 'list'), 'job-blank')).toBe('failed')
  expect(await orq($, 'result job-blank')).toBe('orq: job-blank failed (exit -1)')
})

test('list with no job directories says so', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect((await orq($, 'list'))).toBe('orq: no jobs yet')
})

test('result of a finished codex job is its last message and a footer with the rollout model and effort', async ($, on) => {
  const s = fresh({ now: 9000000 })
  seedJob(s, 'job-ok', { instanceId: 'codex-work' }, 1000000)
  s.files.set(`${JOBS}/job-ok/exit`, '0')
  s.files.set(`${JOBS}/job-ok/last.txt`, 'The answer is 42.')
  s.mtimes.set(`${JOBS}/job-ok/exit`, 1125000)
  s.extractSummary = { tid: 'thread-ok', in: 1200, out: 34, error: false }
  s.rolloutPath = `${CODEX_HOME}/sessions/2026/10/19/rollout-2026-10-19T00-00-00-thread-ok.jsonl`
  s.files.set(s.rolloutPath, JSON.stringify({ type: 'turn_context', payload: { model: 'fixture-model-rollout', effort: 'high' } }) + '\n')
  stubs(on, s)
  await start($)
  expect(await orq($, 'result job-ok')).toBe(
    'The answer is 42.\n\n— orq · manual · fixture-model-rollout · effort high · 2m05s · 1200/34 tokens · taskId job-ok · session thread-ok',
  )
  expect(s.probeScripts[0]).toContain(`${CODEX_HOME}/sessions`)
})

test('a codex job without a readable rollout falls back to the effort its meta.json recorded', async ($, on) => {
  const s = fresh({ now: 9000000 })
  seedJob(s, 'job-norollout', { effort: 'medium' }, 1000000)
  s.files.set(`${JOBS}/job-norollout/exit`, '0')
  s.files.set(`${JOBS}/job-norollout/last.txt`, 'Done.')
  s.mtimes.set(`${JOBS}/job-norollout/exit`, 1125000)
  s.extractSummary = { tid: 'thread-none', in: 1, out: 1, error: false }
  stubs(on, s)
  await start($)
  expect(await orq($, 'result job-norollout')).toContain('· effort medium ·')
})

test('the codex footer probes the CODEX_HOME a job launched with, even when its instance left the config', async ($, on) => {
  const s = fresh({ now: 9000000 })
  seedJob(s, 'job-moved', { instanceId: 'codex-gone', codexHome: CODEX_HOME }, 1000000)
  s.files.set(`${JOBS}/job-moved/exit`, '0')
  s.files.set(`${JOBS}/job-moved/last.txt`, 'Moved.')
  s.mtimes.set(`${JOBS}/job-moved/exit`, 1125000)
  s.extractSummary = { tid: 'thread-moved', in: 5, out: 2, error: false }
  s.rolloutPath = `${CODEX_HOME}/sessions/2026/10/19/rollout-2026-10-19T00-00-00-thread-moved.jsonl`
  s.files.set(s.rolloutPath, JSON.stringify({ type: 'turn_context', payload: { model: 'fixture-model-moved', effort: 'low' } }) + '\n')
  stubs(on, s)
  await start($)
  expect(await orq($, 'result job-moved')).toBe(
    'Moved.\n\n— orq · manual · fixture-model-moved · effort low · 2m05s · 5/2 tokens · taskId job-moved · session thread-moved',
  )
  expect(s.probeScripts[0]).toContain(`${CODEX_HOME}/sessions`)
})

test('the footer says tokens n/a when the extractor found no counts, as opencode runs do today', async ($, on) => {
  const s = fresh({ now: 9000000 })
  seedJob(s, 'job-oc', { runner: 'opencode', model: 'fixture-model' }, 1000000)
  s.files.set(`${JOBS}/job-oc/exit`, '0')
  s.files.set(`${JOBS}/job-oc/last.txt`, 'PONG')
  s.mtimes.set(`${JOBS}/job-oc/exit`, 1014000)
  s.extractSummary = { tid: 'fixture-opencode-session', in: null, out: null, error: false }
  stubs(on, s)
  await start($)
  expect(await orq($, 'result job-oc')).toBe(
    'PONG\n\n— orq · manual · fixture-model · effort n/a · 14s · tokens n/a · taskId job-oc · session fixture-opencode-session',
  )
  expect(s.probeScripts.length).toBe(0)
})

test('a claude job footer names the model from the stream and skips the codex probe', async ($, on) => {
  const s = fresh({ now: 9000000 })
  seedJob(s, 'job-claude', { runner: 'claude', model: 'fixture-model', driver: 'claudeAgent' }, 1000000)
  s.files.set(`${JOBS}/job-claude/exit`, '0')
  s.files.set(`${JOBS}/job-claude/last.txt`, 'FAKE')
  s.mtimes.set(`${JOBS}/job-claude/exit`, 1060000)
  s.extractSummary = { tid: 'ses-claude', in: 11, out: 4, error: false, model: 'fixture-model-claude' }
  stubs(on, s)
  await start($)
  expect(await orq($, 'result job-claude')).toBe(
    'FAKE\n\n— orq · manual · fixture-model-claude · effort n/a · 1m · 11/4 tokens · taskId job-claude · session ses-claude',
  )
  expect(s.probeScripts.length).toBe(0)
})

test('a claude job footer names the effort its meta.json recorded', async ($, on) => {
  const s = fresh({ now: 9000000 })
  seedJob(s, 'job-claude-low', { runner: 'claude', model: 'fixture-model', driver: 'claudeAgent', effort: 'low' }, 1000000)
  s.files.set(`${JOBS}/job-claude-low/exit`, '0')
  s.files.set(`${JOBS}/job-claude-low/last.txt`, 'FAKE')
  s.mtimes.set(`${JOBS}/job-claude-low/exit`, 1060000)
  s.extractSummary = { tid: 'ses-claude', in: 11, out: 4, error: false, model: 'fixture-model-claude' }
  stubs(on, s)
  await start($)
  expect(await orq($, 'result job-claude-low')).toBe(
    'FAKE\n\n— orq · manual · fixture-model-claude · effort low · 1m · 11/4 tokens · taskId job-claude-low · session ses-claude',
  )
})

test('a job without runner takes it from its driver, so the extractor still decides its outcome', async ($, on) => {
  const s = fresh({ now: 9000000 })
  seedJob(s, 'job-drv', { runner: undefined, driver: 'claudeAgent', model: 'fixture-model' }, 1000000)
  s.files.set(`${JOBS}/job-drv/exit`, '0')
  s.files.set(`${JOBS}/job-drv/last.txt`, 'FAKE')
  s.extractSummary = { tid: 'ses-drv', in: 3, out: 1, error: true }
  stubs(on, s)
  await start($)
  expect(await orq($, 'result job-drv')).toBe('orq: job-drv failed (exit 0)')
})

test('list skips a job whose meta.json is corrupt and keeps the others', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [
    { name: 'job-corrupt', kind: 'dir' },
    { name: 'job-good', kind: 'dir' },
  ]
  s.files.set(`${JOBS}/job-corrupt/meta.json`, '{"id": "job-corrupt", "kind":')
  seedJob(s, 'job-good', {}, 4000000)
  stubs(on, s)
  await start($)
  const lines = (await orq($, 'list')).split('\n')
  expect(lines.length).toBe(2)
  expect(lines[1]?.split(/\s+/)[0]).toBe('job-good')
  expect(await orq($, 'result job-corrupt')).toBe('orq: unknown job job-corrupt')
})

test('list over a jobs directory that does not exist says there are no jobs', async ($, on) => {
  const s = fresh()
  s.files.set(CONFIG_PATH, JSON.stringify({ jobsDir: '/srv/example/missing-jobs' }))
  stubs(on, s)
  await start($)
  expect(await orq($, 'list')).toBe('orq: no jobs yet')
})

test('result of a failed job gives the exit code and the stderr tail with the token redacted', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-bad', {}, 1000000)
  s.files.set(`${JOBS}/job-bad/exit`, '1')
  s.stderrTail = 'Error: request refused\nAuthorization: Bearer fixture-bearer-value\n'
  stubs(on, s)
  await start($)
  const text = await orq($, 'result job-bad')
  expect(text).toBe('orq: job-bad failed (exit 1)\nError: request refused\nAuthorization: [REDACTED]')
  expect(text.includes('fixture-bearer-value')).toBe(false)
})

test('result of a job that exited 124 says it was cancelled', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-cut', {}, 1000000)
  s.files.set(`${JOBS}/job-cut/exit`, '124')
  stubs(on, s)
  await start($)
  expect(await orq($, 'result job-cut')).toBe('orq: job-cut was cancelled (exit 124)')
})

test('result of a job without an exit file says it is still running while its supervisor lives', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-run', {}, 1000000)
  stubs(on, s)
  await start($)
  expect(await orq($, 'result job-run')).toBe('orq: job-run is still running')
})

test('result of a job whose supervisor is gone without an exit file says it was interrupted', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-gone', {}, 1000000)
  s.goneJobs.add('job-gone')
  stubs(on, s)
  await start($)
  expect(await orq($, 'result job-gone')).toBe(
    'orq: job-gone was interrupted: its supervisor is gone and it left no exit file',
  )
})

test('result of an unknown job id, an unsafe one or none says unknown job', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect(await orq($, 'result nope')).toBe('orq: unknown job nope')
  expect(await orq($, 'result ../x')).toBe('orq: unknown job ../x')
  expect(await orq($, 'result')).toBe('orq: unknown job (missing)')
})

test('cancel writes the cancel file for a known job and refuses any other id', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-a')
  stubs(on, s)
  await start($)
  expect((await orq($, 'cancel job-a'))).toBe('orq: cancel requested for job-a')
  expect(s.writes.some((w) => w.path === `${JOBS}/job-a/cancel`)).toBe(true)
  expect((await orq($, 'cancel ../x'))).toBe('orq: unknown job ../x')
  expect((await orq($, 'cancel'))).toBe('orq: unknown job (missing)')
})

test('cancel says so and writes nothing for a finished or interrupted job', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-fin')
  s.files.set(`${JOBS}/job-fin/exit`, '0')
  s.files.set(`${JOBS}/job-fin/last.txt`, 'OK')
  seedJob(s, 'job-int')
  s.goneJobs.add('job-int')
  stubs(on, s)
  await start($)
  expect(await orq($, 'cancel job-fin')).toBe('orq: job-fin already finished (done)')
  expect(await orq($, 'cancel job-int')).toBe('orq: job-int has no live supervisor; nothing to cancel')
  expect(s.writes.some((w) => w.path.endsWith('/cancel'))).toBe(false)
})

test('parseLaunch splits at the first -- and refuses what cannot run', () => {
  expect(parseLaunch('codex fixture-model -- do -- it')).toEqual({ instance: 'codex', model: 'fixture-model', prompt: 'do -- it' })
  expect(parseLaunch('codex fixture-model -- -dash prompt')).toEqual({ instance: 'codex', model: 'fixture-model', prompt: '-dash prompt' })
  expect(parseLaunch('codex fixture-model --')).toEqual({ error: 'the prompt after -- is empty' })
  expect(parseLaunch('codex -- go')).toEqual({ error: 'usage: /orq launch [--worktree] INSTANCE MODEL -- PROMPT' })
})

test('shell words, footer, duration, job ids and redaction keep their contracts', () => {
  expect(shellWord('/srv/a.b-c_d:e@f')).toBe('/srv/a.b-c_d:e@f')
  expect(shellWord("it's a b")).toBe(`'it'\\''s a b'`)
  expect(shellWord('')).toBe(`''`)
  expect(formatDuration(45000)).toBe('45s')
  expect(formatDuration(725000)).toBe('12m05s')
  expect(
    buildFooter({ kind: 'manual', model: 'm', effort: 'n/a', durationMs: 60000, inTokens: null, outTokens: null, taskId: 'manual-1', session: 's' }),
  ).toBe('— orq · manual · m · effort n/a · 1m · tokens n/a · taskId manual-1 · session s')
  expect(isSafeJobId('manual-1-a1b2c3d4-xyz')).toBe(true)
  expect(isSafeJobId('../evil')).toBe(false)
  expect(isSafeJobId('a/b')).toBe(false)
  expect(renderTable([{ id: 'a', kind: 'manual', status: 'running', elapsed: '6m', cwd: '/work' }])).toContain('running')
  const prose = 'exit 1: command not found: codex\nno credentials here, just words'
  expect(redactSecrets(prose)).toBe(prose)
  expect(failureSnippet(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')).split('\n').length).toBe(20)
})

// The checkout lock. A shared launch into /work claims JOBS/.locks/<sha256 of the checkout> for its job id before
// it writes meta.json. The stub keeps the lock directories it was asked to make, so a test can see who holds one.
const WORK_LOCK = `${JOBS}/.locks/${sha256Hex('/work')}`
const LAUNCH = 'launch codex fixture-model -- go'

function seedLock(s: State, owner: string | null, ageMs: number) {
  s.locks.set(WORK_LOCK, owner)
  if (owner !== null) s.files.set(`${WORK_LOCK}/owner`, `${owner}\n`)
  s.mtimes.set(WORK_LOCK, s.now - ageMs)
}

function takeLock(s: State, owner: string) {
  s.locks.set(WORK_LOCK, owner)
  s.files.set(`${WORK_LOCK}/owner`, `${owner}\n`)
  s.mtimes.set(WORK_LOCK, s.now)
}

test('a shared launch claims the checkout lock for its job id after its directory exists and before meta.json', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  stubs(on, s)
  await start($)
  const id = launchedId(await orq($, LAUNCH))
  expect(s.locks.get(WORK_LOCK)).toBe(id)
  expect(s.events.filter((step) => ['mkdir', 'lock claim', 'write meta.json', 'start'].includes(step))).toEqual([
    'mkdir',
    'lock claim',
    'write meta.json',
    'start',
  ])
})

test('a second shared launch into a held checkout is refused worktree_busy naming the owner, and the lock stays', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  stubs(on, s)
  await start($)
  const first = launchedId(await orq($, LAUNCH))
  expect(await orq($, LAUNCH)).toBe(`orq: manual refused: worktree_busy: /work is in use by job ${first}`)
  expect(s.startScripts.length).toBe(1)
  expect(s.locks.get(WORK_LOCK)).toBe(first)
})

test('a lock whose owner has exited, or lost its supervisor, is broken and the launch takes it', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  seedLock(s, 'job-done', 0)
  s.files.set(`${JOBS}/job-done/exit`, '0')
  stubs(on, s)
  await start($)
  const second = launchedId(await orq($, LAUNCH))
  expect(s.locks.get(WORK_LOCK)).toBe(second)
  expect(s.events.filter((step) => step === 'lock aside').length).toBe(1)
  s.goneJobs.add(second)
  const third = launchedId(await orq($, LAUNCH))
  expect(s.locks.get(WORK_LOCK)).toBe(third)
})

test('an owner with no pgid and no exit keeps a lock younger than 10 s, and loses one that is 10 s old', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  seedLock(s, 'job-slow', 9999)
  s.noPgid.add('job-slow')
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual refused: worktree_busy: /work is in use by job job-slow')
  expect(s.locks.get(WORK_LOCK)).toBe('job-slow')
  expect(s.events.includes('lock aside')).toBe(false)
  s.mtimes.set(WORK_LOCK, s.now - 10000)
  expect(s.locks.get(WORK_LOCK)).toBe('job-slow')
  expect(launchedId(await orq($, LAUNCH)).startsWith('manual-')).toBe(true)
  expect(s.locks.get(WORK_LOCK)).not.toBe('job-slow')
})

test('an owner that starts between the first look and the break keeps its lock', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  seedLock(s, 'job-slow', 10000)
  s.noPgid.add('job-slow')
  s.onMutex = () => s.noPgid.delete('job-slow')
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual refused: worktree_busy: /work is in use by job job-slow')
  expect(s.locks.get(WORK_LOCK)).toBe('job-slow')
  expect(s.events.includes('lock aside')).toBe(false)
})

test('a lock with no owner yet is a launch in progress for 10 s, and is broken after that', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  seedLock(s, null, 2000)
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual refused: worktree_busy: /work is in use by a launch in progress')
  expect(s.startScripts.length).toBe(0)
  s.mtimes.set(WORK_LOCK, s.now - 10000)
  const id = launchedId(await orq($, LAUNCH))
  expect(s.locks.get(WORK_LOCK)).toBe(id)
})

test('a live worktree job stored under a symlink spelling of the checkout refuses a shared launch at that spelling', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  s.realPaths.set('/work', '/real/work')
  s.files.set('/real/work/.git', '')
  s.dirEntries = [{ name: 'job-linked', kind: 'dir' }]
  seedJob(s, 'job-linked', { cwd: '/real/work-wt/job-linked', repo: '/work' })
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual refused: worktree_busy: /work is in use by job job-linked')
  expect(s.locks.size).toBe(0)
  expect(s.startScripts.length).toBe(0)
})

test('a job in a subdirectory of the launch\'s own spelling of a symlinked checkout counts as well', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  s.realPaths.set('/work', '/real/work')
  s.files.set('/real/work/.git', '')
  s.dirEntries = [{ name: 'job-deep', kind: 'dir' }]
  seedJob(s, 'job-deep', { cwd: '/work/pkg/deep' })
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual refused: worktree_busy: /work is in use by job job-deep')
})

test('a launch that scans for a long time keeps its lock younger than the grace, and touches it again before meta.json and before the start', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  s.dirEntries = Array.from({ length: 12 }, (_, i) => ({ name: `job-${i}`, kind: 'dir' }))
  for (const entry of s.dirEntries) seedJob(s, entry.name, { cwd: '/elsewhere' })
  const lockAges: number[] = []
  s.onRead = (path) => {
    if (!path.endsWith('/meta.json')) return
    lockAges.push(s.now - (s.mtimes.get(WORK_LOCK) ?? s.now))
    s.now += 2000
  }
  stubs(on, s)
  await start($)
  launchedId(await orq($, LAUNCH))
  expect(lockAges.length).toBe(12)
  expect(Math.max(...lockAges)).toBeLessThan(LAUNCH_GRACE_MS)
  const lastSteps = s.events.filter((step) => step === 'lock touch' || step === 'write meta.json' || step === 'start')
  expect(lastSteps.slice(-4)).toEqual(['lock touch', 'write meta.json', 'lock touch', 'start'])
})

test('a launch whose lock was broken and taken during its scan refuses before it writes a job, and leaves the new lock', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  s.dirEntries = [{ name: 'job-0', kind: 'dir' }]
  seedJob(s, 'job-0', { cwd: '/elsewhere' })
  s.onRead = (path) => {
    if (path.endsWith('/job-0/meta.json')) takeLock(s, 'job-taker')
  }
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual refused: worktree_busy: /work is in use by a launch in progress')
  expect(s.events.includes('write meta.json')).toBe(false)
  expect(s.startScripts.length).toBe(0)
  expect(s.locks.get(WORK_LOCK)).toBe('job-taker')
  expect(s.events.includes('lock aside')).toBe(false)
  expect(s.writes.find((w) => w.path.endsWith('/exit'))?.text).toBe('125')
})

test('a launch whose lock was broken and taken while it wrote its job files refuses before it starts, and leaves the new lock', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  s.onWrite = (path) => {
    if (path.endsWith('/prompt.txt')) takeLock(s, 'job-taker')
  }
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual refused: worktree_busy: /work is in use by a launch in progress')
  expect(s.events.includes('start')).toBe(false)
  expect(s.startScripts.length).toBe(0)
  expect(s.locks.get(WORK_LOCK)).toBe('job-taker')
  expect(s.events.includes('lock aside')).toBe(false)
  expect(s.writes.find((w) => w.path.endsWith('/exit'))?.text).toBe('125')
})

test('a launch that finds a live job in its directory gives its lock back before it refuses', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  s.dirEntries = [{ name: 'job-live', kind: 'dir' }]
  seedJob(s, 'job-live', { cwd: '/work' })
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual refused: worktree_busy: /work is in use by job job-live')
  expect(s.events.includes('lock claim')).toBe(true)
  expect(s.locks.size).toBe(0)
  expect(s.writes.find((w) => w.path.endsWith('/exit'))?.text).toBe('125')
})

test('a launch whose job directory cannot be written gives its lock back', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true, failWritesTo: '/prompt.txt' })
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toContain('could not write its job directory')
  expect(s.events.includes('lock claim')).toBe(true)
  expect(s.locks.size).toBe(0)
})

test('a launch whose supervisor never reports gives its lock back', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true, startExit: 11 })
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toContain('did not report within 5 s')
  expect(s.events.includes('lock claim')).toBe(true)
  expect(s.locks.size).toBe(0)
})

test('a launch that fails never gives back a lock another launcher took after breaking its own', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true, startExit: 11 })
  s.onStart = () => takeLock(s, 'job-taker')
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toContain('did not report within 5 s')
  expect(s.events.includes('lock claim')).toBe(true)
  expect(s.locks.get(WORK_LOCK)).toBe('job-taker')
  expect(s.events.includes('lock aside')).toBe(false)
})

test('two launchers breaking one dead lock never remove the live lock the first of them made', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true })
  seedLock(s, 'job-dead', 0)
  s.files.set(`${JOBS}/job-dead/exit`, '1')
  s.onMutex = () => takeLock(s, 'job-winner')
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual refused: worktree_busy: /work is in use by job job-winner')
  expect(s.locks.get(WORK_LOCK)).toBe('job-winner')
  expect(s.events.includes('lock aside')).toBe(false)
  expect(s.startScripts.length).toBe(0)
})

test('a lock script that fails refuses the launch, starts nothing and records exit 125', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true, lockExit: 9 })
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual could not lock its checkout (exit 9)')
  expect(s.startScripts.length).toBe(0)
  expect(s.writes.find((w) => w.path.endsWith('/exit'))?.text).toBe('125')
})

test('a dead lock that cannot be moved aside refuses the launch as a failure to lock, not as a launch in progress', async ($, on) => {
  const s = fresh({ now: 2000000, locking: true, asideExit: 1 })
  seedLock(s, 'job-dead', 0)
  s.files.set(`${JOBS}/job-dead/exit`, '1')
  stubs(on, s)
  await start($)
  expect(await orq($, LAUNCH)).toBe('orq: manual could not lock its checkout (the old lock could not be moved aside)')
  expect(s.locks.get(WORK_LOCK)).toBe('job-dead')
  expect(s.startScripts.length).toBe(0)
  expect(s.writes.find((w) => w.path.endsWith('/exit'))?.text).toBe('125')
})

test('the .locks directory in the jobs directory is not a job', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [
    { name: '.locks', kind: 'dir' },
    { name: 'job-a', kind: 'dir' },
  ]
  seedJob(s, 'job-a', {}, 4000000)
  stubs(on, s)
  await start($)
  const lines = (await orq($, 'list')).split('\n')
  expect(lines.map((line) => line.split(/\s+/)[0])).toEqual(['id', 'job-a'])
})
