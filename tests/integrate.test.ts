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

const PROBE_ALIVE = 11
const PROBE_GONE = 12

// The clock reads a minute after the fixture jobs began, past the 10 s that a job has to write its pgid.
const STARTED = 2000000
const MINUTE = 60_000

// `throws` makes the call reject, as the engine does for a git call that outlives its timeout.
type Reply = { exitCode: number; stdout?: string; stderr?: string; throws?: string; truncated?: boolean }
type State = {
  files: Map<string, string>
  // A list answers its replies in order, and the last one answers every later call.
  replies: Map<string, Reply | Reply[]>
  gitCalls: string[][]
  live: Set<string>
  now: number
  probeBroken: boolean
}

function fresh(): State {
  return {
    files: new Map([[CONFIG_PATH, CONFIG]]),
    replies: new Map(),
    gitCalls: [],
    live: new Set(),
    now: STARTED + MINUTE,
    probeBroken: false,
  }
}

// The git calls the integrate path makes on a clean checkout where the task branch is ahead of HEAD.
function clean(s: State, merge: Reply = { exitCode: 0 }) {
  s.replies.set('status --porcelain', { exitCode: 0, stdout: '' })
  s.replies.set('merge-base --is-ancestor', { exitCode: 1 })
  s.replies.set('diff -z --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('merge --ff-only', merge)
  s.replies.set('merge --no-ff', merge)
  s.replies.set('rev-parse HEAD', { exitCode: 0, stdout: 'newsha0001\n' })
  // No merge is in progress unless a test says so: MERGE_HEAD is absent.
  s.replies.set('rev-parse -q', { exitCode: 1 })
}

// The two reads that decide the cleanup. Neither lets a submodule setting hide a gitlink, and both are NUL separated without renames.
const STATUS_Z = 'status --porcelain -z --no-renames --ignore-submodules=none'
const DIFF_PATHS = `diff -z --name-only --no-renames --ignore-submodules=none HEAD...${BRANCH}`

// `git diff -z` and `git status --porcelain -z` end each entry with NUL.
const z = (...entries: string[]): string => entries.map((entry) => `${entry}\0`).join('')

// The paths the task branch changes, which integrate reads before the merge.
function mergePaths(s: State, ...paths: string[]) {
  s.replies.set('diff -z --name-only', { exitCode: 0, stdout: z(...paths) })
}

// What the status calls answer, in order: the dirty-checkout gate, the look after the failed merge, and the look after the cleanup.
function statuses(s: State, ...stdouts: string[]) {
  s.replies.set('status --porcelain', stdouts.map((stdout) => ({ exitCode: 0, stdout })))
}

function seedJob(s: State, id: string, fields: Record<string, unknown> = {}) {
  s.files.set(
    `${JOBS}/${id}/meta.json`,
    JSON.stringify({
      id,
      kind: 'manual',
      agentId: 'manual',
      cwd: WORKTREE,
      startedAt: STARTED,
      repo: REPO,
      baseSha: 'abc123',
      branch: BRANCH,
      worktree: WORKTREE,
      ...fields,
    }),
  )
  s.files.set(`${JOBS}/${id}/exit`, '0')
}

function seedTask(s: State, fields: Record<string, unknown> = {}) {
  seedJob(s, TASK, fields)
}

function runLive(s: State, id: string) {
  s.files.delete(`${JOBS}/${id}/exit`)
  s.files.set(`${JOBS}/${id}/pgid`, '4242\n')
  s.live.add(id)
}

/** The part of `$` that integrate calls, over the state of one test. The kit's own `$` has no such members. */
function engineOf(s: State): any {
  return {
    clock: { now: async () => s.now },
    ui: { log: async () => undefined },
    env: { get: async () => '/home/test' },
    fs: {
      exists: async (path: string) => s.files.has(path),
      read: async (path: string) => {
        const text = s.files.get(path)
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return text
      },
      list: async (dir: string) => {
        const names = new Set<string>()
        for (const path of s.files.keys()) if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0] ?? '')
        return [...names].map((name) => ({ name, kind: 'dir' }))
      },
    },
    process: {
      run: async (argv: string[]) => {
        if (argv[0] === 'bash') {
          if (s.probeBroken) throw new Error('spawn bash EAGAIN')
          const id = /cat \S+\/([^/\s]+)\/pgid/.exec(argv[2] ?? '')?.[1] ?? ''
          return { exitCode: s.live.has(id) ? PROBE_ALIVE : PROBE_GONE, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        }
        if (argv[0] !== 'git') throw new Error(`unexpected process.run: ${argv[0]}`)
        s.gitCalls.push(argv)
        const sub = argv.slice(3).join(' ')
        const key = [...s.replies.keys()].find((k) => sub.startsWith(k))
        if (key === undefined) throw new Error(`unexpected git: ${sub}`)
        const entry = s.replies.get(key) ?? { exitCode: 0 }
        const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) ?? { exitCode: 0 } : entry
        if (reply.throws !== undefined) throw new Error(reply.throws)
        return {
          exitCode: reply.exitCode,
          stdout: reply.stdout ?? '',
          stderr: reply.stderr ?? '',
          isStdoutTruncated: reply.truncated === true,
          isStderrTruncated: false,
        }
      },
    },
  }
}

