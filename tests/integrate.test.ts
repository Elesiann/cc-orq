import { expect, test } from 'claude-code/testing'

import { loadConfig } from '../hooks/config.ts'
import { integrate as integrateTask, integratePayload, parseIntegrateInput } from '../hooks/integrate.ts'

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
}

function fresh(): State {
  return { files: new Map([[CONFIG_PATH, CONFIG]]), replies: new Map(), gitCalls: [] }
}

// The git calls the integrate path makes on a clean checkout where the task branch is ahead of HEAD.
function clean(s: State, merge: Reply = { exitCode: 0 }) {
  s.replies.set('status --porcelain', { exitCode: 0, stdout: '' })
  s.replies.set('merge-base --is-ancestor', { exitCode: 1 })
  s.replies.set('merge --ff-only', merge)
  s.replies.set('merge --no-ff', merge)
  s.replies.set('rev-parse HEAD', { exitCode: 0, stdout: 'newsha0001\n' })
  // No merge is in progress unless a test says so: MERGE_HEAD is absent.
  s.replies.set('rev-parse -q', { exitCode: 1 })
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

/** The part of `$` that integrate calls, over the state of one test. The kit's own `$` has no such members. */
function engineOf(s: State): any {
  return {
    ui: { log: async () => undefined },
    env: { get: async () => '/home/test' },
    fs: {
      exists: async (path: string) => s.files.has(path),
      read: async (path: string) => {
        const text = s.files.get(path)
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return text
      },
    },
    process: {
      run: async (argv: string[]) => {
        if (argv[0] !== 'git') throw new Error(`unexpected process.run: ${argv[0]}`)
        s.gitCalls.push(argv)
        const sub = argv.slice(3).join(' ')
        const key = [...s.replies.keys()].find((k) => sub.startsWith(k))
        if (key === undefined) throw new Error(`unexpected git: ${sub}`)
        const reply = s.replies.get(key) ?? { exitCode: 0 }
        return {
          exitCode: reply.exitCode,
          stdout: reply.stdout ?? '',
          stderr: reply.stderr ?? '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        }
      },
    },
  }
}

// The answer the model reads, as the server sends it: the payload of the outcome as JSON text, parsed for the assertions.
async function integrate($: any, args: Record<string, unknown>): Promise<Record<string, any>> {
  const parsed = parseIntegrateInput(args)
  const { config } = await loadConfig($)
  const outcome = 'failure' in parsed ? parsed : await integrateTask($, config.jobsDir, parsed.input)
  return JSON.parse(JSON.stringify(integratePayload(outcome)))
}

// The git subcommands of a call, in order, after checking that each one names the destination with -C.
function subcommands(s: State): string[] {
  expect(s.gitCalls.every((argv) => argv[0] === 'git' && argv[1] === '-C' && argv[2] === REPO)).toBe(true)
  return s.gitCalls.map((argv) => argv.slice(3).join(' '))
}

test('ff-only is the default: the branch moves HEAD with --ff-only and the answer names the merged commit', async () => {
  const s = fresh()
  seedTask(s)
  clean(s)
  const $ = engineOf(s)
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

test('strategy merge makes a merge commit with --no-ff --no-edit', async () => {
  const s = fresh()
  seedTask(s)
  clean(s)
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: true, mergedSha: 'newsha0001' })
  expect(subcommands(s)).toEqual([
    'status --porcelain',
    `merge-base --is-ancestor ${BRANCH} HEAD`,
    `merge --no-ff --no-edit ${BRANCH}`,
    'rev-parse HEAD',
  ])
})

test('a dirty destination is refused before any merge', async () => {
  const s = fresh()
  seedTask(s)
  clean(s)
  s.replies.set('status --porcelain', { exitCode: 0, stdout: ' M src/a.ts\n?? notes.md\n' })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'dirty_worktree' } })
  expect(subcommands(s)).toEqual(['status --porcelain'])
})

test('a task branch already reachable from HEAD is already_integrated and nothing merges', async () => {
  const s = fresh()
  seedTask(s)
  clean(s)
  s.replies.set('merge-base --is-ancestor', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'already_integrated' } })
  expect(subcommands(s).some((sub) => sub.startsWith('merge --'))).toBe(false)
})

test('a conflicting merge lists the unmerged files, aborts, and says so', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stdout: 'CONFLICT (content): Merge conflict in a.txt\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: 'a.txt\nb/c.txt\n' })
  s.replies.set('merge --abort', { exitCode: 0 })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'merge_conflict', files: ['a.txt', 'b/c.txt'] } })
  expect(r.error.message).toContain('the merge was aborted')
  expect(subcommands(s)).toEqual([
    'status --porcelain',
    `merge-base --is-ancestor ${BRANCH} HEAD`,
    `merge --no-ff --no-edit ${BRANCH}`,
    'diff --name-only --diff-filter=U',
    'rev-parse -q --verify MERGE_HEAD',
    'merge --abort',
  ])
})

test('a failed merge that left MERGE_HEAD is aborted even with no unmerged file, and is git_failed', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stderr: 'error: pre-merge-commit hook refused the merge\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('the merge was aborted')
  expect(subcommands(s).slice(-2)).toEqual(['rev-parse -q --verify MERGE_HEAD', 'merge --abort'])
})

test('a merge abort that fails is git_failed, and the message says the checkout may be mid-merge', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stdout: 'CONFLICT (content): Merge conflict in a.txt\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: 'a.txt\n' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 128, stderr: 'fatal: abort failed\n' })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('may still be mid-merge')
})

test('an ff-only merge that cannot fast-forward is not_fast_forward, with no abort', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 128, stderr: 'fatal: Not possible to fast-forward, aborting.\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'not_fast_forward' } })
  expect(subcommands(s)).toEqual([
    'status --porcelain',
    `merge-base --is-ancestor ${BRANCH} HEAD`,
    `merge --ff-only ${BRANCH}`,
    'diff --name-only --diff-filter=U',
    'rev-parse -q --verify MERGE_HEAD',
  ])
})

test('an unknown task is task_not_found, with no git call', async () => {
  const s = fresh()
  const $ = engineOf(s)
  expect(await integrate($, { taskId: 'manual-404' })).toMatchObject({ ok: false, error: { code: 'task_not_found' } })
  expect(s.gitCalls.length).toBe(0)
})

test('a task that ran without a worktree has nothing to merge: no_worktree', async () => {
  const s = fresh()
  s.files.set(`${JOBS}/${TASK}/meta.json`, JSON.stringify({ id: TASK, kind: 'manual', agentId: 'manual', cwd: REPO, startedAt: 1 }))
  const $ = engineOf(s)
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: false, error: { code: 'no_worktree' } })
  expect(s.gitCalls.length).toBe(0)
})

test('a destination that is not a git checkout is not_a_repository, and nothing merges', async () => {
  const s = fresh()
  seedTask(s)
  s.replies.set('status --porcelain', { exitCode: 128, stderr: 'fatal: not a git repository\n' })
  const $ = engineOf(s)
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: false, error: { code: 'not_a_repository' } })
  expect(subcommands(s)).toEqual(['status --porcelain'])
})

test('invalid input is refused at the edge, before git runs', async () => {
  const s = fresh()
  seedTask(s)
  const $ = engineOf(s)
  expect(await integrate($, {})).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(await integrate($, { taskId: TASK, strategy: 'rebase' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(s.gitCalls.length).toBe(0)
  expect(parseIntegrateInput({ taskId: TASK })).toEqual({ input: { taskId: TASK, strategy: 'ff-only' } })
})
