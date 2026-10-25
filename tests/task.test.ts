import { expect, test } from 'claude-code/testing'
import { QUESTION_PROTOCOL } from '../hooks/question.ts'

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
    ...(s.ceiling === undefined ? {} : { ceiling: s.ceiling }),
  })

type State = {
  now: number
  files: Map<string, string>
  writes: { path: string; text: string }[]
  store: Map<string, unknown>
  messages: { role: string; text: string; toolUses: unknown[] }[]
  /** How many times the mod read the agent's messages to resolve its header. */
  messageReads: number
  /** When set, env.get throws, as a failing engine call would. */
  envThrow: boolean
  /** When set, storing an agent's run record throws. */
  runStoreFails: boolean
  settingsMode: string | undefined
  /** The realPath fs.stat answers for paths that are not their own resolution (symlinks). */
  realpaths: Record<string, string>
  allowedRoots: string[]
  /** The `ceiling` of the config file; the file has none when unset. */
  ceiling?: unknown
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
  /** Every git argv the mod ran, in order. */
  gitCalls: string[][]
  /** When set, git says the task cwd is not inside a checkout. */
  notRepo: boolean
  /** The checkout git reports for the task cwd; the cwd itself when unset. */
  toplevel?: string
  /** When set, git worktree add throws, as a timeout would. */
  addThrows: boolean
  /** When set, the task cwd is missing from HEAD, so the worktree has no such directory. */
  missingInHead: boolean
}