// The answer the model reads, as the server sends it: the payload of the outcome as JSON text, parsed for the assertions.
async function integrate($: any, args: Record<string, unknown>, gitHooks?: 'run'): Promise<Record<string, any>> {
  const parsed = parseIntegrateInput(args)
  const { config } = await loadConfig($)
  const outcome = 'failure' in parsed ? parsed : await integrateTask($, config.jobsDir, parsed.input, gitHooks)
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
    DIFF_PATHS,
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
    DIFF_PATHS,
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
  mergePaths(s, 'a.txt', 'b/c.txt')
  statuses(s, '', z('UU a.txt', 'UU b/c.txt'), '')
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'merge_conflict', files: ['a.txt', 'b/c.txt'] } })
  expect(r.error.message).toContain('the merge was aborted')
  expect(subcommands(s)).toEqual([
    'status --porcelain',
    `merge-base --is-ancestor ${BRANCH} HEAD`,
    DIFF_PATHS,
    `merge --no-ff --no-edit ${BRANCH}`,
    'diff --name-only --diff-filter=U',
    'rev-parse -q --verify MERGE_HEAD',
    STATUS_Z,
    'merge --abort',
    STATUS_Z,
  ])
})

test('a failed merge that left MERGE_HEAD with no unmerged file is aborted and is hook_failed, carrying the hook output', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, {
    exitCode: 1,
    stderr: "lint: trailing space in a.txt\nNot committing merge; use 'git commit' to complete the merge.\n",
  })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('lint: trailing space in a.txt')
  expect(r.error.message).toContain('the merge was aborted')
  expect(r.error.message).not.toContain('Not committing merge')
  expect(subcommands(s).slice(-4)).toEqual([
    'rev-parse -q --verify MERGE_HEAD',
    STATUS_Z,
    'merge --abort',
    STATUS_Z,
  ])
})

test('the hook output in hook_failed is redacted and cut to its last 20 lines', async () => {
  const s = fresh()
  seedTask(s)
  const lines = Array.from({ length: 24 }, (_, i) => `out-${String(i + 1).padStart(2, '0')}`)
  clean(s, { exitCode: 1, stderr: `${lines.join('\n')}\npassword=not-a-real-secret\n` })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('password=[REDACTED]')
  expect(r.error.message).not.toContain('not-a-real-secret')
  expect(r.error.message).toContain('out-24')
  expect(r.error.message).toContain('out-06')
  expect(r.error.message).not.toContain('out-05')
})

test('a hook that printed nothing is still hook_failed, and the answer says so', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stderr: "Not committing merge; use 'git commit' to complete the merge.\n" })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('printed nothing')
})

test('conflicting files win over a pending merge: the abort leaves merge_conflict, not hook_failed', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stderr: 'hook: this text must not decide the code\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: 'a.txt\n' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'merge_conflict', files: ['a.txt'] } })
})

test('a failed merge with no MERGE_HEAD whose fatal line names a hook is hook_failed, with nothing to abort', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 128, stderr: 'ref guard: main is protected\nfatal: ref updates aborted by hook\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('ref guard: main is protected')
  expect(subcommands(s).some((sub) => sub === 'merge --abort')).toBe(false)
})

