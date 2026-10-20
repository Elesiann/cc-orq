import { expect, test } from 'claude-code/testing'

import { parseLaunch } from '../hooks/engine.ts'
import { parseJobMeta } from '../hooks/types.ts'
import {
  branchDeleteArgv,
  branchFor,
  busyJob,
  isAncestorArgv,
  mergeAbortArgv,
  mergeArgv,
  mergeHeadArgv,
  revParseHeadArgv,
  revParseToplevelArgv,
  statusArgv,
  unmergedFilesArgv,
  worktreeAddArgv,
  worktreePathFor,
  worktreeRemoveArgv,
  type JobPlace,
} from '../hooks/worktree.ts'

const JOBS = '/srv/example/jobs'
const CHECKOUT = '/srv/example/checkout'
const SESSION = '/srv/example/work'
const TASK = 'manual-2000000-manual-k3j9x2a1'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({ jobsDir: JOBS, instances: [{ id: 'codex', driver: 'codex' }] })

test('the worktree sits beside its checkout as REPO_NAME-wt/TASK_ID, on branch orq/TASK_ID', () => {
  expect(worktreePathFor(CHECKOUT, TASK)).toBe(`${CHECKOUT}-wt/${TASK}`)
  expect(worktreePathFor('/checkout', TASK)).toBe(`/checkout-wt/${TASK}`)
  expect(branchFor(TASK)).toBe(`orq/${TASK}`)
})