function fresh(o: Partial<State> = {}): State {
  const s: State = {
    now: 2000000,
    files: new Map(),
    writes: [],
    store: new Map(),
    messages: [],
    messageReads: 0,
    envThrow: false,
    runStoreFails: false,
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
    gitCalls: [],
    notRepo: false,
    addThrows: false,
    missingInHead: false,
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
  on('session.messages', () => {
    s.messageReads += 1
    return { value: s.messages }
  })
  on('env.get', () => {
    if (s.envThrow) throw new Error('env unavailable')
    return { value: '/home/test' }
  })
  on('clock.now', () => ({ value: s.now }))
  on('ui.log', (_$: unknown, e: any) => {
    s.logs.push(String(e.text))
    return { value: undefined }
  })
  on('tool.register', (_$: unknown, e: any) => {
    s.tools.push(e)
    return { value: { tool: 'mcp__cc-orq__wait' } }
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
    if (s.runStoreFails && String(e.key).startsWith('agent:')) throw new Error('store unavailable')
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
  on('fs.list', (_$: unknown, e: any) => {
    const names = [...s.files.keys()]
      .map((path) => path.match(new RegExp(`^${e.path}/([^/]+)/meta\\.json$`))?.[1])
      .filter((name): name is string => name !== undefined)
    return { value: names.map((name) => ({ name, kind: 'dir', size: 0, mtimeMs: s.now, isLink: false })) }
  })
  on('fs.write', (_$: unknown, e: any) => {
    s.writes.push({ path: e.path, text: e.text })
    s.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_$: unknown, e: any) => {
    if (s.statMissing) throw new Error(`ENOENT: ${e.path}`)
    if (s.missingInHead && String(e.path).includes('-wt/')) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: s.now, isLink: false, realPath: s.realpaths[e.path] ?? e.path } }
  })
  on('process.run', (_$: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'python3') return run(0, JSON.stringify(s.summary) + '\n')
    if (argv[0] === 'git') {
      s.gitCalls.push(argv)
      const rest = argv.slice(3)
      while (rest[0] === '-c') rest.splice(0, 2)
      const sub = rest.join(' ')
      if (sub === 'rev-parse --show-toplevel') return s.notRepo ? run(128, '') : run(0, `${s.toplevel ?? argv[2]}\n`)
      if (sub === 'rev-parse HEAD') return run(0, 'abc1234\n')
      if (sub.startsWith('worktree add ')) {
        if (s.addThrows) throw new Error('timed out')
        return run(0)
      }
      if (sub.startsWith('worktree remove ') || sub.startsWith('branch -D ')) return run(0)
      throw new Error(`unexpected git: ${sub}`)
    }
    const script = argv[2] ?? ''
    if (script.includes('# orq:mkdir')) return run(0)
    if (script.includes('# orq:lock')) return run(0)
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

/** Spawn a cc-orq:task agent whose first message is the prompt; the permission mode is optional. */
async function spawnTask($: any, s: State, prompt: string, permissionMode?: string): Promise<string> {
  const spawned: any = await $.agent.spawn({
    prompt,
    description: 'task',
    subagentType: 'cc-orq:task',
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

test('session start registers the wait tool and the cc-orq:task agent, which runs in the background with that tool', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect(s.tools.map((t) => t.name)).toEqual(['wait'])
  expect(s.agents.map((a) => a.name)).toEqual(['task'])
  expect(s.agents[0].tools).toEqual(['mcp__cc-orq__wait'])
  expect(s.agents[0].background).toBe(true)
  expect(s.agents[0].permissionMode).toBeUndefined()
  // The guidance for the parent is the agent's description, since nothing injects text at session start.
  const description: string = s.agents[0].description
  for (const term of ['run_in_background: true', '`target: <instance> <model>', '`cwd: /absolute/path`', "Never pass the Agent tool's own `isolation` option", '`BLOCKED on a question`', 'a different model family']) {
    expect(description.includes(term)).toBe(true)
  }
})

test('a header launches one task job on the named instance and the step waits through mcp__cc-orq__wait', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model effort=high\ncwd: ${REPO}\nisolation: shared\nSay OK.`, 'auto')
  const chunks = await step($, agentId)
  expect(chunks.map((c: any) => c.kind)).toEqual(['tool', 'input', 'stop'])
  expect(chunks[0].name).toBe('mcp__cc-orq__wait')
  const job = JSON.parse(chunks[1].json).job as string
  expect(job.startsWith('task-2000000-')).toBe(true)
  expect(s.startScripts.length).toBe(1)
  expect(s.startScripts[0]).toContain(` codex ${REPO} fixture-model`)
  const meta = JSON.parse(s.writes.find((w) => w.path.endsWith('/meta.json'))?.text ?? '{}')
  expect(meta).toMatchObject({
    kind: 'task',
    agentId,
    instanceId: 'codex',
    driver: 'codex',
    model: 'fixture-model',
    runtimeMode: 'approval-required',
    interactionMode: 'default',
    effort: 'high',
  })
  expect(s.writes.find((w) => w.path.endsWith('/flags'))?.text).toBe('-s\nread-only\n-c\nmodel_reasoning_effort=high\n')
  expect(s.writes.find((w) => w.path.endsWith('/prompt.txt'))?.text).toBe(`Say OK.\n\n${QUESTION_PROTOCOL}`)
})

test('a task without an isolation line runs in its own worktree on branch orq/JOB_ID, and meta.json records it', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  const chunks = await step($, agentId)
  expect(chunks[0].name).toBe('mcp__cc-orq__wait')
  const id = JSON.parse(chunks[1].json).job as string
  const worktree = `${REPO}-wt/${id}`
  expect(s.gitCalls.map((argv) => argv.filter((a) => !a.startsWith('core.') && a !== '-c').slice(3).join(' '))).toEqual([
    'rev-parse --show-toplevel',
    'rev-parse HEAD',
    `worktree add ${worktree} -b orq/${id} abc1234`,
  ])
  expect(s.startScripts[0]).toContain(` codex ${worktree} fixture-model`)
  const meta = JSON.parse(s.writes.find((w) => w.path.endsWith('/meta.json'))?.text ?? '{}')
  expect(meta).toMatchObject({ cwd: worktree, repo: REPO, baseSha: 'abc1234', branch: `orq/${id}`, worktree })
  expect(meta.effort).toBeUndefined()
})

test('worktree add runs with the checkout hooks and fsmonitor off', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto'))
  const add = s.gitCalls.find((argv) => argv.includes('worktree')) ?? []
  expect(add.slice(0, 7)).toEqual(['git', '-C', REPO, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'])
})

test('a task in a subdirectory of its checkout runs in the same subdirectory of the worktree', async ($, on) => {
  const s = fresh({ toplevel: REPO })
  stubs(on, s)
  await start($)
  const chunks = await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}/pkg/a\nGo.`, 'auto'))
  const id = JSON.parse(chunks[1].json).job as string
  expect(s.startScripts[0]).toContain(` codex ${REPO}-wt/${id}/pkg/a fixture-model`)
  const meta = JSON.parse(s.writes.find((w) => w.path.endsWith('/meta.json'))?.text ?? '{}')
  expect(meta).toMatchObject({ cwd: `${REPO}-wt/${id}/pkg/a`, worktree: `${REPO}-wt/${id}`, repo: `${REPO}/pkg/a` })
})

test('a worktree task whose checkout reaches above the session directory is refused cwd_out_of_scope, and git adds nothing', async ($, on) => {
  const s = fresh({ toplevel: '/srv' })
  stubs(on, s)
  await start($)
  const answer = answerOf(await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')))
  expect(answer).toContain('orq: task refused (taskId none): cwd_out_of_scope: the git checkout /srv that holds')
  expect(s.gitCalls.some((argv) => argv.includes('worktree'))).toBe(false)
  expect(s.startScripts).toEqual([])
})

test('a task whose cwd is not in HEAD is refused, the worktree and branch are removed, and nothing starts', async ($, on) => {
  const s = fresh({ toplevel: REPO, missingInHead: true })
  stubs(on, s)
  await start($)
  const answer = answerOf(await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}/scratch\nGo.`, 'auto')))
  expect(answer).toContain(`invalid_request: ${REPO}/scratch is not in HEAD of its checkout`)
  const subs = s.gitCalls.map((argv) => argv.filter((a) => !a.startsWith('core.') && a !== '-c').slice(3).join(' '))
  expect(subs.some((sub) => sub.startsWith('worktree remove --force'))).toBe(true)
  expect(subs.some((sub) => sub.startsWith('branch -D orq/'))).toBe(true)
  expect(s.startScripts).toEqual([])
})

test('a worktree add that throws removes the worktree and the branch, and nothing starts', async ($, on) => {
  const s = fresh({ addThrows: true })
  stubs(on, s)
  await start($)
  const answer = answerOf(await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')))
  expect(answer).toContain('git_failed: git worktree add')
  const subs = s.gitCalls.map((argv) => argv.filter((a) => !a.startsWith('core.') && a !== '-c').slice(3).join(' '))
  expect(subs.some((sub) => sub.startsWith('worktree remove --force'))).toBe(true)
  expect(subs.some((sub) => sub.startsWith('branch -D orq/'))).toBe(true)
  expect(s.startScripts).toEqual([])
})

test('isolation: shared runs the task in cwd itself and runs no git', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nisolation: shared\nGo.`, 'auto')
  await step($, agentId)
  expect(s.gitCalls).toEqual([])
  expect(s.startScripts[0]).toContain(` codex ${REPO} fixture-model`)
  const meta = JSON.parse(s.writes.find((w) => w.path.endsWith('/meta.json'))?.text ?? '{}')
  expect(meta.worktree).toBeUndefined()
})

test('a worktree task whose cwd is not a git checkout is refused not_a_repository, names isolation: shared, and nothing starts', async ($, on) => {
  const s = fresh({ notRepo: true })
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  const answer = answerOf(await step($, agentId))
  expect(answer).toContain('orq: task refused (taskId none): not_a_repository')
  expect(answer).toContain('isolation: shared')
  expect(s.startScripts).toEqual([])
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
  expect(answerOf(chunks)).toContain('Header lines may come in any order; `target:` and `cwd:` are required.')
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
    'orq: task refused (taskId none): runtime_mode_unsupported: Driver opencode cannot enforce runtime mode auto-accept-edits; it supports approval-required, auto.',
  )
  expect(s.startScripts.length).toBe(0)
})

test('a working directory that does not exist is refused in the step answer', async ($, on) => {
  const s = fresh({ statMissing: true })
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  const chunks = await step($, agentId)
  expect(answerOf(chunks)).toContain(`orq: task refused (taskId none): directory does not exist: ${REPO}`)
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
  expect(answer).toContain(`· taskId ${jobDir(s).split('/').pop()} · session `)
})

test('a task that exits 0 after writing question.txt hands back BLOCKED with the question and its taskId', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nisolation: shared\nShip it.`, 'auto')
  await step($, agentId)
  const dir = jobDir(s)
  s.files.set(`${dir}/question.txt`, 'Which branch should I target?\n')
  s.files.set(`${dir}/session`, 'ses-asked\n')
  finish(s, 'BLOCKED: Which branch should I target?')
  const chunks = await step($, agentId, 1)
  expect(chunks[0].name).toBe('SubagentHandback')
  const answer = answerOf(chunks)
  expect(answer).toContain(`BLOCKED on a question (taskId ${dir.split('/').pop()}): Which branch should I target?`)
  expect(answer).toContain('Answer it with the answer tool')
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
  expect((await $.tool.call({ tool: 'mcp__cc-orq__wait', job })).result).toBe('finished')
  s.waitExit = 11
  expect((await $.tool.call({ tool: 'mcp__cc-orq__wait', job })).result).toBe('still running, 16m40s')
  s.waitExit = 12
  expect((await $.tool.call({ tool: 'mcp__cc-orq__wait', job })).result).toBe('supervisor gone')
})

test('a wait whose run is stopped writes the cancel file for its job', async ($, on) => {
  const s = fresh({ waitThrow: true })
  stubs(on, s)
  s.files.set(`${JOBS}/task-1000000-a-1-abc/meta.json`, JSON.stringify({ id: 'task-1000000-a-1-abc', kind: 'task', agentId: 'a-1', cwd: REPO, startedAt: 1000000, startedAtIso: new Date(1000000).toISOString(), runner: 'codex', model: 'fixture-model', instanceId: 'codex', driver: 'codex' }))
  await start($)
  expect((await $.tool.call({ tool: 'mcp__cc-orq__wait', job: 'task-1000000-a-1-abc' })).result).toBe('cancelled')
  expect(s.writes.some((w) => w.path === `${JOBS}/task-1000000-a-1-abc/cancel`)).toBe(true)
})

test('a wait on an unknown or unsafe job id answers unknown job and runs nothing', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect((await $.tool.call({ tool: 'mcp__cc-orq__wait', job: '../x' })).result).toBe('unknown job ../x')
  expect((await $.tool.call({ tool: 'mcp__cc-orq__wait' })).result).toBe('unknown job (missing)')
})

test('a spawn without a permission mode whose header asks runtime=auto is refused as an escalation, and nothing launches', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model runtime=auto\ncwd: ${REPO}\nEdit it.`)
  const chunks = await step($, agentId)
  expect(chunks.map((c: any) => c.kind)).toEqual(['text', 'stop'])
  expect(answerOf(chunks)).toContain('orq: task refused (taskId none): runtime_mode_escalation_denied')
  expect(s.startScripts.length).toBe(0)
  expect(s.logs).toContain(`orq: ceiling for ${agentId}: no permission mode captured at spawn, using approval-required`)
})

