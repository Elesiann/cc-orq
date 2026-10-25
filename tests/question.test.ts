import { expect, test } from 'claude-code/testing'

import { QUESTION_FILE, QUESTION_PROTOCOL } from '../hooks/question.ts'

// The child-question paths need only launch, list and result, so this file carries a trimmed copy of
// the engine.test.ts harness. Shared helpers can move into one file once the suites settle.

const JOBS = '/srv/example/jobs'
const CODEX_HOME = '/srv/example/codex-home'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({
  jobsDir: JOBS,
  instances: [
    { id: 'codex', driver: 'codex' },
    { id: 'codex-work', driver: 'codex', env: { CODEX_HOME } },
  ],
})

type State = {
  now: number
  files: Map<string, string>
  writes: { path: string; text: string }[]
  dirEntries: { name: string; kind: string }[]
  startScripts: string[]
  commands: { name: string }[]
  mtimes: Map<string, number>
  goneJobs: Set<string>
}

function fresh(o: Partial<State> = {}): State {
  return {
    now: 1000000,
    files: new Map([[CONFIG_PATH, CONFIG]]),
    writes: [],
    dirEntries: [],
    startScripts: [],
    commands: [],
    mtimes: new Map(),
    goneJobs: new Set(),
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
  on('fs.exists', (_$: unknown, e: any) => ({ value: s.files.has(e.path) }))
  on('fs.read', (_$: unknown, e: any) => {
    if (s.files.has(e.path)) return { value: s.files.get(e.path) }
    if (String(e.path).endsWith('/pgid')) return { value: '4242\n' }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', (_$: unknown, e: any) => {
    s.writes.push({ path: e.path, text: e.text })
    s.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_$: unknown, e: any) => {
    if (e.path !== JOBS) throw new Error(`ENOENT: ${e.path}`)
    return { value: s.dirEntries.map((d) => ({ name: d.name, kind: d.kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_$: unknown, e: any) => {
    if (!s.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 0, mtimeMs: s.mtimes.get(e.path) ?? s.now, isLink: false } }
  })
  on('process.run', (_$: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'python3') return result(1)
    const script = argv[2] ?? ''
    if (script.includes('# orq:mkdir')) return result(0)
    if (script.includes('# orq:lock')) return result(0)
    if (script.includes('# orq:start')) {
      s.startScripts.push(script)
      return result(0)
    }
    if (script.includes('# orq:liveness')) {
      const gone = [...s.goneJobs].some((id) => script.includes(`${JOBS}/${id}/pgid`))
      return result(gone ? 12 : 11)
    }
    throw new Error(`unexpected process.run: ${script.slice(0, 80)}`)
  })
}

async function orq($: any, args: string): Promise<string> {
  const r = await $.command.run({ command: 'orq', args })
  return r.text ?? ''
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

function launchedId(text: string): string {
  const prefix = 'orq: launched '
  expect(text.startsWith(prefix)).toBe(true)
  return text.slice(prefix.length)
}

function seedJob(s: State, id: string, startedAt: number) {
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
    }),
  )
}

test('the job directory reaches every CLI as ORQ_JOB_DIR, through the systemd unit and the setsid fallback', async ($, on) => {
  const s = fresh({ now: 2000000 })
  stubs(on, s)
  await start($)
  const withEnv = launchedId(await orq($, 'launch codex-work fixture-model -- ask if blocked'))
  const withEnvDir = `${JOBS}/${withEnv}`
  expect(s.startScripts[0]).toContain(`--setenv=ORQ_JOB_DIR=${withEnvDir}`)
  expect(s.startScripts[0]).toContain(`setsid env CODEX_HOME=${CODEX_HOME} ORQ_JOB_DIR=${withEnvDir} bash`)
  const plain = launchedId(await orq($, 'launch codex fixture-model -- no env'))
  expect(s.startScripts[1]).toContain(`--setenv=ORQ_JOB_DIR=${JOBS}/${plain}`)
  expect(s.startScripts[1]).toContain(`setsid env ORQ_JOB_DIR=${JOBS}/${plain} bash`)
})

test('an instance env cannot replace ORQ_JOB_DIR in the start script', async ($, on) => {
  const s = fresh({ now: 2000000 })
  s.files.set(CONFIG_PATH, JSON.stringify({ jobsDir: JOBS, instances: [{ id: 'evil', driver: 'codex', env: { ORQ_JOB_DIR: '/evil' } }] }))
  stubs(on, s)
  await start($)
  const id = launchedId(await orq($, 'launch evil fixture-model -- no override'))
  expect(s.startScripts[0]).toContain(`ORQ_JOB_DIR=${JOBS}/${id}`)
  expect(s.startScripts[0]).not.toContain('/evil')
})

test('a job that wrote question.txt and has no exit is waiting, and a blank question is not', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [
    { name: 'job-asked', kind: 'dir' },
    { name: 'job-blank', kind: 'dir' },
  ]
  seedJob(s, 'job-asked', 4000000)
  s.files.set(`${JOBS}/job-asked/question.txt`, 'Which database should the migration target?\n')
  seedJob(s, 'job-blank', 4000000)
  s.files.set(`${JOBS}/job-blank/question.txt`, '  \n')
  stubs(on, s)
  await start($)
  const lines = (await orq($, 'list')).split('\n')
  const rowOf = (id: string) => lines.find((l) => l.startsWith(id))?.split(/\s+/)
  expect(rowOf('job-asked')).toEqual(['job-asked', 'manual', 'waiting', '10m', 'manual', '/work'])
  expect(rowOf('job-blank')?.[2]).toBe('running')
  expect(await orq($, 'result job-asked')).toBe('orq: job-asked is waiting for an answer to its question')
  expect(await orq($, 'cancel job-asked')).toBe('orq: cancel requested for job-asked')
})

