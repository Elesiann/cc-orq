import { expect, test } from 'claude-code/testing'

import { parseIntegrateInput } from '../hooks/integrate.ts'

// The destination checkout, the jobs directory and a task branch the worker left in its worktree.
const REPO = '/srv/example/checkout'
const JOBS = '/srv/example/jobs'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({ jobsDir: JOBS, instances: [{ id: 'codex', driver: 'codex' }] })
const TASK = 'manual-2000000-manual-k3j9x2a1'
const BRANCH = `orq/${TASK}`
const WORKTREE = `${REPO}-wt/${TASK}`

type Reply = { exitCode: number; stdout?: string; stderr?: string }
type State = {
  files: Map<string, string>
  replies: Map<string, Reply>
  gitCalls: string[][]
  registered: { name: string; description: string; inputSchema: Record<string, unknown> }[]
}

function fresh(): State {
  return { files: new Map([[CONFIG_PATH, CONFIG]]), replies: new Map(), gitCalls: [], registered: [] }
}

// The git calls the integrate path makes on a clean checkout where the task branch is ahead of HEAD.
function clean(s: State, merge: Reply = { exitCode: 0 }) {
  s.replies.set('status --porcelain', { exitCode: 0, stdout: '' })
  s.replies.set('merge-base --is-ancestor', { exitCode: 1 })
  s.replies.set('merge --ff-only', merge)
  s.replies.set('merge --no-ff', merge)
  s.replies.set('rev-parse HEAD', { exitCode: 0, stdout: 'newsha0001\n' })
}

function seedTask(s: State, fields: Record<string, unknown> = {}) {
  s.files.set(
    `${JOBS}/${TASK}/meta.json`,
    JSON.stringify({
      id: TASK,
      kind: 'manual',
      agentId: 'manual',
      cwd: WORKTREE,
      startedAt: 2000000,
      repo: REPO,
      baseSha: 'abc123',
      branch: BRANCH,
      worktree: WORKTREE,
      ...fields,
    }),
  )
}

function stubs(on: any, s: State) {
  on('session.start', () => ({ cwd: '/srv/example/work' }))
  on('tool.register', (_$: unknown, e: any) => {
    s.registered.push(e)
    return { value: { tool: `mcp__orq__${e.name}` } }
  })
  on('command.register', (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', (_$: unknown, e: any) => ({ value: s.files.has(e.path) }))
  on('fs.read', (_$: unknown, e: any) => {
    if (s.files.has(e.path)) return { value: s.files.get(e.path) }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('process.run', (_$: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] !== 'git') throw new Error(`unexpected process.run: ${argv[0]}`)
    s.gitCalls.push(argv)
    const sub = argv.slice(3).join(' ')
    const key = [...s.replies.keys()].find((k) => sub.startsWith(k))
    if (key === undefined) throw new Error(`unexpected git: ${sub}`)
    const reply = s.replies.get(key) ?? { exitCode: 0 }
    return {
      value: {
        exitCode: reply.exitCode,
        stdout: reply.stdout ?? '',
        stderr: reply.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/srv/example/work' })
}

// The answer the model reads: a string holding the payload as JSON, parsed here for the assertions.
async function integrate($: any, args: Record<string, unknown>): Promise<Record<string, any>> {
  const r = await $.tool.call({ tool: 'mcp__orq__integrate', ...args })
  expect(typeof r.result).toBe('string')
  return JSON.parse(r.result as string)
}

// The git subcommands of a call, in order, after checking that each one names the destination with -C.
function subcommands(s: State): string[] {
  expect(s.gitCalls.every((argv) => argv[0] === 'git' && argv[1] === '-C' && argv[2] === REPO)).toBe(true)
  return s.gitCalls.map((argv) => argv.slice(3).join(' '))
}

test('the tool is declared at session start with the conflict instruction in its description', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect(s.registered.map((t) => t.name)).toEqual(['integrate'])
  expect(s.registered[0]?.description).toContain('redelegate a rebase to the same worker, then integrate again')
  expect(s.registered[0]?.description).toContain('uncommitted work in the task worktree is not')
  expect(s.registered[0]?.inputSchema).toMatchObject({ required: ['taskId'] })
})

test('ff-only is the default: the branch moves HEAD with --ff-only and the answer names the merged commit', async ($, on) => {
  const s = fresh()
  seedTask(s)
  clean(s)
  stubs(on, s)
  await start($)
  const r = await integrate($, { taskId: TASK })
  expect(r).toEqual({ ok: true, taskId: TASK, mergedSha: 'newsha0001', branch: BRANCH, worktree: WORKTREE })
  expect(subcommands(s)).toEqual([
    'status --porcelain',
    `merge-base --is-ancestor ${BRANCH} HEAD`,
    `merge --ff-only ${BRANCH}`,
    'rev-parse HEAD',
  ])
  expect(s.gitCalls.some((argv) => argv.includes('--force'))).toBe(false)
})

test('strategy merge makes a merge commit with --no-ff --no-edit', async ($, on) => {
  const s = fresh()
  seedTask(s)
  clean(s)
  stubs(on, s)
  await start($)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: true, mergedSha: 'newsha0001' })
  expect(subcommands(s)).toEqual([
    'status --porcelain',
    `merge-base --is-ancestor ${BRANCH} HEAD`,
    `merge --no-ff --no-edit ${BRANCH}`,
    'rev-parse HEAD',
  ])
})

test('a dirty destination is refused before any merge', async ($, on) => {
  const s = fresh()
  seedTask(s)
  clean(s)
  s.replies.set('status --porcelain', { exitCode: 0, stdout: ' M src/a.ts\n?? notes.md\n' })
  stubs(on, s)
  await start($)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'dirty_worktree' } })
  expect(subcommands(s)).toEqual(['status --porcelain'])
})