test('a turn step for an agent not spawned as cc-orq:task yields what the chain beneath yields, even when its first line is a target header', async ($, on) => {
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
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${SESSION}/nested/repo\nisolation: shared\nGo.`, 'auto')
  const chunks = await step($, agentId)
  expect(chunks[0].name).toBe('mcp__cc-orq__wait')
  expect(s.startScripts[0]).toContain(` codex ${SESSION}/nested/repo fixture-model`)
})

test('a cwd outside the session directory and the allowed roots is refused with cwd_out_of_scope, naming the roots', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, 'target: codex fixture-model\ncwd: /srv/elsewhere/repo\nGo.', 'auto')
  const chunks = await step($, agentId)
  expect(answerOf(chunks)).toBe(
    'orq: task refused (taskId none): cwd_out_of_scope: cwd /srv/elsewhere/repo is outside the session directory and the allowed roots (/srv/example).',
  )
  expect(s.startScripts.length).toBe(0)
})

test('a cwd under an allowedRoots entry is accepted', async ($, on) => {
  const s = fresh({ allowedRoots: ['/srv/shared'] })
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, 'target: codex fixture-model\ncwd: /srv/shared/tool\nisolation: shared\nGo.', 'auto')
  const chunks = await step($, agentId)
  expect(chunks[0].name).toBe('mcp__cc-orq__wait')
  expect(s.startScripts[0]).toContain(' codex /srv/shared/tool fixture-model')
})

test('a sibling directory that shares a name prefix with the session directory is outside it', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, 'target: codex fixture-model\ncwd: /srv/example-other/repo\nGo.', 'auto')
  expect(answerOf(await step($, agentId))).toContain('orq: task refused (taskId none): cwd_out_of_scope')
  expect(s.startScripts.length).toBe(0)
})

test('a symlink inside the session directory that resolves outside it is refused', async ($, on) => {
  const s = fresh({ realpaths: { [`${SESSION}/link`]: '/srv/elsewhere/real' } })
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${SESSION}/link\nGo.`, 'auto')
  expect(answerOf(await step($, agentId))).toBe(
    'orq: task refused (taskId none): cwd_out_of_scope: cwd /srv/elsewhere/real is outside the session directory and the allowed roots (/srv/example).',
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
  expect((await $.tool.call({ tool: 'mcp__cc-orq__wait', job: JOB })).result).toBe('still running, 16m40s')
  expect(s.waitCalls.length).toBe(1)
  expect(s.waitCalls[0]?.script).toContain('$(seq 1 60)')
  expect(s.waitCalls[0]?.timeoutMs).toBe(125000)
})