test('a job that asked a question and whose supervisor is gone is interrupted, and cancel writes nothing', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [{ name: 'job-asked-gone', kind: 'dir' }]
  seedJob(s, 'job-asked-gone', 4000000)
  s.files.set(`${JOBS}/job-asked-gone/question.txt`, 'Which database should the migration target?\n')
  s.goneJobs.add('job-asked-gone')
  stubs(on, s)
  await start($)
  expect(rowStatus(await orq($, 'list'), 'job-asked-gone')).toBe('interrupted')
  expect(await orq($, 'result job-asked-gone')).toBe(
    'orq: job-asked-gone was interrupted: its supervisor is gone and it left no exit file',
  )
  expect(await orq($, 'cancel job-asked-gone')).toBe('orq: job-asked-gone has no live supervisor; nothing to cancel')
  expect(s.writes.some((w) => w.path.endsWith('/cancel'))).toBe(false)
})

function rowStatus(listText: string, id: string): string | undefined {
  return listText.split('\n').find((l) => l.startsWith(id))?.split(/\s+/)[2]
}

test('a job that exits 0 after asking lists as done and composes the BLOCKED answer with the literal question', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [{ name: 'job-asked', kind: 'dir' }]
  seedJob(s, 'job-asked', 4000000)
  s.files.set(`${JOBS}/job-asked/question.txt`, 'Use `main` or `release/1.x`? (see $ORQ_JOB_DIR)\n')
  s.files.set(`${JOBS}/job-asked/exit`, '0')
  s.files.set(`${JOBS}/job-asked/last.txt`, 'BLOCKED: Use `main` or `release/1.x`?')
  stubs(on, s)
  await start($)
  expect(rowStatus(await orq($, 'list'), 'job-asked')).toBe('done')
  expect(await orq($, 'result job-asked')).toBe(
    'BLOCKED on a question (taskId job-asked): Use `main` or `release/1.x`? (see $ORQ_JOB_DIR)\n\n' +
      'Answer it in a new cc-orq:task with the original brief plus the answer.',
  )
})

test('a job that exits 0 after asking, with no last.txt, lists as done and answers BLOCKED', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [{ name: 'job-quiet', kind: 'dir' }]
  seedJob(s, 'job-quiet', 4000000)
  s.files.set(`${JOBS}/job-quiet/question.txt`, 'Which database?\n')
  s.files.set(`${JOBS}/job-quiet/exit`, '0')
  stubs(on, s)
  await start($)
  expect(rowStatus(await orq($, 'list'), 'job-quiet')).toBe('done')
  expect(await orq($, 'result job-quiet')).toBe(
    'BLOCKED on a question (taskId job-quiet): Which database?\n\n' +
      'Answer it in a new cc-orq:task with the original brief plus the answer.',
  )
})

test('a question left by a job that failed or was cancelled is not answered as BLOCKED', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [
    { name: 'job-failed', kind: 'dir' },
    { name: 'job-cancelled', kind: 'dir' },
  ]
  seedJob(s, 'job-failed', 4000000)
  s.files.set(`${JOBS}/job-failed/question.txt`, 'Which database?\n')
  s.files.set(`${JOBS}/job-failed/exit`, '1')
  seedJob(s, 'job-cancelled', 4000000)
  s.files.set(`${JOBS}/job-cancelled/question.txt`, 'Which database?\n')
  s.files.set(`${JOBS}/job-cancelled/exit`, '124')
  stubs(on, s)
  await start($)
  const list = await orq($, 'list')
  expect(rowStatus(list, 'job-failed')).toBe('failed')
  expect(rowStatus(list, 'job-cancelled')).toBe('cancelled')
  expect(await orq($, 'result job-failed')).toBe('orq: job-failed failed (exit 1)')
  expect(await orq($, 'result job-cancelled')).toBe('orq: job-cancelled was cancelled (exit 124)')
})

test('a manual launch ends its prompt with the question protocol after the user text', async ($, on) => {
  const s = fresh({ now: 2000000 })
  stubs(on, s)
  await start($)
  const id = launchedId(await orq($, 'launch codex fixture-model -- Do the thing'))
  const prompt = s.writes.find((w) => w.path === `${JOBS}/${id}/prompt.txt`)?.text ?? ''
  expect(prompt.startsWith('Do the thing\n\n')).toBe(true)
  expect(prompt.endsWith(QUESTION_PROTOCOL)).toBe(true)
})

test('the question protocol fits in 300 bytes and points at the file the engine reads', () => {
  expect(new TextEncoder().encode(QUESTION_PROTOCOL).length).toBeLessThanOrEqual(300)
  expect(QUESTION_PROTOCOL).toContain(`$ORQ_JOB_DIR/${QUESTION_FILE}`)
  expect(QUESTION_PROTOCOL).toContain('BLOCKED:')
})
