import { expect, test } from 'claude-code/testing'

const JOBS = '/srv/example/jobs'
const REPO = '/srv/example/repo'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
// The session runs in SESSION; REPO lies inside it, so a task there is in scope.
const SESSION = '/srv/example'
const configText = (s: State) =>
  JSON.stringify({
    jobsDir: s.jobsDir,
    instances: [
      { id: 'codex', driver: 'codex' },
      { id: 'opencode', driver: 'opencode' },
    ],
    waitSeconds: s.waitSeconds,
    allowedRoots: s.allowedRoots,
  })

type State = {
  now: number
  files: Map<string, string>
  writes: { path: string; text: string }[]
  store: Map<string, unknown>
  messages: { role: string; text: string; toolUses: unknown[] }[]
  settingsMode: string | undefined
  /** realpath results for paths that are not their own resolution (symlinks). */
  realpaths: Record<string, string>
  allowedRoots: string[]
  jobsDir: string
  waitSeconds: number
  /** The scripts and timeouts of each wait call, in order. */
  waitCalls: { script: string; timeoutMs?: number }[]
  statMissing: boolean
  tools: any[]
  agents: any[]
  logs: string[]
  startScripts: string[]
  flagsWrittenBeforeStart: boolean[]
  spawned: number
  liveExit: number
  waitExit: number
  waitThrow: boolean
  summary: { tid: string; in: number; out: number; error: boolean }
}

function fresh(o: Partial<State> = {}): State {
  const s: State = {
    now: 2000000,
    files: new Map(),
    writes: [],
    store: new Map(),
    messages: [],
    settingsMode: undefined,
    realpaths: {},
    allowedRoots: [],
    jobsDir: JOBS,
    waitSeconds: 120,
    waitCalls: [],
    statMissing: false,
    tools: [],
    agents: [],
    logs: [],
    startScripts: [],
    flagsWrittenBeforeStart: [],
    spawned: 0,
    liveExit: 11,
    waitExit: 11,
    waitThrow: false,
    summary: { tid: '', in: 0, out: 0, error: false },
    ...o,
  }
  s.files.set(CONFIG_PATH, configText(s))
  return s
}

const run = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