test('a wait blocks 240 s at most, the largest waitSeconds the config allows', async ($, on) => {
  const s = fresh({ waitSeconds: 240 })
  stubs(on, s)
  seedJob(s)
  await start($)
  expect((await $.tool.call({ tool: 'mcp__cc-orq__wait', job: JOB })).result).toBe('still running, 16m40s')
  expect(s.waitCalls[0]?.script).toContain('$(seq 1 120)')
  expect(s.waitCalls[0]?.timeoutMs).toBe(245000)
})

test('a wait whose script exits with a code other than 0, 11 or 12 answers an error text', async ($, on) => {
  const s = fresh({ waitExit: 1 })
  stubs(on, s)
  seedJob(s)
  await start($)
  expect((await $.tool.call({ tool: 'mcp__cc-orq__wait', job: JOB })).result).toBe('orq: wait failed (exit 1)')
})

test('a jobs directory with a single quote is quoted in the wait script', async ($, on) => {
  const s = fresh({ jobsDir: "/srv/example/it's jobs" })
  stubs(on, s)
  seedJob(s)
  await start($)
  expect((await $.tool.call({ tool: 'mcp__cc-orq__wait', job: JOB })).result).toMatch(/^still running, /)
  expect(s.waitCalls[0]?.script).toContain(`[ -e '/srv/example/it'\\''s jobs/${JOB}/exit' ]`)
  expect(s.waitCalls[0]?.script).toContain(`cat '/srv/example/it'\\''s jobs/${JOB}/pgid'`)
})

