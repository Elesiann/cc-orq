import { expect, test } from 'claude-code/testing'

// The jobs directory and the config file the tools read.
const JOBS = '/srv/example/jobs'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({ jobsDir: JOBS })

type State = {
  now: number
  sessionId: string
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
  settings: Record<string, unknown>
  store: Record<string, unknown>
  sessionIdThrow: boolean
  storeThrow: boolean
  settingsThrow: boolean
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
    sessionId: 'sess-1',
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
    settings: {},
    store: {},
    sessionIdThrow: false,
    storeThrow: false,
    settingsThrow: false,
    tools: [],
    logs: [],
    ...o,
  }
}

const result = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

function stubs(on: any, s: State) {
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.log', (_$: unknown, e: any) => {
    s.logs.push(e.text)
    return { value: undefined }
  })
  on('session.id', () => {
    if (s.sessionIdThrow) throw new Error('session unavailable')
    return { value: s.sessionId }
  })
  on('settings.read', () => {
    if (s.settingsThrow) throw new Error('settings unavailable')
    return { value: s.settings }
  })
  on('store.get', (_$: unknown, e: any) => {
    if (s.storeThrow) throw new Error('store unavailable')
    return { value: s.store[e.key] }
  })
  on('tool.register', (_$: unknown, e: any) => {
    s.tools.push(e.name)
    return { value: { tool: `mcp__orq__${e.name}` } }
  })
  on('fs.list', (_$: unknown, e: any) => {
    if (e.path !== JOBS) throw new Error(`ENOENT: ${e.path}`)
    return { value: s.dirEntries.map((d) => ({ name: d.name, kind: d.kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
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
    if (argv[0] === 'python3' && String(argv[1]).endsWith('catalog.py')) {
      s.catalogCalls.push(String(e.init?.stdin))
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

test('cancel writes its reason into the cancel marker', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-why', 8000000)
  stubs(on, s)
  await start($)
  expect(await call($, 'mcp__orq__cancel', { taskId: 'job-why', reason: 'the user stopped it' })).toEqual({
    taskId: 'job-why',
    status: 'cancel_requested',
  })
  const marker = s.writes.find((w) => w.path === `${JOBS}/job-why/cancel`)
  expect(marker?.text.includes('why="the user stopped it"')).toBe(true)
})

test('cancel refuses a reason that is not a string or is longer than 200 characters, and writes nothing', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-long', 8000000)
  stubs(on, s)
  await start($)
  const tooLong = await call($, 'mcp__orq__cancel', { taskId: 'job-long', reason: 'x'.repeat(201) })
  expect(tooLong.error.code).toBe('invalid_request')
  const notText = await call($, 'mcp__orq__cancel', { taskId: 'job-long', reason: 5 })
  expect(notText.error.code).toBe('invalid_request')
  expect(s.writes.some((w) => w.path.endsWith('/cancel'))).toBe(false)
  const atLimit = await call($, 'mcp__orq__cancel', { taskId: 'job-long', reason: 'x'.repeat(200) })
  expect(atLimit).toEqual({ taskId: 'job-long', status: 'cancel_requested' })
})

test('a job with a cancel request still reads as running, and cancelling it again answers cancel_requested', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-again', 8000000)
  s.files.set(`${JOBS}/job-again/cancel`, 'cancelled at 1970-01-01T00:00:00.000Z\n')
  stubs(on, s)
  await start($)
  expect((await call($, 'mcp__orq__status', { taskId: 'job-again' })).status).toBe('running')
  expect(await call($, 'mcp__orq__cancel', { taskId: 'job-again', reason: 'second request' })).toEqual({
    taskId: 'job-again',
    status: 'cancel_requested',
  })
  expect(s.writes.some((w) => w.path === `${JOBS}/job-again/cancel` && w.text.includes('why="second request"'))).toBe(true)
})

test('capabilities lists the probed providers with the modes of the settings and the probe sees the configured instances', async ($, on) => {
  const s = fresh({ settings: { permissions: { defaultMode: 'plan' } } })
  stubs(on, s)
  await start($)
  expect(await call($, 'mcp__orq__capabilities', {})).toEqual({
    parentThreadId: null,
    inheritedProviderInstanceId: null,
    inheritedModel: null,
    runtimeMode: 'approval-required',
    interactionMode: 'plan',
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

test('capabilities answers with the mode recorded for the session before the settings default', async ($, on) => {
  const s = fresh({ settings: { permissions: { defaultMode: 'plan' } }, store: { 'perm:session:sess-1': 'acceptEdits' } })
  stubs(on, s)
  await start($)
  const answer = await call($, 'mcp__orq__capabilities', {})
  expect({ runtimeMode: answer.runtimeMode, interactionMode: answer.interactionMode }).toEqual({
    runtimeMode: 'auto-accept-edits',
    interactionMode: 'default',
  })
})

test('capabilities maps an unknown or missing permission mode to approval-required', async ($, on) => {
  const s = fresh({ settings: { permissions: { defaultMode: 'something-new' } } })
  stubs(on, s)
  await start($)
  const answer = await call($, 'mcp__orq__capabilities', {})
  expect({ runtimeMode: answer.runtimeMode, interactionMode: answer.interactionMode }).toEqual({
    runtimeMode: 'approval-required',
    interactionMode: 'default',
  })
})

const modesOf = (answer: any) => ({ runtimeMode: answer.runtimeMode, interactionMode: answer.interactionMode })

test('capabilities falls through to the settings when the session id cannot be read', async ($, on) => {
  const s = fresh({ settings: { permissions: { defaultMode: 'plan' } }, sessionIdThrow: true })
  stubs(on, s)
  await start($)
  expect(modesOf(await call($, 'mcp__orq__capabilities', {}))).toEqual({
    runtimeMode: 'approval-required',
    interactionMode: 'plan',
  })
})

test('capabilities falls through to the settings when the recorded mode cannot be read', async ($, on) => {
  const s = fresh({ settings: { permissions: { defaultMode: 'plan' } }, store: { 'perm:session:sess-1': 'acceptEdits' }, storeThrow: true })
  stubs(on, s)
  await start($)
  expect(modesOf(await call($, 'mcp__orq__capabilities', {}))).toEqual({
    runtimeMode: 'approval-required',
    interactionMode: 'plan',
  })
})

test('capabilities answers the recorded mode when the settings cannot be read', async ($, on) => {
  const s = fresh({ store: { 'perm:session:sess-1': 'acceptEdits' }, settingsThrow: true })
  stubs(on, s)
  await start($)
  expect(modesOf(await call($, 'mcp__orq__capabilities', {}))).toEqual({
    runtimeMode: 'auto-accept-edits',
    interactionMode: 'default',
  })
})

test('capabilities answers approval-required when every permission source throws, and still lists the providers', async ($, on) => {
  const s = fresh({ sessionIdThrow: true, storeThrow: true, settingsThrow: true })
  stubs(on, s)
  await start($)
  const answer = await call($, 'mcp__orq__capabilities', {})
  expect(modesOf(answer)).toEqual({ runtimeMode: 'approval-required', interactionMode: 'default' })
  expect(answer.providers.map((p: any) => p.providerInstanceId)).toEqual(['codex', 'opencode'])
})

test('the catalog probe is cached for ten minutes', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  await call($, 'mcp__orq__capabilities', {})
  await call($, 'mcp__orq__capabilities', {})
  expect(s.catalogCalls.length).toBe(1)
  s.now += 9 * 60 * 1000
  await call($, 'mcp__orq__capabilities', {})
  expect(s.catalogCalls.length).toBe(1)
  s.now += 2 * 60 * 1000
  await call($, 'mcp__orq__capabilities', {})
  expect(s.catalogCalls.length).toBe(2)
})

test('a changed instances list probes again inside the ten minutes, and the answer lists the new instance', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  await call($, 'mcp__orq__capabilities', {})
  expect(JSON.parse(s.catalogCalls[0] ?? '[]').map((i: any) => i.instanceId)).toEqual(['codex', 'opencode', 'claudeAgent'])
  s.files.set(CONFIG_PATH, JSON.stringify({ jobsDir: JOBS, instances: [{ id: 'codex-work', driver: 'codex' }] }))
  s.catalogJson = JSON.stringify([{ ...JSON.parse(CATALOG)[0], instanceId: 'codex-work' }])
  s.now += 60 * 1000
  const answer = await call($, 'mcp__orq__capabilities', {})
  expect(s.catalogCalls.length).toBe(2)
  expect(JSON.parse(s.catalogCalls[1] ?? '[]')).toEqual([{ instanceId: 'codex-work', driver: 'codex' }])
  expect(answer.providers.map((p: any) => p.providerInstanceId)).toEqual(['codex-work'])
})

test('a failed catalog probe answers no providers, logs why and is probed again on the next call', async ($, on) => {
  const s = fresh({ catalogExit: 1, catalogJson: '' })
  stubs(on, s)
  await start($)
  const answer = await call($, 'mcp__orq__capabilities', {})
  expect(answer.providers).toEqual([])
  expect(s.logs).toContain('orq: catalog probe failed: Error: catalog.py exited 1')
  await call($, 'mcp__orq__capabilities', {})
  expect(s.catalogCalls.length).toBe(2)
})

test('session.start declares the three tools and logs one unfinished job with its age', async ($, on) => {
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
  expect(s.tools).toEqual(['capabilities', 'status', 'cancel'])
  expect(s.logs.filter((line) => line.startsWith('orq: unfinished'))).toEqual([
    'orq: unfinished job job-open (manual), started 16m40s ago',
  ])
})
