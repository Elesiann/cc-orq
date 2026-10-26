import { expect, test } from 'claude-code/testing'

import { loadConfig } from '../hooks/config.ts'
import { parentRuntimeModeFromPermissionMode } from '../hooks/target.ts'
import { cancelAnswer, capabilitiesAnswer, newCatalogCache, statusAnswer } from '../hooks/tools.ts'

// The answers of the orq tools, called through the functions the MCP server serves them with. The jobs directory
// and the config file are the ones the tools read.
const JOBS = '/srv/example/jobs'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({ jobsDir: JOBS })

type State = {
  now: number
  files: Map<string, string>
  writes: { path: string; text: string }[]
  mtimes: Map<string, number>
  goneJobs: Set<string>
  dirEntries: { name: string; kind: string }[]
  stderrTail: string
  extractSummary: { tid: string; in: number | null; out: number | null; error: boolean }
  catalogJson: string
  catalogExit: number
  catalogCalls: string[]
  /** The probe cache the server would hold for the process. */
  catalog: ReturnType<typeof newCatalogCache>
  tools: string[]
  logs: string[]
}

const CATALOG = JSON.stringify([
  {
    instanceId: 'codex',
    driver: 'codex',
    displayName: null,
    enabled: true,
    installed: true,
    authenticated: true,
    unavailableReason: null,
    models: [{ id: 'fixture-model-1', label: 'Fixture Model One', options: [{ id: 'reasoningEffort', label: 'Reasoning effort', type: 'select', options: [{ id: 'low', label: 'low' }], currentValue: 'low' }] }],
  },
  {
    instanceId: 'opencode',
    driver: 'opencode',
    displayName: null,
    enabled: true,
    installed: false,
    authenticated: null,
    unavailableReason: "Executable 'opencode' was not found on PATH.",
    models: [],
  },
])

function fresh(o: Partial<State> = {}): State {
  return {
    now: 9000000,
    files: new Map([[CONFIG_PATH, CONFIG]]),
    writes: [],
    mtimes: new Map(),
    goneJobs: new Set(),
    dirEntries: [],
    stderrTail: '',
    extractSummary: { tid: '', in: 0, out: 0, error: false },
    catalogJson: CATALOG,
    catalogExit: 0,
    catalogCalls: [],
    catalog: newCatalogCache(),
    tools: [],
    logs: [],
    ...o,
  }
}

const result = (exitCode: number, stdout = '') => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

function readFile(s: State, path: string): string {
  const text = s.files.get(path)
  if (text === undefined) throw new Error(`ENOENT: ${path}`)
  return text
}

function writeFile(s: State, path: string, text: string): void {
  s.writes.push({ path, text })
  s.files.set(path, text)
}

function listDir(s: State, path: string) {
  if (path !== JOBS) throw new Error(`ENOENT: ${path}`)
  return s.dirEntries.map((d) => ({ name: d.name, kind: d.kind, size: 0, mtimeMs: 0, isLink: false }))
}

function statFile(s: State, path: string) {
  if (!s.files.has(path)) throw new Error(`ENOENT: ${path}`)
  return { kind: 'file', size: 0, mtimeMs: s.mtimes.get(path) ?? s.now, isLink: false }
}

function runProcess(s: State, argv: string[], init?: { stdin?: string }) {
  if (argv[0] === 'python3' && String(argv[1]).endsWith('catalog.py')) {
    s.catalogCalls.push(String(init?.stdin))
    return result(s.catalogExit, s.catalogJson + '\n')
  }
  if (argv[0] === 'python3') return result(0, JSON.stringify(s.extractSummary) + '\n')
  const script = argv[2] ?? ''
  if (script.includes('# orq:stderr')) return result(0, s.stderrTail)
  if (script.includes('# orq:liveness')) {
    const gone = [...s.goneJobs].some((id) => script.includes(`${JOBS}/${id}/pgid`))
    return result(gone ? 12 : 11)
  }
  throw new Error(`unexpected process.run: ${script.slice(0, 80)}`)
}