test('a hint that mentions a hook does not make a failed fast-forward hook_failed', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, {
    exitCode: 128,
    stderr: "hint: The '.git/hooks/post-merge' hook was ignored because it's not set as executable.\nfatal: Not possible to fast-forward, aborting.\n",
  })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  const $ = engineOf(s)
  expect(await integrate($, { taskId: TASK }, 'run')).toMatchObject({ ok: false, error: { code: 'not_fast_forward' } })
})

test('a failed merge with no MERGE_HEAD, no conflict and no hook in git output is git_failed, with git first line', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 128, stderr: 'fatal: refusing to merge unrelated histories\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('refusing to merge unrelated histories')
  expect(r.error.message).not.toContain('the merge was aborted')
})

test('without the opt-in, a merge that left MERGE_HEAD with no unmerged file is aborted and is git_failed, never hook_failed', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stderr: "lint: trailing space in a.txt\nNot committing merge; use 'git commit' to complete the merge.\n" })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('the merge was aborted')
  expect(subcommands(s).slice(-4)).toEqual([
    'rev-parse -q --verify MERGE_HEAD',
    STATUS_Z,
    'merge --abort',
    STATUS_Z,
  ])
})

test('without the opt-in, a fatal line that names a hook does not make a failed merge hook_failed', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 128, stderr: 'fatal: ref updates aborted by hook\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  const $ = engineOf(s)
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: false, error: { code: 'not_fast_forward' } })
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
    DIFF_PATHS,
    `merge --ff-only ${BRANCH}`,
    'diff --name-only --diff-filter=U',
    'rev-parse -q --verify MERGE_HEAD',
    STATUS_Z,
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

test('a task whose own job still runs is task_running, naming the job, before any git call', async () => {
  const s = fresh()
  seedTask(s)
  runLive(s, TASK)
  clean(s)
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'task_running' } })
  expect(r.error.message).toContain(TASK)
  expect(s.gitCalls.length).toBe(0)
})

test('a live job that took over the task branch is task_running with its id, though the task job has ended', async () => {
  const s = fresh()
  seedTask(s)
  const next = 'task-2000500-agent-n3x7q1b2'
  seedJob(s, next)
  runLive(s, next)
  clean(s)
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'task_running' } })
  expect(r.error.message).toContain(next)
  expect(r.error.message).not.toContain(`${TASK} `)
  expect(s.gitCalls.length).toBe(0)
})

test('a live job on another branch, and an ended job on this one, leave the merge alone', async () => {
  const s = fresh()
  seedTask(s)
  seedJob(s, 'job-other', { branch: 'orq/job-other', cwd: `${REPO}-wt/job-other`, worktree: `${REPO}-wt/job-other` })
  runLive(s, 'job-other')
  seedJob(s, 'job-old')
  clean(s)
  const $ = engineOf(s)
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: true, taskId: TASK })
})

test('a job with no exit file and a gone process group is not running, so the task still integrates', async () => {
  const s = fresh()
  seedTask(s)
  s.files.delete(`${JOBS}/${TASK}/exit`)
  clean(s)
  const $ = engineOf(s)
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: true, taskId: TASK })
})

test('a jobs directory that cannot be listed stops integrate instead of skipping the live-job check', async () => {
  const s = fresh()
  seedTask(s)
  clean(s)
  const $ = engineOf(s)
  $.fs.list = async () => {
    throw new Error('EACCES: jobs')
  }
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('EACCES: jobs')
  expect(s.gitCalls.length).toBe(0)
})

const TIMED_OUT = 'git did not finish within 60000 ms, so it was killed'

function killed(s: State) {
  clean(s)
  s.replies.set('merge --no-ff', { exitCode: 0, throws: TIMED_OUT })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
}

test('a merge that git did not finish, with MERGE_HEAD pending, is aborted: git_failed names the timeout, and the checkout is looked at afterwards', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('did not finish within 60000 ms')
  expect(r.error.message).toContain('the merge was aborted')
  expect(subcommands(s).slice(-4)).toEqual([
    'rev-parse -q --verify MERGE_HEAD',
    STATUS_Z,
    'merge --abort',
    STATUS_Z,
  ])
})