function stubs(on: any, s: State) {
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: s.messages }))
  on('env.get', () => ({ value: '/home/test' }))
  on('clock.now', () => ({ value: s.now }))
  on('ui.log', (_$: unknown, e: any) => {
    s.logs.push(String(e.text))
    return { value: undefined }
  })
  on('tool.register', (_$: unknown, e: any) => {
    s.tools.push(e)
    return { value: { tool: `mcp__orq__${e.name}` } }
  })
  on('agent.register', (_$: unknown, e: any) => {
    s.agents.push(e)
    return { value: { agent: `orq:${e.name}` } }
  })
  on('agent.spawn', (_$: unknown, e: any) => {
    s.spawned += 1
    return { model: 'fixture-model', agentId: `a-${s.spawned}` }
  })
  on('store.get', (_$: unknown, e: any) => ({ value: s.store.get(e.key) }))
  on('store.set', (_$: unknown, e: any) => {
    s.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('settings.read', () => ({ value: s.settingsMode === undefined ? {} : { permissions: { defaultMode: s.settingsMode } } }))
  on('fs.read', (_$: unknown, e: any) => {
    if (s.files.has(e.path)) return { value: s.files.get(e.path) }
    if (String(e.path).endsWith('/pgid')) return { value: '4242\n' }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.exists', (_$: unknown, e: any) => ({ value: s.files.has(e.path) }))
  on('fs.write', (_$: unknown, e: any) => {
    s.writes.push({ path: e.path, text: e.text })
    s.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_$: unknown, e: any) => {
    if (s.statMissing) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: s.now, isLink: false } }
  })
  on('process.run', (_$: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'realpath') {
      const path = argv[argv.length - 1] ?? ''
      if (argv[1] === '-e' && s.statMissing) return run(1)
      return run(0, `${s.realpaths[path] ?? path}\n`)
    }
    if (argv[0] === 'python3') return run(0, JSON.stringify(s.summary) + '\n')
    const script = argv[2] ?? ''
    if (script.includes('# orq:mkdir')) return run(0)
    if (script.includes('# orq:start')) {
      s.startScripts.push(script)
      s.flagsWrittenBeforeStart.push(s.writes.some((w) => w.path.endsWith('/flags')))
      return run(0)
    }
    if (script.includes('# orq:liveness')) return run(s.liveExit)
    if (script.includes('# orq:wait')) {
      s.waitCalls.push({ script, timeoutMs: e.init?.timeoutMs })
      if (s.waitThrow) throw new Error('aborted')
      return run(s.waitExit)
    }
    if (script.includes('# orq:rollout')) return run(0, '\n')
    if (script.includes('# orq:stderr')) return run(0, '')
    throw new Error(`unexpected process.run: ${script.slice(0, 80)}`)
  })
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

/** Spawn an orq:task agent whose first message is the prompt; the permission mode is optional. */
async function spawnTask($: any, s: State, prompt: string, permissionMode?: string): Promise<string> {
  const spawned: any = await $.agent.spawn({
    prompt,
    description: 'task',
    subagentType: 'orq:task',
    ...(permissionMode === undefined ? {} : { permissionMode }),
  } as any)
  s.messages = [{ role: 'user', text: prompt, toolUses: [] }]
  return spawned.agentId as string
}

async function step($: any, agentId: string, index = 0): Promise<any[]> {
  const chunks: any[] = []
  for await (const c of $.turn.step({ turnId: 't1', index, model: 'fixture-model', messageCount: 1, agentId })) chunks.push(c)
  return chunks
}

/** The answer a step carries: the text of a text chunk, or the message of a SubagentHandback input. */
const answerOf = (chunks: any[]) =>
  chunks.map((c: any) => (c.kind === 'text' ? c.text : c.kind === 'input' ? (JSON.parse(c.json).message ?? '') : '')).join('')

const jobDir = (s: State) => (s.writes.find((w) => w.path.endsWith('/meta.json'))?.path ?? '').replace('/meta.json', '')

function finish(s: State, text = 'OK') {
  const dir = jobDir(s)
  s.files.set(`${dir}/exit`, '0')
  s.files.set(`${dir}/last.txt`, text)
}

test('session start registers the wait tool and the orq:task agent, which runs in the background with that tool', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect(s.tools.map((t) => t.name)).toEqual(['wait'])
  expect(s.agents.map((a) => a.name)).toEqual(['task'])
  expect(s.agents[0].tools).toEqual(['mcp__orq__wait'])
  expect(s.agents[0].background).toBe(true)
  expect(s.agents[0].permissionMode).toBeUndefined()
})

test('a header launches one task job on the named instance and the step waits through mcp__orq__wait', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model effort=high\ncwd: ${REPO}\nSay OK.`, 'auto')
  const chunks = await step($, agentId)
  expect(chunks.map((c: any) => c.kind)).toEqual(['tool', 'input', 'stop'])
  expect(chunks[0].name).toBe('mcp__orq__wait')
  const job = JSON.parse(chunks[1].json).job as string
  expect(job.startsWith('task-2000000-')).toBe(true)
  expect(s.startScripts.length).toBe(1)
  expect(s.startScripts[0]).toContain(` codex ${REPO} fixture-model`)
  const meta = JSON.parse(s.writes.find((w) => w.path.endsWith('/meta.json'))?.text ?? '{}')
  expect(meta).toMatchObject({ kind: 'task', agentId, instanceId: 'codex', driver: 'codex', model: 'fixture-model' })
  expect(s.writes.find((w) => w.path.endsWith('/flags'))?.text).toBe('--approve-for-me\n-c\nmodel_reasoning_effort=high\n')
  expect(s.writes.find((w) => w.path.endsWith('/prompt.txt'))?.text).toBe('Say OK.')
})

test('the flags file is written before the start script runs, so the supervisor reads it at startup', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  await step($, agentId)
  expect(s.flagsWrittenBeforeStart).toEqual([true])
})

test('a repeated step for the same agent finds its job and does not relaunch', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  const first = await step($, agentId)
  const second = await step($, agentId, 1)
  expect(JSON.parse(second[1].json).job).toBe(JSON.parse(first[1].json).job)
  expect(s.startScripts.length).toBe(1)
  expect(s.writes.filter((w) => w.path.endsWith('/meta.json')).length).toBe(1)
})

test('a model that starts with a dash is refused as the step answer, and nothing launches', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex -fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  const chunks = await step($, agentId)
  expect(chunks[0].name).toBe('SubagentHandback')
  expect(answerOf(chunks)).toContain('The model must be one word that does not start with "-"')
  expect(s.startScripts.length).toBe(0)
})

test('a prompt without a target line is refused with the expected format', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, 'Just do it.', 'plan')
  const chunks = await step($, agentId)
  expect(answerOf(chunks)).toContain('The first line must be `target: <instance> <model>')
  expect(s.startScripts.length).toBe(0)
})

