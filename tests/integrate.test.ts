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

type Reply = { exitCode: number; stdout?: string; stderr?: string }
type State = {
  files: Map<string, string>
  replies: Map<string, Reply>
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
  s.replies.set('merge --ff-only', merge)
  s.replies.set('merge --no-ff', merge)
  s.replies.set('rev-parse HEAD', { exitCode: 0, stdout: 'newsha0001\n' })
  // No merge is in progress unless a test says so: MERGE_HEAD is absent.
  s.replies.set('rev-parse -q', { exitCode: 1 })
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
  expect(subcommands(s).slice(-2)).toEqual(['rev-parse -q --verify MERGE_HEAD', 'merge --abort'])
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
  expect(subcommands(s).slice(-2)).toEqual(['rev-parse -q --verify MERGE_HEAD', 'merge --abort'])
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