test('a killed merge with no MERGE_HEAD whose changed paths are all the merge\'s is reset by itself, and the answer lists what the hook left', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  mergePaths(s, 'f.txt')
  statuses(s, '', z('A  f.txt', '?? hook-made.txt'), z('?? hook-made.txt'))
  s.replies.set('reset --merge', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('did not finish within 60000 ms')
  expect(r.error.message).toContain('the half-made merge was undone with git reset --merge')
  expect(r.error.message).toContain('has changes: hook-made.txt')
  expect(r.error.message).not.toContain('f.txt,')
  expect(subcommands(s).slice(-6)).toEqual([
    'diff --name-only --diff-filter=U',
    'rev-parse -q --verify MERGE_HEAD',
    `merge-base --is-ancestor ${BRANCH} HEAD`,
    STATUS_Z,
    'reset --merge',
    STATUS_Z,
  ])
})

test('a killed merge with no MERGE_HEAD and a tracked change outside the merge resets nothing: the answer names the path as probably the user\'s, lists the rest, and names git reset --merge', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  mergePaths(s, 'f.txt')
  statuses(s, '', z('A  f.txt', 'M  other.txt', '?? hook-made.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('did not finish within 60000 ms')
  expect(r.error.message).toContain('nothing was reset')
  expect(r.error.message).toContain('other.txt is probably a change of your own, and the merge does not touch it')
  expect(r.error.message).toContain('the rest of what changed: f.txt, hook-made.txt')
  expect(r.error.message).toContain('run git reset --merge in')
  expect(r.error.message).toContain('staged changes of your own go with it')
  expect(subcommands(s).some((sub) => sub.startsWith('reset'))).toBe(false)
  expect(subcommands(s).slice(-4)).toEqual([
    'diff --name-only --diff-filter=U',
    'rev-parse -q --verify MERGE_HEAD',
    `merge-base --is-ancestor ${BRANCH} HEAD`,
    STATUS_Z,
  ])
})

test('a killed merge with MERGE_HEAD pending and a tracked change outside the merge is not aborted: the answer names git merge --abort for the user to run', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('rev-parse -q', { exitCode: 0 })
  mergePaths(s, 'f.txt')
  statuses(s, '', z('A  f.txt', 'M  other.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('the merge was not aborted')
  expect(r.error.message).toContain('other.txt is probably a change of your own')
  expect(r.error.message).toContain('run git merge --abort in')
  expect(subcommands(s).some((sub) => sub.startsWith('merge --abort') || sub.startsWith('reset'))).toBe(false)
  expect(subcommands(s).slice(-3)).toEqual([
    'diff --name-only --diff-filter=U',
    'rev-parse -q --verify MERGE_HEAD',
    STATUS_Z,
  ])
})

test('a failed merge that leaves only a tracked change of the user, with no merge to drop, changes nothing and names no command', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 128, stderr: 'fatal: Not possible to fast-forward, aborting.\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  mergePaths(s, 'f.txt')
  statuses(s, '', z(' M other.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'not_fast_forward' } })
  expect(r.error.message).toContain('other.txt is probably a change of your own, and the merge does not touch it, so nothing was reset')
  expect(r.error.message).not.toContain('run git')
  expect(subcommands(s).some((sub) => sub.startsWith('reset') || sub.startsWith('merge --abort'))).toBe(false)
})

test('a killed merge that left only a tracked change outside the merge, with no MERGE_HEAD, names no command', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  mergePaths(s, 'f.txt')
  statuses(s, '', z(' M other.txt', '?? hook-made.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('did not finish within 60000 ms')
  expect(r.error.message).toContain('other.txt is probably a change of your own')
  expect(r.error.message).toContain('the rest of what changed: hook-made.txt')
  expect(r.error.message).not.toContain('run git')
  expect(subcommands(s).some((sub) => sub.startsWith('reset'))).toBe(false)
})

const NOTHING_RUNS = (s: State): boolean => !subcommands(s).some((sub) => sub === 'merge --abort' || sub.startsWith('reset'))

test('a status cut at the size limit stops the abort even when every record it holds is on a merge path, and the answer names the command', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('rev-parse -q', { exitCode: 0 })
  mergePaths(s, 'f.txt', 'g.txt')
  s.replies.set('status --porcelain', [
    { exitCode: 0, stdout: '' },
    { exitCode: 0, stdout: z('A  f.txt', 'A  g.txt'), truncated: true },
  ])
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('the merge was not aborted, because the checkout has more changes than integrate can read')
  expect(r.error.message).toContain('what it read: f.txt, g.txt')
  expect(r.error.message).toContain('run git merge --abort in')
  expect(r.error.message).toContain('staged changes of your own go with it')
  expect(NOTHING_RUNS(s)).toBe(true)
})

test('a status cut at the size limit stops the reset of a half-made merge, and the answer names git reset --merge', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  mergePaths(s, 'f.txt')
  s.replies.set('status --porcelain', [
    { exitCode: 0, stdout: '' },
    { exitCode: 0, stdout: z('A  f.txt'), truncated: true },
  ])
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('nothing was reset, because the checkout has more changes than integrate can read')
  expect(r.error.message).toContain('run git reset --merge in')
  expect(NOTHING_RUNS(s)).toBe(true)
})

test('a status cut inside a record lists only the complete records', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  mergePaths(s, 'f.txt')
  s.replies.set('status --porcelain', [
    { exitCode: 0, stdout: '' },
    { exitCode: 0, stdout: `${z('A  f.txt')}A  long/path/that/was/cu`, truncated: true },
  ])
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r.error.message).toContain('what it read: f.txt.')
  expect(r.error.message).not.toContain('long/path')
})