test('a session in plan mode refuses a task that asks for auto, as an escalation', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model runtime=auto\ncwd: ${REPO}\nEdit it.`, 'plan')
  const chunks = await step($, agentId)
  expect(chunks.map((c: any) => c.kind)).toEqual(['text', 'stop'])
  expect(answerOf(chunks)).toContain('runtime_mode_escalation_denied')
  expect(s.startScripts.length).toBe(0)
})

test('a parent in acceptEdits that delegates to opencode gets runtime_mode_unsupported in its step answer, and nothing launches', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: opencode fixture-model\ncwd: ${REPO}\nEdit it.`, 'acceptEdits')
  const chunks = await step($, agentId)
  expect(chunks.map((c: any) => c.kind)).toEqual(['text', 'stop'])
  expect(answerOf(chunks)).toContain(
    'orq: task refused (runtime_mode_unsupported): Driver opencode cannot enforce runtime mode auto-accept-edits; it supports approval-required, auto.',
  )
  expect(s.startScripts.length).toBe(0)
})

test('a working directory that does not exist is refused in the step answer', async ($, on) => {
  const s = fresh({ statMissing: true })
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  const chunks = await step($, agentId)
  expect(answerOf(chunks)).toContain(`orq: task refused: directory does not exist: ${REPO}`)
  expect(s.startScripts.length).toBe(0)
})

test('a finished task answers through SubagentHandback under auto mode, with its footer', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nSay OK.`, 'auto')
  await step($, agentId)
  finish(s)
  const chunks = await step($, agentId, 1)
  expect(chunks.map((c: any) => c.kind)).toEqual(['tool', 'input', 'stop'])
  expect(chunks[0].name).toBe('SubagentHandback')
  const answer = answerOf(chunks)
  expect(answer.startsWith('OK')).toBe(true)
  expect(answer).toContain('— orq · task · fixture-model')
})

test('a second step after the handback answers with text, not a second handback', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nSay OK.`, 'auto')
  await step($, agentId)
  finish(s)
  await step($, agentId, 1)
  const again = await step($, agentId, 2)
  expect(again.map((c: any) => c.kind)).toEqual(['text', 'stop'])
  expect(answerOf(again).startsWith('OK')).toBe(true)
})

test('outside auto mode a finished task answers with plain text', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nSay OK.`, 'acceptEdits')
  await step($, agentId)
  finish(s)
  const chunks = await step($, agentId, 1)
  expect(chunks.map((c: any) => c.kind)).toEqual(['text', 'stop'])
  expect(answerOf(chunks).startsWith('OK')).toBe(true)
})

test('without a permission mode on the spawn, the settings default decides the handback', async ($, on) => {
  const s = fresh({ settingsMode: 'auto' })
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nSay OK.`)
  await step($, agentId)
  finish(s)
  const chunks = await step($, agentId, 1)
  expect(chunks[0].name).toBe('SubagentHandback')
})