test('a step after a refusal repeats it, without reading the header again or launching, even once the header would pass', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model runtime=auto\ncwd: ${REPO}\nEdit it.`, 'plan')
  const first = await step($, agentId)
  expect(answerOf(first)).toContain('orq: task refused (taskId none): runtime_mode_escalation_denied')
  const reads = s.messageReads
  s.messages = [{ role: 'user', text: `target: codex fixture-model\ncwd: ${REPO}\nEdit it.`, toolUses: [] }]
  const second = await step($, agentId, 1)
  expect(answerOf(second)).toBe(answerOf(first))
  expect(s.messageReads).toBe(reads)
  expect(s.startScripts.length).toBe(0)
})

test('a job whose supervisor is gone without an exit file is answered as interrupted', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  await step($, agentId)
  s.liveExit = 12
  const chunks = await step($, agentId, 1)
  expect(chunks.map((c: any) => c.kind)).toEqual(['tool', 'input', 'stop'])
  expect(answerOf(chunks)).toMatch(/^orq: task-\S+ was interrupted: its supervisor is gone and it left no exit file$/)
})

test('a step that throws before its answer is answered with an orq task failure, not left to the model', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  s.envThrow = true
  const chunks = await step($, agentId)
  expect(chunks.map((c: any) => c.kind)).toEqual(['text', 'stop'])
  expect(answerOf(chunks).startsWith('orq: task failed: ')).toBe(true)
  expect(s.startScripts.length).toBe(0)
})

test('a run record that cannot be stored is found again by its agent id, so the next step reuses the job', async ($, on) => {
  const s = fresh({ runStoreFails: true })
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  const first = await step($, agentId)
  const second = await step($, agentId, 1)
  expect(JSON.parse(second[1].json).job).toBe(JSON.parse(first[1].json).job)
  expect(s.startScripts.length).toBe(1)
})

test('a refusal longer than 2,000 characters is stored and answered at 2,000 characters', async ($, on) => {
  const s = fresh({ statMissing: true })
  stubs(on, s)
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}/${'x'.repeat(2500)}\nGo.`, 'auto')
  const answer = answerOf(await step($, agentId))
  expect(answer.length).toBe(2000)
  expect(answer.startsWith('orq: task refused (taskId none): directory does not exist: ')).toBe(true)
  expect(s.store.get(`agent:${agentId}`)).toEqual({ refusal: answer })
})