test('a merge-path list cut at the size limit stops the abort, and the answer says the task changes more files than integrate can read', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('diff -z --name-only', { exitCode: 0, stdout: z('f.txt'), truncated: true })
  statuses(s, '', z('A  f.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('the merge was not aborted, because the task branch changes more files than integrate can read')
  expect(r.error.message).toContain('run git merge --abort in')
  expect(r.error.message).not.toContain('probably a change of your own')
  expect(NOTHING_RUNS(s)).toBe(true)
})

test('a cut merge-path list says nothing when there is nothing to undo', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 128, stderr: 'fatal: Not possible to fast-forward, aborting.\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('diff -z --name-only', { exitCode: 0, stdout: z('f.txt'), truncated: true })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'not_fast_forward' } })
  expect(r.error.message).not.toContain('integrate can read')
})

test('a merge path and a path of the user that decode to the same string stop the cleanup', async () => {
  const same = 'f�'
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('rev-parse -q', { exitCode: 0 })
  mergePaths(s, same)
  statuses(s, '', z(`M  ${same}`))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('the merge was not aborted, because a path that git printed is not valid UTF-8')
  expect(r.error.message).toContain('run git merge --abort in')
  expect(NOTHING_RUNS(s)).toBe(true)
})

test('a path in the status that is not valid UTF-8 stops the cleanup and is not called the user\'s', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  mergePaths(s, 'f.txt')
  statuses(s, '', z('A  f.txt', 'M  g�'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r.error.message).toContain('nothing was reset, because a path that git printed is not valid UTF-8')
  expect(r.error.message).not.toContain('probably a change of your own')
  expect(NOTHING_RUNS(s)).toBe(true)
})

test('an untracked path that is not valid UTF-8 does not stop the cleanup', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  mergePaths(s, 'f.txt')
  statuses(s, '', z('A  f.txt', '?? made�'), z('?? made�'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r.error.message).toContain('the merge was aborted')
  expect(subcommands(s).some((sub) => sub === 'merge --abort')).toBe(true)
})

test('a change of the user to a path that the merge also touches counts as the merge\'s, so the merge is aborted', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  mergePaths(s, 'f.txt', 'shared.txt')
  statuses(s, '', z('A  f.txt', 'M  shared.txt'), '')
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('the merge was aborted')
  expect(r.error.message).not.toContain('probably a change of your own')
  expect(subcommands(s).some((sub) => sub === 'merge --abort')).toBe(true)
})

test('a path with a space and an accent is compared as it is on disk, so the merge is still aborted', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  mergePaths(s, 'a b.txt', 'é.txt')
  statuses(s, '', z('A  a b.txt', 'A  é.txt'), '')
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r.error.message).toContain('the merge was aborted')
  expect(r.error.message).not.toContain('probably a change of your own')
})

test('integrate reads the paths of the merge before it runs, and stops with git_failed when git cannot list them', async () => {
  const s = fresh()
  seedTask(s)
  clean(s)
  s.replies.set('diff -z --name-only', { exitCode: 128, stderr: 'fatal: ambiguous argument\n' })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('could not list the files')
  expect(subcommands(s).some((sub) => sub.startsWith('merge --'))).toBe(false)
})