test('the git argv of each step names the checkout with -C and passes no shell string', () => {
  expect(revParseToplevelArgv(SESSION)).toEqual(['git', '-C', SESSION, 'rev-parse', '--show-toplevel'])
  expect(revParseHeadArgv(CHECKOUT)).toEqual(['git', '-C', CHECKOUT, 'rev-parse', 'HEAD'])
  expect(worktreeAddArgv(CHECKOUT, `${CHECKOUT}-wt/${TASK}`, `orq/${TASK}`, 'abc123')).toEqual([
    'git',
    '-C',
    CHECKOUT,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    'worktree',
    'add',
    `${CHECKOUT}-wt/${TASK}`,
    '-b',
    `orq/${TASK}`,
    'abc123',
  ])
  expect(statusArgv(CHECKOUT)).toEqual(['git', '-C', CHECKOUT, 'status', '--porcelain'])
  expect(isAncestorArgv(CHECKOUT, `orq/${TASK}`)).toEqual(['git', '-C', CHECKOUT, 'merge-base', '--is-ancestor', `orq/${TASK}`, 'HEAD'])
  expect(unmergedFilesArgv(CHECKOUT)).toEqual(['git', '-C', CHECKOUT, 'diff', '--name-only', '--diff-filter=U'])
  expect(mergeAbortArgv(CHECKOUT)).toEqual(['git', '-C', CHECKOUT, 'merge', '--abort'])
  expect(mergeHeadArgv(CHECKOUT)).toEqual(['git', '-C', CHECKOUT, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  expect(worktreeRemoveArgv(CHECKOUT, `${CHECKOUT}-wt/${TASK}`)).toEqual([
    'git',
    '-C',
    CHECKOUT,
    'worktree',
    'remove',
    '--force',
    `${CHECKOUT}-wt/${TASK}`,
  ])
  expect(branchDeleteArgv(CHECKOUT, `orq/${TASK}`)).toEqual(['git', '-C', CHECKOUT, 'branch', '-D', `orq/${TASK}`])
})

test('ff-only and merge differ only in their flags, and neither forces', () => {
  expect(mergeArgv(CHECKOUT, `orq/${TASK}`, 'ff-only')).toEqual(['git', '-C', CHECKOUT, 'merge', '--ff-only', `orq/${TASK}`])
  expect(mergeArgv(CHECKOUT, `orq/${TASK}`, 'merge')).toEqual(['git', '-C', CHECKOUT, 'merge', '--no-ff', '--no-edit', `orq/${TASK}`])
  for (const strategy of ['ff-only', 'merge'] as const) {
    expect(mergeArgv(CHECKOUT, `orq/${TASK}`, strategy).includes('--force')).toBe(false)
  }
})

test('a live job is busy for the checkout it runs in or is a worktree of, and only that one', () => {
  const worktree = `${CHECKOUT}-wt/${TASK}`
  const jobs: JobPlace[] = [
    { id: 'job-dead', cwd: CHECKOUT, live: false },
    { id: 'job-elsewhere', cwd: SESSION, repo: '/srv/example/other', live: true },
    { id: 'job-cwd', cwd: CHECKOUT, live: true },
    { id: 'job-wt', cwd: worktree, repo: CHECKOUT, live: true },
  ]
  expect(busyJob(jobs, CHECKOUT)).toBe('job-cwd')
  expect(busyJob(jobs.slice(0, 2), CHECKOUT)).toBe(null)
  expect(busyJob([{ id: 'job-wt', cwd: worktree, repo: CHECKOUT, live: true }], CHECKOUT)).toBe('job-wt')
  expect(busyJob([{ id: 'job-wt', cwd: worktree, repo: CHECKOUT, live: true }], worktree)).toBe('job-wt')
})

test('the worktree meta fields are read when present and ignored when malformed', () => {
  const meta = {
    id: TASK,
    kind: 'manual',
    agentId: 'manual',
    cwd: `${CHECKOUT}-wt/${TASK}`,
    startedAt: 2000000,
    repo: CHECKOUT,
    baseSha: 'abc123',
    branch: `orq/${TASK}`,
    worktree: `${CHECKOUT}-wt/${TASK}`,
  }
  expect(parseJobMeta(meta, JOBS, TASK)).toMatchObject({
    cwd: `${CHECKOUT}-wt/${TASK}`,
    repo: CHECKOUT,
    baseSha: 'abc123',
    branch: `orq/${TASK}`,
    worktree: `${CHECKOUT}-wt/${TASK}`,
  })
  const malformed = parseJobMeta({ ...meta, repo: 5, baseSha: '', branch: null, worktree: {} }, JOBS, TASK)
  expect(malformed).not.toBe(null)
  expect(malformed?.repo).toBe(undefined)
  expect(malformed?.baseSha).toBe(undefined)
  expect(malformed?.branch).toBe(undefined)
  expect(malformed?.worktree).toBe(undefined)
})

test('parseLaunch reads --worktree only before the instance, and its usage names the flag', () => {
  expect(parseLaunch('--worktree codex fixture-model -- do -- it')).toEqual({
    instance: 'codex',
    model: 'fixture-model',
    prompt: 'do -- it',
    worktree: true,
  })
  expect(parseLaunch('codex fixture-model -- --worktree go')).toEqual({
    instance: 'codex',
    model: 'fixture-model',
    prompt: '--worktree go',
  })
  expect(parseLaunch('--worktree')).toEqual({ error: 'usage: /orq launch [--worktree] INSTANCE MODEL -- PROMPT' })
})

// The kit's $ carries the plugin's own nouns only, so the engine's git, fs and process calls are
// answered beneath the mod: each test drives /orq launch --worktree, which reaches them through the hooks.

type Reply = { exitCode: number; stdout?: string; stderr?: string }
type Entry = { name: string; kind: string }
type State = {
  now: number
  files: Map<string, string>
  writes: { path: string; text: string }[]
  dirEntries: Entry[]
  replies: Map<string, Reply>
  gitCalls: string[][]
  mkdirScripts: string[]
  startScripts: string[]
  live: Set<string>
  failWrite: ((path: string) => boolean) | null
  startExit: number
  logs: { text: string; to: string }[]
}

function fresh(o: Partial<State> = {}): State {
  return {
    now: 2000000,
    files: new Map([[CONFIG_PATH, CONFIG]]),
    writes: [],
    dirEntries: [],
    replies: new Map(),
    gitCalls: [],
    mkdirScripts: [],
    startScripts: [],
    live: new Set(),
    failWrite: null,
    startExit: 0,
    logs: [],
    ...o,
  }
}

const checkout = (s: State) => {
  s.replies.set('rev-parse --show-toplevel', { exitCode: 0, stdout: `${CHECKOUT}\n` })
  s.replies.set('rev-parse HEAD', { exitCode: 0, stdout: 'abc123\n' })
  s.replies.set('worktree add', { exitCode: 0 })
}

function stubs(on: any, s: State) {
  on('session.start', () => ({ cwd: SESSION }))
  on('command.register', (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('ui.log', (_$: unknown, e: any) => {
    s.logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/home/test' }))
  on('session.cwd', () => ({ value: SESSION }))
  on('clock.now', () => ({ value: s.now }))
  on('fs.exists', (_$: unknown, e: any) => ({ value: s.files.has(e.path) }))
  on('fs.read', (_$: unknown, e: any) => {
    if (s.files.has(e.path)) return { value: s.files.get(e.path) }
    if (String(e.path).endsWith('/pgid')) return { value: '4242\n' }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', (_$: unknown, e: any) => {
    if (s.failWrite?.(e.path)) throw new Error(`EACCES: ${e.path}`)
    s.writes.push({ path: e.path, text: e.text })
    s.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_$: unknown, e: any) => {
    if (!s.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 0, mtimeMs: s.now, isLink: false } }
  })
  on('fs.list', (_$: unknown, e: any) => {
    if (e.path !== JOBS) throw new Error(`ENOENT: ${e.path}`)
    return { value: s.dirEntries.map((d) => ({ name: d.name, kind: d.kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_$: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'git') {
      s.gitCalls.push(argv)
      const rest = argv.slice(3)
      while (rest[0] === '-c') rest.splice(0, 2)
      const sub = rest.join(' ')
      const key = [...s.replies.keys()].find((k) => sub.startsWith(k))
      if (key === undefined) throw new Error(`unexpected git: ${sub}`)
      const reply = s.replies.get(key) ?? { exitCode: 0 }
      return {
        value: { exitCode: reply.exitCode, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false },
      }
    }
    const script = argv[2] ?? ''
    if (script.includes('# orq:liveness')) {
      const running = [...s.live].some((id) => script.includes(`${JOBS}/${id}/pgid`))
      return { value: { exitCode: running ? 11 : 12, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (script.includes('# orq:mkdir')) {
      s.mkdirScripts.push(script)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (script.includes('# orq:start')) {
      s.startScripts.push(script)
      return { value: { exitCode: s.startExit, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    throw new Error(`unexpected process.run: ${script.slice(0, 80)}`)
  })
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: SESSION })
}

async function orq($: any, args: string): Promise<string> {
  const r = await $.command.run({ command: 'orq', args })
  return r.text ?? ''
}

// The id the launch claimed: its mkdir line names the job directory.
function claimedId(s: State): string {
  const line = (s.mkdirScripts[0] ?? '').split('\n').find((l) => l.startsWith(`mkdir ${JOBS}/`)) ?? ''
  return line.slice(`mkdir ${JOBS}/`.length).split(' ')[0] ?? ''
}

function seedJob(s: State, id: string, fields: Record<string, unknown>, exit?: string) {
  s.files.set(`${JOBS}/${id}/meta.json`, JSON.stringify({ id, kind: 'manual', agentId: 'manual', startedAt: 1000000, ...fields }))
  if (exit !== undefined) s.files.set(`${JOBS}/${id}/exit`, exit)
  if (!s.dirEntries.some((d) => d.name === id)) s.dirEntries.push({ name: id, kind: 'dir' })
}

test('launch --worktree creates the worktree beside the checkout on its own branch and starts the job there', async ($, on) => {
  const s = fresh()
  checkout(s)
  stubs(on, s)
  await start($)
  const reply = await orq($, 'launch --worktree codex fixture-model -- Do it in a worktree')
  const id = claimedId(s)
  const worktree = `${CHECKOUT}-wt/${id}`
  expect(reply).toBe(`orq: launched ${id}`)
  expect(s.gitCalls.find((argv) => argv.includes('worktree'))).toEqual([
    'git',
    '-C',
    SESSION,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    'worktree',
    'add',
    worktree,
    '-b',
    `orq/${id}`,
    'abc123',
  ])
  const meta = JSON.parse(s.writes.find((w) => w.path.endsWith('/meta.json'))?.text ?? 'null')
  expect(meta).toMatchObject({ cwd: worktree, repo: SESSION, baseSha: 'abc123', branch: `orq/${id}`, worktree })
  expect(s.startScripts[0]).toContain(worktree)
  expect(s.writes.some((w) => w.path.endsWith('/exit'))).toBe(false)
})

test('launch --worktree refuses a directory that is not a checkout, starts nothing and says why', async ($, on) => {
  const s = fresh()
  s.replies.set('rev-parse --show-toplevel', {
    exitCode: 128,
    stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
  })
  stubs(on, s)
  await start($)
  expect(await orq($, 'launch --worktree codex fixture-model -- go')).toBe(
    `orq: manual refused: not_a_repository: ${SESSION} is not inside a git checkout: fatal: not a git repository (or any of the parent directories): .git`,
  )
  expect(s.startScripts.length).toBe(0)
  expect(s.gitCalls.some((argv) => argv.includes('worktree'))).toBe(false)
  expect(s.writes.find((w) => w.path.endsWith('/exit'))?.text).toBe('125')
})

test('launch --worktree reports a failed worktree add with its git message and starts nothing', async ($, on) => {
  const s = fresh()
  checkout(s)
  s.replies.set('worktree add', { exitCode: 128, stderr: 'fatal: could not create the worktree\n' })
  stubs(on, s)
  await start($)
  const reply = await orq($, 'launch --worktree codex fixture-model -- go')
  const id = claimedId(s)
  expect(reply).toBe(`orq: manual refused: git_failed: git worktree add ${CHECKOUT}-wt/${id} failed: fatal: could not create the worktree`)
  expect(s.startScripts.length).toBe(0)
})

// A live job is one whose supervisor runs: its id is in s.live, and it has no exit file.
function liveJob(s: State, id: string, fields: Record<string, unknown>) {
  seedJob(s, id, fields)
  s.live.add(id)
}

test('a shared launch is refused worktree_busy while a live job runs in the session directory', async ($, on) => {
  const s = fresh()
  checkout(s)
  liveJob(s, 'job-other', { cwd: SESSION })
  stubs(on, s)
  await start($)
  expect(await orq($, 'launch codex fixture-model -- go')).toBe(`orq: manual refused: worktree_busy: ${SESSION} is in use by job job-other`)
  expect(s.startScripts.length).toBe(0)
  expect(s.gitCalls.length).toBe(0)
})

test('a shared launch is refused while a live worktree job has the session directory as its checkout', async ($, on) => {
  const s = fresh()
  checkout(s)
  liveJob(s, 'job-wt', { cwd: `${CHECKOUT}-wt/job-wt`, repo: SESSION, worktree: `${CHECKOUT}-wt/job-wt`, baseSha: 'abc123', branch: 'orq/job-wt' })
  stubs(on, s)
  await start($)
  expect(await orq($, 'launch codex fixture-model -- go')).toBe(`orq: manual refused: worktree_busy: ${SESSION} is in use by job job-wt`)
  expect(s.startScripts.length).toBe(0)
})

test('a shared launch goes ahead when the jobs in the session directory have exited or lost their supervisor', async ($, on) => {
  const s = fresh()
  checkout(s)
  seedJob(s, 'job-done', { cwd: SESSION }, '0')
  seedJob(s, 'job-gone', { cwd: SESSION })
  stubs(on, s)
  await start($)
  expect(await orq($, 'launch codex fixture-model -- go')).toBe(`orq: launched ${claimedId(s)}`)
  expect(s.startScripts.length).toBe(1)
})

test('a worktree launch is never refused for busy: live jobs in the session directory do not stop it', async ($, on) => {
  const s = fresh()
  checkout(s)
  liveJob(s, 'job-other', { cwd: SESSION })
  liveJob(s, 'job-wt', { cwd: `${CHECKOUT}-wt/job-wt`, repo: SESSION, worktree: `${CHECKOUT}-wt/job-wt`, baseSha: 'abc123', branch: 'orq/job-wt' })
  stubs(on, s)
  await start($)
  expect(await orq($, 'launch --worktree codex fixture-model -- go')).toBe(`orq: launched ${claimedId(s)}`)
  expect(s.gitCalls.some((argv) => argv.includes('worktree'))).toBe(true)
})

// A launch that fails after git made its worktree undoes it: the worktree first, then the branch it made.
const unwound: [string, (s: State) => void, string][] = [
  ['meta.json write', (s) => { s.failWrite = (path) => path.endsWith('/meta.json') }, 'could not write its job directory'],
  ['start', (s) => { s.startExit = 1 }, 'failed to start (exit 1)'],
]
for (const [failure, breakLaunch, reason] of unwound) {
  test(`launch --worktree undoes its worktree and branch when the ${failure} fails`, async ($, on) => {
    const s = fresh()
    checkout(s)
    s.replies.set('worktree remove', { exitCode: 0 })
    s.replies.set('branch -D', { exitCode: 0 })
    breakLaunch(s)
    stubs(on, s)
    await start($)
    const reply = await orq($, 'launch --worktree codex fixture-model -- go')
    const id = claimedId(s)
    expect(reply).toContain(reason)
    expect(s.gitCalls.slice(-2)).toEqual([
      ['git', '-C', SESSION, 'worktree', 'remove', '--force', `${CHECKOUT}-wt/${id}`],
      ['git', '-C', SESSION, 'branch', '-D', `orq/${id}`],
    ])
  })
}

test('a failed undo goes to the debug log, and the refusal still names the launch failure', async ($, on) => {
  const s = fresh()
  checkout(s)
  s.failWrite = (path) => path.endsWith('/meta.json')
  s.replies.set('worktree remove', { exitCode: 128, stderr: 'fatal: contains modified or untracked files\n' })
  s.replies.set('branch -D', { exitCode: 1, stderr: 'error: cannot delete branch\n' })
  stubs(on, s)
  await start($)
  expect(await orq($, 'launch --worktree codex fixture-model -- go')).toContain('could not write its job directory')
  const undo = s.logs.filter((line) => line.text.includes('after a failed launch'))
  expect(undo.map((line) => line.to)).toEqual(['debug', 'debug'])
})

test('list reads a job whose worktree fields are malformed and shows it under its cwd', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-tree', { cwd: `${CHECKOUT}-wt/job-tree`, repo: CHECKOUT, baseSha: 'abc123', branch: 'orq/job-tree', worktree: `${CHECKOUT}-wt/job-tree` }, '1')
  seedJob(s, 'job-odd', { cwd: SESSION, repo: 5, branch: null, worktree: '' }, '1')
  stubs(on, s)
  await start($)
  const rows = (await orq($, 'list')).split('\n')
  expect(rows.map((row) => row.split(/\s+/)[0])).toEqual(['id', 'job-tree', 'job-odd'])
  expect(rows[2]?.split(/\s+/)[4]).toBe(SESSION)
  expect(rows[1]?.split(/\s+/)[4]).toBe(`${CHECKOUT}-wt/job-tree`)
})
