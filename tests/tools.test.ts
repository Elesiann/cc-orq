import { expect, test } from 'claude-code/testing'

// The jobs directory and the config file the tools read.
const JOBS = '/srv/example/jobs'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({ jobsDir: JOBS })

type State = {
  now: number
  files: Map<string, string>
  writes: { path: string; text: string }[]
  mtimes: Map<string, number>
  goneJobs: Set<string>
  stderrTail: string
  extractSummary: { tid: string; in: number | null; out: number | null; error: boolean }
}

function fresh(o: Partial<State> = {}): State {
  return {
    now: 9000000,
    files: new Map([[CONFIG_PATH, CONFIG]]),
    writes: [],
    mtimes: new Map(),
    goneJobs: new Set(),
    stderrTail: '',
    extractSummary: { tid: '', in: 0, out: 0, error: false },
    ...o,
  }
}

const result = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

function stubs(on: any, s: State) {
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.log', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/test' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('command.register', (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: s.now }))
  on('fs.exists', (_$: unknown, e: any) => ({ value: s.files.has(e.path) }))
  on('fs.read', (_$: unknown, e: any) => {
    if (s.files.has(e.path)) return { value: s.files.get(e.path) }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', (_$: unknown, e: any) => {
    s.writes.push({ path: e.path, text: e.text })
    s.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_$: unknown, e: any) => {
    if (!s.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 0, mtimeMs: s.mtimes.get(e.path) ?? s.now, isLink: false } }
  })
  on('process.run', (_$: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'python3') return result(0, JSON.stringify(s.extractSummary) + '\n')
    const script = argv[2] ?? ''
    if (script.includes('# orq:stderr')) return result(0, s.stderrTail)
    if (script.includes('# orq:liveness')) {
      const gone = [...s.goneJobs].some((id) => script.includes(`${JOBS}/${id}/pgid`))
      return result(gone ? 12 : 11)
    }
    throw new Error(`unexpected process.run: ${script.slice(0, 80)}`)
  })
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

async function call($: any, tool: string, input: Record<string, unknown>): Promise<any> {
  const r = await $.tool.call({ tool, ...input })
  return JSON.parse(r.result)
}

function seedJob(s: State, id: string, startedAt: number, extra: Record<string, unknown> = {}) {
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

const iso = (ms: number) => new Date(ms).toISOString()

test('status answers a running job with working and no end time', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-run', 8000000)
  stubs(on, s)
  await start($)
  expect(await call($, 'mcp__orq__status', { taskId: 'job-run' })).toEqual({
    taskId: 'job-run',
    status: 'running',
    workState: 'working',
    kind: 'manual',
    startedAtIso: iso(8000000),
    instanceId: 'codex',
    model: 'fixture-model',
  })
})

test('status answers a completed job with its final answer and end time', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-ok', 1000000)
  s.files.set(`${JOBS}/job-ok/exit`, '0')
  s.files.set(`${JOBS}/job-ok/last.txt`, 'The answer is 42.')
  s.mtimes.set(`${JOBS}/job-ok/exit`, 4500000)
  s.extractSummary = { tid: 'thread-ok', in: 1, out: 1, error: false }
  stubs(on, s)
  await start($)
  expect(await call($, 'mcp__orq__status', { taskId: 'job-ok' })).toEqual({
    taskId: 'job-ok',
    status: 'completed',
    workState: 'result_available',
    kind: 'manual',
    startedAtIso: iso(1000000),
    finishedAtIso: iso(4500000),
    instanceId: 'codex',
    model: 'fixture-model',
    result: 'The answer is 42.',
  })
})