test('a killed merge lists at most 10 of the changed paths, and counts the rest', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  const changed = Array.from({ length: 12 }, (_, i) => `?? made-${String(i + 1).padStart(2, '0')}.txt`)
  statuses(s, '', z(...changed))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('made-10.txt')
  expect(r.error.message).not.toContain('made-11.txt')
  expect(r.error.message).toContain('2 more')
})

test('a killed merge whose ancestry check fails with exit 128 stops the cleanup and says so', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('merge-base --is-ancestor', [{ exitCode: 1 }, { exitCode: 128, stderr: 'fatal: Not a valid object name\n' }])
  statuses(s, '', z('A  f.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('git merge-base --is-ancestor failed')
  expect(r.error.message).toContain('Not a valid object name')
  expect(subcommands(s).slice(-1)).toEqual([`merge-base --is-ancestor ${BRANCH} HEAD`])
})

test('a killed merge that had already moved HEAD onto the branch says so, lists what stays, and resets nothing, whatever the paths', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('merge-base --is-ancestor', [{ exitCode: 1 }, { exitCode: 0 }])
  mergePaths(s, 'f.txt')
  statuses(s, '', z('M  package-lock.json', '?? post-merge-made.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('did not finish within 60000 ms')
  expect(r.error.message).toContain(`${BRANCH} is already part of HEAD`)
  expect(r.error.message).toContain('nothing was reset')
  expect(r.error.message).toContain('package-lock.json, post-merge-made.txt')
  expect(r.error.message).not.toContain('git reset --merge')
  expect(subcommands(s).some((sub) => sub.startsWith('reset') || sub.startsWith('merge --abort'))).toBe(false)
})

test('a killed merge with MERGE_HEAD pending lists what stays after the abort, without saying who made it', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  statuses(s, '', z('?? stray.txt'), z('?? stray.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('the merge was aborted')
  expect(r.error.message).toContain('has changes: stray.txt')
  expect(r.error.message).not.toContain('the hook made')
})

test('a killed merge in a checkout that ends clean says nothing about leftovers and resets nothing', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('did not finish within 60000 ms')
  expect(r.error.message).not.toContain('keeps changes')
  expect(r.error.message).not.toContain('already part of HEAD')
  expect(subcommands(s).some((sub) => sub.startsWith('reset'))).toBe(false)
})

test('a killed merge whose abort fails is git_failed, and the message says the checkout may be mid-merge', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 128, stderr: 'fatal: Unable to create index.lock: File exists\n' })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('may still be mid-merge')
  expect(r.error.message).toContain('index.lock')
})

test('a killed merge whose reset fails is git_failed, and the message says the checkout may be mid-merge', async () => {
  const s = fresh()
  seedTask(s)
  killed(s)
  mergePaths(s, 'f.txt')
  statuses(s, '', z('A  f.txt'))
  s.replies.set('reset --merge', { exitCode: 128, stderr: 'fatal: Unable to create index.lock: File exists\n' })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'git_failed' } })
  expect(r.error.message).toContain('may still be mid-merge')
  expect(r.error.message).toContain('git reset --merge failed')
})

test('a hook that refuses with no MERGE_HEAD, as a reference-transaction hook does, still has what it left in the checkout named', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 128, stderr: 'ref guard: no\nfatal: ref updates aborted by hook\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  statuses(s, '', z('?? hook-made.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('keeps changes the hook made')
  expect(r.error.message).toContain('hook-made.txt')
  expect(r.error.message).toContain('ref guard: no')
  expect(r.error.message).not.toContain('the merge was aborted')
  expect(subcommands(s).slice(-3)).toEqual(['diff --name-only --diff-filter=U', 'rev-parse -q --verify MERGE_HEAD', STATUS_Z])
})

test('a half-made merge left by a failed merge that was not killed, with no MERGE_HEAD, is reset when every changed path is the merge\'s', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 128, stderr: 'fatal: ref updates aborted by hook\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('reset --merge', { exitCode: 0 })
  mergePaths(s, 'f.txt')
  statuses(s, '', z('M  f.txt'), '')
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('the half-made merge was undone with git reset --merge')
  expect(subcommands(s).slice(-3)).toEqual([STATUS_Z, 'reset --merge', STATUS_Z])
})