// The ceiling of the config (spec D8, breaking change 2): the parent's mode no longer sets a task's ceiling alone.

const metaOf = (s: State) => JSON.parse(s.writes.find((w) => w.path.endsWith('/meta.json'))?.text ?? '{}')
const flagsOf = (s: State) => s.writes.find((w) => w.path.endsWith('/flags'))?.text

test('under the default ceiling, a worktree task of a parent in auto mode runs at auto-accept-edits', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nEdit it.`, 'auto'))
  expect(metaOf(s)).toMatchObject({ runtimeMode: 'auto-accept-edits', interactionMode: 'default' })
  expect(flagsOf(s)).toBe('-s\nworkspace-write\n')
})

test('a config ceiling of auto-accept-edits keeps a parent in auto mode at auto-accept-edits', async ($, on) => {
  const s = fresh({ ceiling: { runtime: 'auto-accept-edits' } })
  stubs(on, s)
  await start($)
  await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nEdit it.`, 'auto'))
  expect(metaOf(s)).toMatchObject({ runtimeMode: 'auto-accept-edits', interactionMode: 'default' })
  expect(flagsOf(s)).toBe('-s\nworkspace-write\n')
})

test('under the default ceiling, a shared task of a parent in auto mode runs at approval-required', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nisolation: shared\nRead it.`, 'auto'))
  expect(metaOf(s)).toMatchObject({ runtimeMode: 'approval-required', interactionMode: 'default' })
  expect(flagsOf(s)).toBe('-s\nread-only\n')
})

test('a shared task takes its limit from ceiling.sharedRuntime', async ($, on) => {
  const s = fresh({ ceiling: { sharedRuntime: 'auto-accept-edits' } })
  stubs(on, s)
  await start($)
  await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nisolation: shared\nEdit it.`, 'auto'))
  expect(metaOf(s)).toMatchObject({ runtimeMode: 'auto-accept-edits' })
  expect(flagsOf(s)).toBe('-s\nworkspace-write\n')
})