test('status answers a failed job with the exit code and the redacted stderr tail', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-bad', 1000000)
  s.files.set(`${JOBS}/job-bad/exit`, '1')
  s.mtimes.set(`${JOBS}/job-bad/exit`, 2000000)
  s.stderrTail = 'Error: request refused\nAuthorization: Bearer fixture-bearer-value\n'
  stubs(on, s)
  await start($)
  const answer = await call($, 'mcp__orq__status', { taskId: 'job-bad' })
  expect(answer).toEqual({
    taskId: 'job-bad',
    status: 'failed',
    workState: 'result_available',
    kind: 'manual',
    startedAtIso: iso(1000000),
    finishedAtIso: iso(2000000),
    instanceId: 'codex',
    model: 'fixture-model',
    error: 'failed (exit 1)\nError: request refused\nAuthorization: [REDACTED]',
  })
  expect(JSON.stringify(answer).includes('fixture-bearer-value')).toBe(false)
})

test('status answers a cancelled job, exit 124, as cancelled', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-cut', 1000000)
  s.files.set(`${JOBS}/job-cut/exit`, '124')
  s.mtimes.set(`${JOBS}/job-cut/exit`, 3000000)
  stubs(on, s)
  await start($)
  expect(await call($, 'mcp__orq__status', { taskId: 'job-cut' })).toEqual({
    taskId: 'job-cut',
    status: 'cancelled',
    workState: 'result_available',
    kind: 'manual',
    startedAtIso: iso(1000000),
    finishedAtIso: iso(3000000),
    instanceId: 'codex',
    model: 'fixture-model',
  })
})

test('status answers a job whose supervisor is gone without an exit file as interrupted', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-gone', 1000000)
  s.goneJobs.add('job-gone')
  stubs(on, s)
  await start($)
  expect(await call($, 'mcp__orq__status', { taskId: 'job-gone' })).toEqual({
    taskId: 'job-gone',
    status: 'interrupted',
    workState: 'result_available',
    kind: 'manual',
    startedAtIso: iso(1000000),
    instanceId: 'codex',
    model: 'fixture-model',
    error: 'its supervisor is gone and it left no exit file',
  })
})

test('status of an unknown or unsafe id is task_not_found, and without a taskId invalid_request', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const missing = { error: { code: 'task_not_found', message: 'no task nope' } }
  expect(await call($, 'mcp__orq__status', { taskId: 'nope' })).toEqual(missing)
  expect(await call($, 'mcp__orq__status', { taskId: '../x' })).toEqual({
    error: { code: 'task_not_found', message: 'no task ../x' },
  })
  expect((await call($, 'mcp__orq__status', {})).error.code).toBe('invalid_request')
})

test('cancel of a running job writes the cancel marker and answers cancel_requested', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-a', 8000000)
  stubs(on, s)
  await start($)
  expect(await call($, 'mcp__orq__cancel', { taskId: 'job-a' })).toEqual({
    taskId: 'job-a',
    status: 'cancel_requested',
  })
  const marker = s.writes.find((w) => w.path === `${JOBS}/job-a/cancel`)
  expect(marker?.text.startsWith('cancelled at ')).toBe(true)
})

test('cancel of a finished or interrupted job is task_not_cancellable and writes nothing', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-fin', 1000000)
  s.files.set(`${JOBS}/job-fin/exit`, '0')
  s.files.set(`${JOBS}/job-fin/last.txt`, 'OK')
  seedJob(s, 'job-int', 1000000)
  s.goneJobs.add('job-int')
  stubs(on, s)
  await start($)
  expect(await call($, 'mcp__orq__cancel', { taskId: 'job-fin' })).toEqual({
    error: { code: 'task_not_cancellable', message: 'task job-fin is completed, not running' },
  })
  expect(await call($, 'mcp__orq__cancel', { taskId: 'job-int' })).toEqual({
    error: { code: 'task_not_cancellable', message: 'task job-int is interrupted, not running' },
  })
  expect(s.writes.some((w) => w.path.endsWith('/cancel'))).toBe(false)
  expect((await call($, 'mcp__orq__cancel', { taskId: 'nope' })).error.code).toBe('task_not_found')
})