test('with no permission mode anywhere, the answer is text and the skipped handback is logged', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nSay OK.`)
  await step($, agentId)
  finish(s)
  const chunks = await step($, agentId, 1)
  expect(chunks.map((c: any) => c.kind)).toEqual(['text', 'stop'])
  expect(s.logs).toContain(`orq: handback skipped for ${agentId}: no permission mode`)
})

test('the wait tool answers finished, still running and supervisor gone from the wait exit codes', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  s.files.set(`${JOBS}/task-1000000-a-1-abc/meta.json`, JSON.stringify({ id: 'task-1000000-a-1-abc', kind: 'task', agentId: 'a-1', cwd: REPO, startedAt: 1000000, startedAtIso: new Date(1000000).toISOString(), runner: 'codex', model: 'fixture-model', instanceId: 'codex', driver: 'codex' }))
  await start($)
  const job = 'task-1000000-a-1-abc'
  s.waitExit = 0
  expect((await $.tool.call({ tool: 'mcp__orq__wait', job })).result).toBe('finished')
  s.waitExit = 11
  expect((await $.tool.call({ tool: 'mcp__orq__wait', job })).result).toBe('still running, 16m40s')
  s.waitExit = 12
  expect((await $.tool.call({ tool: 'mcp__orq__wait', job })).result).toBe('supervisor gone')
})

test('a wait whose run is stopped writes the cancel file for its job', async ($, on) => {
  const s = fresh({ waitThrow: true })
  stubs(on, s)
  s.files.set(`${JOBS}/task-1000000-a-1-abc/meta.json`, JSON.stringify({ id: 'task-1000000-a-1-abc', kind: 'task', agentId: 'a-1', cwd: REPO, startedAt: 1000000, startedAtIso: new Date(1000000).toISOString(), runner: 'codex', model: 'fixture-model', instanceId: 'codex', driver: 'codex' }))
  await start($)
  expect((await $.tool.call({ tool: 'mcp__orq__wait', job: 'task-1000000-a-1-abc' })).result).toBe('cancelled')
  expect(s.writes.some((w) => w.path === `${JOBS}/task-1000000-a-1-abc/cancel`)).toBe(true)
})

test('a wait on an unknown or unsafe job id answers unknown job and runs nothing', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect((await $.tool.call({ tool: 'mcp__orq__wait', job: '../x' })).result).toBe('unknown job ../x')
  expect((await $.tool.call({ tool: 'mcp__orq__wait' })).result).toBe('unknown job (missing)')
})

test('a spawn without a permission mode whose header asks runtime=auto is refused as an escalation, and nothing launches', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model runtime=auto\ncwd: ${REPO}\nEdit it.`)
  const chunks = await step($, agentId)
  expect(chunks.map((c: any) => c.kind)).toEqual(['text', 'stop'])
  expect(answerOf(chunks)).toContain('orq: task refused (runtime_mode_escalation_denied)')
  expect(s.startScripts.length).toBe(0)
  expect(s.logs).toContain(`orq: ceiling for ${agentId}: no permission mode captured at spawn, using approval-required`)
})

test('a turn step for an agent not spawned as orq:task yields what the chain beneath yields, even when its first line is a target header', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  on('turn.step', async function* (_$: unknown, e: any) {
    yield { kind: 'text', index: 0, text: 'from beneath' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'from beneath', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await start($)
  s.messages = [{ role: 'user', text: `target: codex fixture-model\ncwd: ${REPO}\nGo.`, toolUses: [] }]
  const chunks = await step($, 'a-plain')
  expect(chunks.map((c: any) => c.kind)).toEqual(['text', 'stop'])
  expect(answerOf(chunks)).toBe('from beneath')
  expect(s.startScripts.length).toBe(0)
})

test('a finished task hands back under the session mode when its spawn captured none, and its ceiling stays approval-required', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  await spawnTask($, s, 'Another task.', 'auto')
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nSay OK.`)
  await step($, agentId)
  expect(s.writes.find((w) => w.path.endsWith('/flags'))?.text).toBe('-s\nread-only\n')
  finish(s)
  const chunks = await step($, agentId, 1)
  expect(chunks[0].name).toBe('SubagentHandback')
  expect(answerOf(chunks).startsWith('OK')).toBe(true)
  expect(s.logs).toContain(`orq: ceiling for ${agentId}: no permission mode captured at spawn, using approval-required`)
})

test('a cwd inside the session directory is accepted, and the job runs there', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${SESSION}/nested/repo\nGo.`, 'auto')
  const chunks = await step($, agentId)
  expect(chunks[0].name).toBe('mcp__orq__wait')
  expect(s.startScripts[0]).toContain(` codex ${SESSION}/nested/repo fixture-model`)
})