/** The part of `$` the job core calls, over the state of one test. The kit's own `$` has no such members. */
function engineOf(s: State): any {
  return {
    clock: { now: async () => s.now },
    env: { get: async () => '/home/test' },
    plugin: { root: '/plugin' },
    ui: { log: async (text: string) => void s.logs.push(text) },
    fs: {
      exists: async (path: string) => s.files.has(path),
      read: async (path: string) => readFile(s, path),
      write: async (path: string, text: string) => writeFile(s, path, text),
      list: async (path: string) => listDir(s, path),
      stat: async (path: string) => statFile(s, path),
    },
    process: { run: async (argv: string[], init?: { stdin?: string }) => runProcess(s, argv, init) },
  }
}

/** The hooks of the mod, for the one test that drives session.start. */
function stubs(on: any, s: State) {
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.log', (_$: unknown, e: any) => {
    s.logs.push(e.text)
    return { value: undefined }
  })
  on('tool.register', (_$: unknown, e: any) => {
    s.tools.push(e.name)
    return { value: { tool: 'mcp__cc-orq__wait' } }
  })
  on('agent.register', (_$: unknown, e: any) => ({ value: { agent: `orq:${e.name}` } }))
  on('fs.list', (_$: unknown, e: any) => ({ value: listDir(s, e.path) }))
  on('env.get', () => ({ value: '/home/test' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('command.register', (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: s.now }))
  on('fs.exists', (_$: unknown, e: any) => ({ value: s.files.has(e.path) }))
  on('fs.read', (_$: unknown, e: any) => ({ value: readFile(s, e.path) }))
  on('fs.write', (_$: unknown, e: any) => {
    writeFile(s, e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_$: unknown, e: any) => ({ value: statFile(s, e.path) }))
  on('process.run', (_$: unknown, e: any) => ({ value: runProcess(s, e.argv, e.init) }))
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

const configOf = async ($: any) => (await loadConfig($)).config
const status = async ($: any, input: Record<string, unknown>): Promise<any> => statusAnswer($, await configOf($), input)
const cancel = async ($: any, input: Record<string, unknown>): Promise<any> => cancelAnswer($, await configOf($), input)
// The server passes the modes of an unknown session mode until the session's mode reaches it.
const capabilities = async ($: any, s: State, modes = parentRuntimeModeFromPermissionMode(undefined)): Promise<any> =>
  capabilitiesAnswer($, await configOf($), modes, s.catalog)

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

test('status answers a running job with working and no end time', async () => {
  const s = fresh()
  seedJob(s, 'job-run', 8000000)
  const $ = engineOf(s)
  expect(await status($, { taskId: 'job-run' })).toEqual({
    taskId: 'job-run',
    status: 'running',
    workState: 'working',
    kind: 'manual',
    startedAtIso: iso(8000000),
    instanceId: 'codex',
    model: 'fixture-model',
  })
})

test('status answers a completed job with its final answer and end time', async () => {
  const s = fresh()
  seedJob(s, 'job-ok', 1000000)
  s.files.set(`${JOBS}/job-ok/exit`, '0')
  s.files.set(`${JOBS}/job-ok/last.txt`, 'The answer is 42.')
  s.mtimes.set(`${JOBS}/job-ok/exit`, 4500000)
  s.extractSummary = { tid: 'thread-ok', in: 1, out: 1, error: false }
  const $ = engineOf(s)
  expect(await status($, { taskId: 'job-ok' })).toEqual({
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

test('status answers a job that wrote a question and still runs as waiting', async () => {
  const s = fresh()
  seedJob(s, 'job-ask', 8000000)
  s.files.set(`${JOBS}/job-ask/question.txt`, 'Which branch?\n')
  const $ = engineOf(s)
  expect(await status($, { taskId: 'job-ask' })).toMatchObject({ taskId: 'job-ask', status: 'waiting', workState: 'working' })
})

test('status answers a job that exited 0 after a question as completed, with the BLOCKED text as its result', async () => {
  const s = fresh()
  seedJob(s, 'job-blk', 1000000)
  s.files.set(`${JOBS}/job-blk/question.txt`, 'Which branch?\n')
  s.files.set(`${JOBS}/job-blk/exit`, '0')
  s.files.set(`${JOBS}/job-blk/session`, 'ses-blk\n')
  s.files.set(`${JOBS}/job-blk/last.txt`, 'BLOCKED: Which branch?')
  const $ = engineOf(s)
  const answer = await status($, { taskId: 'job-blk' })
  expect(answer).toMatchObject({ status: 'completed', workState: 'result_available' })
  expect(answer.result).toBe('BLOCKED on a question (taskId job-blk): Which branch?\n\nAnswer it with the answer tool; the same worker resumes its session.')
})

test('status of a question in an open human form says the user is answering it, not the answer tool', async () => {
  const s = fresh()
  seedJob(s, 'job-form', 1000000, { questions: 'human' })
  s.files.set(`${JOBS}/job-form/question.txt`, 'Which branch?\n')
  s.files.set(`${JOBS}/job-form/exit`, '0')
  s.files.set(`${JOBS}/job-form/session`, 'ses-form\n')
  s.files.set(`${JOBS}/job-form/last.txt`, 'BLOCKED: Which branch?')
  const $ = engineOf(s)
  const answer = await status($, { taskId: 'job-form' })
  expect(answer.result).toBe(
    'BLOCKED on a question (taskId job-form): Which branch?\n\nThe user is answering it in a form; the answer tool takes over once the form is declined, cancelled or 24 hours old.',
  )
})

test('status answers a failed job with the exit code and the redacted stderr tail', async () => {
  const s = fresh()
  seedJob(s, 'job-bad', 1000000)
  s.files.set(`${JOBS}/job-bad/exit`, '1')
  s.mtimes.set(`${JOBS}/job-bad/exit`, 2000000)
  s.stderrTail = 'Error: request refused\nAuthorization: Bearer fixture-bearer-value\n'
  const $ = engineOf(s)
  const answer = await status($, { taskId: 'job-bad' })
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

test('status answers a cancelled job, exit 124, as cancelled', async () => {
  const s = fresh()
  seedJob(s, 'job-cut', 1000000)
  s.files.set(`${JOBS}/job-cut/exit`, '124')
  s.mtimes.set(`${JOBS}/job-cut/exit`, 3000000)
  const $ = engineOf(s)
  expect(await status($, { taskId: 'job-cut' })).toEqual({
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

test('status answers a job whose supervisor is gone without an exit file as interrupted', async () => {
  const s = fresh()
  seedJob(s, 'job-gone', 1000000)
  s.goneJobs.add('job-gone')
  const $ = engineOf(s)
  expect(await status($, { taskId: 'job-gone' })).toEqual({
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

test('status of an unknown or unsafe id is task_not_found, and without a taskId invalid_request', async () => {
  const s = fresh()
  const $ = engineOf(s)
  const missing = { error: { code: 'task_not_found', message: 'no task nope' } }
  expect(await status($, { taskId: 'nope' })).toEqual(missing)
  expect(await status($, { taskId: '../x' })).toEqual({
    error: { code: 'task_not_found', message: 'no task ../x' },
  })
  expect((await status($, {})).error.code).toBe('invalid_request')
})

test('cancel of a running job writes the cancel marker and answers cancel_requested', async () => {
  const s = fresh()
  seedJob(s, 'job-a', 8000000)
  const $ = engineOf(s)
  expect(await cancel($, { taskId: 'job-a' })).toEqual({
    taskId: 'job-a',
    status: 'cancel_requested',
  })
  const marker = s.writes.find((w) => w.path === `${JOBS}/job-a/cancel`)
  expect(marker?.text.startsWith('cancelled at ')).toBe(true)
})

test('cancel of a waiting job, one that wrote a question and still runs, writes the marker and answers cancel_requested', async () => {
  const s = fresh()
  seedJob(s, 'job-ask', 8000000)
  s.files.set(`${JOBS}/job-ask/question.txt`, 'Which branch?\n')
  const $ = engineOf(s)
  expect(await cancel($, { taskId: 'job-ask' })).toEqual({ taskId: 'job-ask', status: 'cancel_requested' })
  expect(s.writes.some((w) => w.path === `${JOBS}/job-ask/cancel`)).toBe(true)
})

test('cancel of a finished or interrupted job is task_not_cancellable and writes nothing', async () => {
  const s = fresh()
  seedJob(s, 'job-fin', 1000000)
  s.files.set(`${JOBS}/job-fin/exit`, '0')
  s.files.set(`${JOBS}/job-fin/last.txt`, 'OK')
  seedJob(s, 'job-int', 1000000)
  s.goneJobs.add('job-int')
  const $ = engineOf(s)
  expect(await cancel($, { taskId: 'job-fin' })).toEqual({
    error: { code: 'task_not_cancellable', message: 'task job-fin is completed, so it has nothing left to cancel' },
  })
  expect(await cancel($, { taskId: 'job-int' })).toEqual({
    error: { code: 'task_not_cancellable', message: 'task job-int is interrupted, so it has nothing left to cancel' },
  })
  expect(s.writes.some((w) => w.path.endsWith('/cancel'))).toBe(false)
  expect((await cancel($, { taskId: 'nope' })).error.code).toBe('task_not_found')
})

test('cancel writes its reason into the cancel marker', async () => {
  const s = fresh()
  seedJob(s, 'job-why', 8000000)
  const $ = engineOf(s)
  expect(await cancel($, { taskId: 'job-why', reason: 'the user stopped it' })).toEqual({
    taskId: 'job-why',
    status: 'cancel_requested',
  })
  const marker = s.writes.find((w) => w.path === `${JOBS}/job-why/cancel`)
  expect(marker?.text.includes('why="the user stopped it"')).toBe(true)
})

test('cancel refuses a reason that is not a string or is longer than 200 characters, and writes nothing', async () => {
  const s = fresh()
  seedJob(s, 'job-long', 8000000)
  const $ = engineOf(s)
  const tooLong = await cancel($, { taskId: 'job-long', reason: 'x'.repeat(201) })
  expect(tooLong.error.code).toBe('invalid_request')
  const notText = await cancel($, { taskId: 'job-long', reason: 5 })
  expect(notText.error.code).toBe('invalid_request')
  expect(s.writes.some((w) => w.path.endsWith('/cancel'))).toBe(false)
  const atLimit = await cancel($, { taskId: 'job-long', reason: 'x'.repeat(200) })
  expect(atLimit).toEqual({ taskId: 'job-long', status: 'cancel_requested' })
})

test('a job with a cancel request still reads as running, and cancelling it again answers cancel_requested', async () => {
  const s = fresh()
  seedJob(s, 'job-again', 8000000)
  s.files.set(`${JOBS}/job-again/cancel`, 'cancelled at 1970-01-01T00:00:00.000Z\n')
  const $ = engineOf(s)
  expect((await status($, { taskId: 'job-again' })).status).toBe('running')
  expect(await cancel($, { taskId: 'job-again', reason: 'second request' })).toEqual({
    taskId: 'job-again',
    status: 'cancel_requested',
  })
  expect(s.writes.some((w) => w.path === `${JOBS}/job-again/cancel` && w.text.includes('why="second request"'))).toBe(true)
})

test('capabilities lists the probed providers with the modes of an unknown session mode and the probe sees the configured instances', async () => {
  const s = fresh()
  const $ = engineOf(s)
  expect(await capabilities($, s)).toEqual({
    parentThreadId: null,
    inheritedProviderInstanceId: null,
    inheritedModel: null,
    runtimeMode: 'approval-required',
    interactionMode: 'default',
    providers: [
      {
        providerInstanceId: 'codex',
        driverKind: 'codex',
        displayName: null,
        models: [
          {
            id: 'fixture-model-1',
            label: 'Fixture Model One',
            options: [
              {
                id: 'reasoningEffort',
                label: 'Reasoning effort',
                type: 'select',
                options: [{ id: 'low', label: 'low' }],
                currentValue: 'low',
              },
            ],
          },
        ],
        canRunChildTask: true,
        canRunCrossProviderChildTask: true,
        constraints: [],
      },
      {
        providerInstanceId: 'opencode',
        driverKind: 'opencode',
        displayName: null,
        models: [],
        canRunChildTask: false,
        canRunCrossProviderChildTask: false,
        constraints: ['Provider executable is not installed.', "Executable 'opencode' was not found on PATH."],
      },
    ],
    features: {
      appOwnedSubagents: true,
      asyncPolling: true,
      cancellation: true,
      batchThreadCreation: false,
      threadManagement: false,
      incrementalThreadRead: false,
      scheduledTasks: false,
      maxBatchThreads: 0,
    },
  })
  expect(JSON.parse(s.catalogCalls[0] ?? '[]')).toEqual([
    { instanceId: 'codex', driver: 'codex' },
    { instanceId: 'opencode', driver: 'opencode' },
    { instanceId: 'claudeAgent', driver: 'claudeAgent' },
  ])
})

test('capabilities answers with the modes it is given, which the server takes from the session once the session mode reaches it', async () => {
  const s = fresh()
  const $ = engineOf(s)
  const plan = await capabilities($, s, parentRuntimeModeFromPermissionMode('plan'))
  expect({ runtimeMode: plan.runtimeMode, interactionMode: plan.interactionMode }).toEqual({ runtimeMode: 'approval-required', interactionMode: 'plan' })
  const accepting = await capabilities($, s, parentRuntimeModeFromPermissionMode('acceptEdits'))
  expect({ runtimeMode: accepting.runtimeMode, interactionMode: accepting.interactionMode }).toEqual({ runtimeMode: 'auto-accept-edits', interactionMode: 'default' })
  expect(accepting.providers.map((p: any) => p.providerInstanceId)).toEqual(['codex', 'opencode'])
})

test('the catalog probe is cached for ten minutes', async () => {
  const s = fresh()
  const $ = engineOf(s)
  await capabilities($, s)
  await capabilities($, s)
  expect(s.catalogCalls.length).toBe(1)
  s.now += 9 * 60 * 1000
  await capabilities($, s)
  expect(s.catalogCalls.length).toBe(1)
  s.now += 2 * 60 * 1000
  await capabilities($, s)
  expect(s.catalogCalls.length).toBe(2)
})

test('a changed instances list probes again inside the ten minutes, and the answer lists the new instance', async () => {
  const s = fresh()
  const $ = engineOf(s)
  await capabilities($, s)
  expect(JSON.parse(s.catalogCalls[0] ?? '[]').map((i: any) => i.instanceId)).toEqual(['codex', 'opencode', 'claudeAgent'])
  s.files.set(CONFIG_PATH, JSON.stringify({ jobsDir: JOBS, instances: [{ id: 'codex-work', driver: 'codex' }] }))
  s.catalogJson = JSON.stringify([{ ...JSON.parse(CATALOG)[0], instanceId: 'codex-work' }])
  s.now += 60 * 1000
  const answer = await capabilities($, s)
  expect(s.catalogCalls.length).toBe(2)
  expect(JSON.parse(s.catalogCalls[1] ?? '[]')).toEqual([{ instanceId: 'codex-work', driver: 'codex' }])
  expect(answer.providers.map((p: any) => p.providerInstanceId)).toEqual(['codex-work'])
})

test('a failed catalog probe answers no providers, logs why and is probed again on the next call', async () => {
  const s = fresh({ catalogExit: 1, catalogJson: '' })
  const $ = engineOf(s)
  const answer = await capabilities($, s)
  expect(answer.providers).toEqual([])
  expect(s.logs).toContain('orq: catalog probe failed: Error: catalog.py exited 1')
  await capabilities($, s)
  expect(s.catalogCalls.length).toBe(2)
})

test('session.start declares only the wait tool, and logs one unfinished job with its age', async ($, on) => {
  const s = fresh()
  s.dirEntries = [
    { name: 'job-done', kind: 'dir' },
    { name: 'job-open', kind: 'dir' },
  ]
  seedJob(s, 'job-done', 1000000)
  s.files.set(`${JOBS}/job-done/exit`, '0')
  s.files.set(`${JOBS}/job-done/last.txt`, 'OK')
  seedJob(s, 'job-open', 8000000)
  stubs(on, s)
  await start($)
  expect(s.tools).toEqual(['wait'])
  expect(s.logs.filter((line) => line.startsWith('orq: unfinished'))).toEqual([
    'orq: unfinished job job-open (manual), started 16m40s ago',
  ])
})