test('a task branch already reachable from HEAD is already_integrated and nothing merges', async ($, on) => {
  const s = fresh()
  seedTask(s)
  clean(s)
  s.replies.set('merge-base --is-ancestor', { exitCode: 0 })
  stubs(on, s)
  await start($)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'already_integrated' } })
  expect(subcommands(s).some((sub) => sub.startsWith('merge --'))).toBe(false)
})

test('a conflicting merge lists the unmerged files, aborts, and says so', async ($, on) => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stdout: 'CONFLICT (content): Merge conflict in a.txt\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: 'a.txt\nb/c.txt\n' })
  s.replies.set('merge --abort', { exitCode: 0 })
  stubs(on, s)
  await start($)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'merge_conflict', files: ['a.txt', 'b/c.txt'] } })
  expect(r.error.message).toContain('the merge was aborted')
  expect(subcommands(s)).toEqual([
    'status --porcelain',
    `merge-base --is-ancestor ${BRANCH} HEAD`,
    `merge --no-ff --no-edit ${BRANCH}`,
    'diff --name-only --diff-filter=U',
    'merge --abort',
  ])
})

test('an ff-only merge that cannot fast-forward is not_fast_forward, with no abort', async ($, on) => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 128, stderr: 'fatal: Not possible to fast-forward, aborting.\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  stubs(on, s)
  await start($)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'not_fast_forward' } })
  expect(subcommands(s).includes('merge --abort')).toBe(false)
})

test('an unknown task is task_not_found, with no git call', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect(await integrate($, { taskId: 'manual-404' })).toMatchObject({ ok: false, error: { code: 'task_not_found' } })
  expect(s.gitCalls.length).toBe(0)
})

test('a task that ran without a worktree has nothing to merge: no_worktree', async ($, on) => {
  const s = fresh()
  s.files.set(`${JOBS}/${TASK}/meta.json`, JSON.stringify({ id: TASK, kind: 'manual', agentId: 'manual', cwd: REPO, startedAt: 1 }))
  stubs(on, s)
  await start($)
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: false, error: { code: 'no_worktree' } })
  expect(s.gitCalls.length).toBe(0)
})

test('a destination that is not a git checkout is not_a_repository, and nothing merges', async ($, on) => {
  const s = fresh()
  seedTask(s)
  s.replies.set('status --porcelain', { exitCode: 128, stderr: 'fatal: not a git repository\n' })
  stubs(on, s)
  await start($)
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: false, error: { code: 'not_a_repository' } })
  expect(subcommands(s)).toEqual(['status --porcelain'])
})

test('invalid input is refused at the edge, before git runs', async ($, on) => {
  const s = fresh()
  seedTask(s)
  stubs(on, s)
  await start($)
  expect(await integrate($, {})).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(await integrate($, { taskId: TASK, strategy: 'rebase' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(s.gitCalls.length).toBe(0)
  expect(parseIntegrateInput({ taskId: TASK })).toEqual({ input: { taskId: TASK, strategy: 'ff-only' } })
})