test('a header that asks for auto under the default ceiling is refused with the ceiling hint, and nothing launches', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  const answer = answerOf(await step($, await spawnTask($, s, `target: codex fixture-model runtime=auto\ncwd: ${REPO}\nEdit it.`, 'auto')))
  expect(answer).toBe(
    "orq: task refused (taskId none): runtime_mode_escalation_denied: Runtime mode auto is above the ceiling auto-accept-edits for this task: the config allows auto-accept-edits (ceiling.runtime) and the session's permission mode allows auto. To allow auto, raise ceiling.runtime in ~/.config/orq/config.json; otherwise ask for auto-accept-edits at most.",
  )
  expect(s.startScripts.length).toBe(0)
  expect(s.writes).toEqual([])
})

test('"ceiling": {"runtime": "auto"} lets a parent in auto mode run its worktree task at auto', async ($, on) => {
  const s = fresh({ ceiling: { runtime: 'auto' } })
  stubs(on, s)
  await start($)
  await step($, await spawnTask($, s, `target: codex fixture-model runtime=auto\ncwd: ${REPO}\nEdit it.`, 'auto'))
  expect(metaOf(s)).toMatchObject({ runtimeMode: 'auto', interactionMode: 'default' })
  expect(flagsOf(s)).toBe('--approve-for-me\n')
})

test('the parent mode still lowers a ceiling that allows more', async ($, on) => {
  const s = fresh({ ceiling: { runtime: 'auto' } })
  stubs(on, s)
  await start($)
  await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nEdit it.`, 'acceptEdits'))
  expect(metaOf(s)).toMatchObject({ runtimeMode: 'auto-accept-edits' })
})

test('a request above what the parent mode allows is refused, and the refusal says the session is what stands in the way', async ($, on) => {
  const s = fresh({ ceiling: { runtime: 'auto' } })
  stubs(on, s)
  await start($)
  const answer = answerOf(await step($, await spawnTask($, s, `target: codex fixture-model runtime=auto\ncwd: ${REPO}\nEdit it.`, 'acceptEdits')))
  expect(answer).toContain('runtime_mode_escalation_denied: Runtime mode auto is above the ceiling auto-accept-edits for this task: the config allows auto (ceiling.runtime) and')
  expect(answer).toContain('To allow auto, use a session permission mode that allows it; otherwise ask for auto-accept-edits at most.')
  expect(answer).not.toContain('raise ceiling.runtime')
  expect(s.startScripts.length).toBe(0)
})

test('a config ceiling that is not valid fails closed, so a parent in auto mode gets an approval-required task', async ($, on) => {
  const s = fresh({ ceiling: { runtime: 'turbo' } })
  stubs(on, s)
  await start($)
  await step($, await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nEdit it.`, 'auto'))
  expect(metaOf(s)).toMatchObject({ runtimeMode: 'approval-required' })
  expect(flagsOf(s)).toBe('-s\nread-only\n')
})

test('a job of kind mcp that carries the agent id is not that agent\'s task job, so the step launches its own', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  s.files.set(
    `${JOBS}/mcp-1000000-a-1-abc/meta.json`,
    JSON.stringify({ id: 'mcp-1000000-a-1-abc', kind: 'mcp', agentId: 'a-1', cwd: REPO, startedAt: 1000000, startedAtIso: new Date(1000000).toISOString(), runner: 'codex', model: 'fixture-model', instanceId: 'codex', driver: 'codex', questions: 'parent' }),
  )
  await start($)
  const agentId = await spawnTask($, s, `target: codex fixture-model\ncwd: ${REPO}\nGo.`, 'auto')
  expect(agentId).toBe('a-1')
  const chunks = await step($, agentId)
  expect(s.startScripts.length).toBe(1)
  const job = JSON.parse(chunks[1].json).job as string
  expect(job.startsWith('task-')).toBe(true)
  expect(metaOf(s)).toMatchObject({ id: job, kind: 'task', agentId: 'a-1' })
})