test('a hook refusal with MERGE_HEAD pending and a tracked change outside the merge is hook_failed, and the merge is not aborted', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stderr: "lint: no\nNot committing merge; use 'git commit' to complete the merge.\n" })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  mergePaths(s, 'a.txt')
  statuses(s, '', z('A  a.txt', 'M  other.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('the merge was not aborted')
  expect(r.error.message).toContain('other.txt is probably a change of your own')
  expect(r.error.message).toContain('run git merge --abort in')
  expect(r.error.message).toContain('lint: no')
  expect(subcommands(s).some((sub) => sub === 'merge --abort')).toBe(false)
})

test('a conflict with a tracked change outside the merge is merge_conflict with its files, and the merge is not aborted', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stdout: 'CONFLICT (content): Merge conflict in a.txt\n' })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: 'a.txt\n' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  mergePaths(s, 'a.txt')
  statuses(s, '', z('UU a.txt', ' M other.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' })
  expect(r).toMatchObject({ ok: false, error: { code: 'merge_conflict', files: ['a.txt'] } })
  expect(r.error.message).toContain('the merge was not aborted')
  expect(r.error.message).toContain('other.txt is probably a change of your own')
  expect(subcommands(s).some((sub) => sub === 'merge --abort')).toBe(false)
})

test('a hook that left files behind: hook_failed says the checkout keeps changes the hook made, and lists them', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stderr: "lint: no\nNot committing merge; use 'git commit' to complete the merge.\n" })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  mergePaths(s, 'a.txt')
  statuses(s, '', z('A  a.txt', '?? generated.txt', '?? other-made.txt'), z('?? generated.txt', '?? other-made.txt'))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('keeps changes the hook made')
  expect(r.error.message).toContain('generated.txt, other-made.txt')
  expect(r.error.message).toContain('lint: no')
  expect(subcommands(s).slice(-2)).toEqual(['merge --abort', STATUS_Z])
})

test('hook_failed lists at most 10 of the paths a hook left, and counts the rest', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stderr: "Not committing merge; use 'git commit' to complete the merge.\n" })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const left = Array.from({ length: 12 }, (_, i) => `?? leftover-${String(i + 1).padStart(2, '0')}.txt`)
  statuses(s, '', z(...left))
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('leftover-01.txt')
  expect(r.error.message).toContain('leftover-10.txt')
  expect(r.error.message).not.toContain('leftover-11.txt')
  expect(r.error.message).not.toContain('leftover-12.txt')
  expect(r.error.message).toContain('2 more')
})

test('an aborted merge in a checkout that ends clean says nothing about leftovers', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, { exitCode: 1, stderr: "lint: no\nNot committing merge; use 'git commit' to complete the merge.\n" })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).not.toContain('keeps changes')
})

test('hook_failed carries what git printed on stdout as well, redacted', async () => {
  const s = fresh()
  seedTask(s)
  clean(s, {
    exitCode: 1,
    stdout: 'Auto-merging a.txt\nlint-on-stdout: trailing space\npassword=not-a-real-secret\n',
    stderr: "Not committing merge; use 'git commit' to complete the merge.\n",
  })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('lint-on-stdout: trailing space')
  expect(r.error.message).toContain('password=[REDACTED]')
  expect(r.error.message).not.toContain('not-a-real-secret')
  expect(r.error.message).not.toContain('printed nothing')
})