test('a cwd outside the session directory and the allowed roots is refused with cwd_out_of_scope, naming the roots', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, 'target: codex fixture-model\ncwd: /srv/elsewhere/repo\nGo.', 'auto')
  const chunks = await step($, agentId)
  expect(answerOf(chunks)).toBe(
    'orq: task refused (cwd_out_of_scope): cwd /srv/elsewhere/repo is outside the session directory and the allowed roots (/srv/example).',
  )
  expect(s.startScripts.length).toBe(0)
})

test('a cwd under an allowedRoots entry is accepted', async ($, on) => {
  const s = fresh({ allowedRoots: ['/srv/shared'] })
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, 'target: codex fixture-model\ncwd: /srv/shared/tool\nGo.', 'auto')
  const chunks = await step($, agentId)
  expect(chunks[0].name).toBe('mcp__orq__wait')
  expect(s.startScripts[0]).toContain(' codex /srv/shared/tool fixture-model')
})

test('a sibling directory that shares a name prefix with the session directory is outside it', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, 'target: codex fixture-model\ncwd: /srv/example-other/repo\nGo.', 'auto')
  expect(answerOf(await step($, agentId))).toContain('orq: task refused (cwd_out_of_scope)')
  expect(s.startScripts.length).toBe(0)
})

test('a symlink inside the session directory that resolves outside it is refused', async ($, on) => {
  const s = fresh({ realpaths: { [`${SESSION}/link`]: '/srv/elsewhere/real' } })
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${SESSION}/link\nGo.`, 'auto')
  expect(answerOf(await step($, agentId))).toBe(
    'orq: task refused (cwd_out_of_scope): cwd /srv/elsewhere/real is outside the session directory and the allowed roots (/srv/example).',
  )
  expect(s.startScripts.length).toBe(0)
})

const JOB = 'task-1000000-a-1-abc'
function seedJob(s: State): void {
  s.files.set(
    `${s.jobsDir}/${JOB}/meta.json`,
    JSON.stringify({ id: JOB, kind: 'task', agentId: 'a-1', cwd: REPO, startedAt: 1000000, startedAtIso: new Date(1000000).toISOString(), runner: 'codex', model: 'fixture-model', instanceId: 'codex', driver: 'codex' }),
  )
}

test('a config that asks for a 600 s wait keeps the default, so one wait call blocks 120 s', async ($, on) => {
  const s = fresh({ waitSeconds: 600 })
  stubs(on, s)
  seedJob(s)
  await start($)
  expect((await $.tool.call({ tool: 'mcp__orq__wait', job: JOB })).result).toBe('still running, 16m40s')
  expect(s.waitCalls.length).toBe(1)
  expect(s.waitCalls[0]?.script).toContain('$(seq 1 60)')
  expect(s.waitCalls[0]?.timeoutMs).toBe(125000)
})

test('a wait blocks 240 s at most, the largest waitSeconds the config allows', async ($, on) => {
  const s = fresh({ waitSeconds: 240 })
  stubs(on, s)
  seedJob(s)
  await start($)
  expect((await $.tool.call({ tool: 'mcp__orq__wait', job: JOB })).result).toBe('still running, 16m40s')
  expect(s.waitCalls[0]?.script).toContain('$(seq 1 120)')
  expect(s.waitCalls[0]?.timeoutMs).toBe(245000)
})