test('the hook output is the last 20 lines of stdout and stderr together', async () => {
  const s = fresh()
  seedTask(s)
  const numbered = (prefix: string) => Array.from({ length: 15 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`).join('\n')
  clean(s, { exitCode: 1, stdout: `${numbered('out')}\n`, stderr: `${numbered('err')}\n` })
  s.replies.set('diff --name-only', { exitCode: 0, stdout: '' })
  s.replies.set('rev-parse -q', { exitCode: 0 })
  s.replies.set('merge --abort', { exitCode: 0 })
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK, strategy: 'merge' }, 'run')
  expect(r).toMatchObject({ ok: false, error: { code: 'hook_failed' } })
  expect(r.error.message).toContain('out-11')
  expect(r.error.message).toContain('err-15')
  expect(r.error.message).not.toContain('out-10')
})

const ELSEWHERE = '/srv/example/elsewhere'

function seedShared(s: State, id: string, cwd: string) {
  seedJob(s, id, { cwd, repo: undefined, baseSha: undefined, branch: undefined, worktree: undefined })
}

test('a live job inside the task worktree is task_running, though a shared launch records no branch', async () => {
  const s = fresh()
  seedTask(s)
  seedShared(s, 'job-shared', `${WORKTREE}/src`)
  runLive(s, 'job-shared')
  clean(s)
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'task_running' } })
  expect(r.error.message).toContain('job-shared')
  expect(r.error.message).toContain(WORKTREE)
  expect(s.gitCalls.length).toBe(0)
})

test('a live job whose cwd is the task worktree itself is task_running', async () => {
  const s = fresh()
  seedTask(s)
  seedShared(s, 'job-at-root', WORKTREE)
  runLive(s, 'job-at-root')
  clean(s)
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'task_running' } })
  expect(r.error.message).toContain('job-at-root')
})

test('a live job beside the worktree whose path starts like it, and an ended job inside it, leave the merge alone', async () => {
  const s = fresh()
  seedTask(s)
  seedShared(s, 'job-beside', `${WORKTREE}-other`)
  runLive(s, 'job-beside')
  seedShared(s, 'job-ended', `${WORKTREE}/src`)
  clean(s)
  const $ = engineOf(s)
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: true, taskId: TASK })
})

test('a live job on the task branch spelled refs/heads/... is task_running', async () => {
  const s = fresh()
  seedTask(s)
  const next = 'task-2000500-agent-n3x7q1b2'
  seedJob(s, next, { branch: `refs/heads/${BRANCH}`, cwd: ELSEWHERE })
  runLive(s, next)
  clean(s)
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'task_running' } })
  expect(r.error.message).toContain(next)
})

test('a live job on the plain branch is task_running when the task itself names it as refs/heads/...', async () => {
  const s = fresh()
  seedTask(s, { branch: `refs/heads/${BRANCH}` })
  const next = 'task-2000500-agent-n3x7q1b2'
  seedJob(s, next, { cwd: ELSEWHERE })
  runLive(s, next)
  clean(s)
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'task_running' } })
  expect(r.error.message).toContain(next)
})

test('a job with no pgid that began a moment ago is running, and one that began a minute ago is gone', async () => {
  const s = fresh()
  seedTask(s)
  s.files.delete(`${JOBS}/${TASK}/exit`)
  clean(s)
  const $ = engineOf(s)
  s.now = STARTED + 2_000
  const young = await integrate($, { taskId: TASK })
  expect(young).toMatchObject({ ok: false, error: { code: 'task_running' } })
  expect(young.error.message).toContain(`task ${TASK} is still running`)
  expect(s.gitCalls.length).toBe(0)
  s.now = STARTED + MINUTE
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: true, taskId: TASK })
})

test('a job just launched on the task branch, with no pgid yet, is task_running with its own id', async () => {
  const s = fresh()
  seedTask(s)
  const next = 'task-2000500-agent-n3x7q1b2'
  seedJob(s, next, { startedAt: STARTED + 59_000 })
  s.files.delete(`${JOBS}/${next}/exit`)
  clean(s)
  const $ = engineOf(s)
  const r = await integrate($, { taskId: TASK })
  expect(r).toMatchObject({ ok: false, error: { code: 'task_running' } })
  expect(r.error.message).toContain(`task ${next} is still running`)
})

test('a young job whose pgid exists and whose process group is gone is not running', async () => {
  const s = fresh()
  seedTask(s)
  s.files.delete(`${JOBS}/${TASK}/exit`)
  s.files.set(`${JOBS}/${TASK}/pgid`, '4242\n')
  clean(s)
  s.now = STARTED + 2_000
  const $ = engineOf(s)
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: true, taskId: TASK })
})

test('a liveness probe that throws counts as running while the job is young, and as gone after that', async () => {
  const s = fresh()
  seedTask(s)
  s.files.delete(`${JOBS}/${TASK}/exit`)
  s.files.set(`${JOBS}/${TASK}/pgid`, '4242\n')
  s.probeBroken = true
  clean(s)
  const $ = engineOf(s)
  s.now = STARTED + 2_000
  const young = await integrate($, { taskId: TASK })
  expect(young).toMatchObject({ ok: false, error: { code: 'task_running' } })
  expect(s.gitCalls.length).toBe(0)
  s.now = STARTED + MINUTE
  expect(await integrate($, { taskId: TASK })).toMatchObject({ ok: true, taskId: TASK })
})
