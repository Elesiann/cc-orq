import type { IntegrateGitHooks } from './config.ts'
import { jobIsLive, readMeta, type CoreEngine } from './engine.ts'
import {
  INTEGRATE_STRATEGIES,
  type GitFailure,
  type IntegrateInput,
  type IntegrateStrategy,
  type Integrated,
} from './contract.ts'
import { failureSnippet, isRecord, isWithin, shortBranch, type JobRecord } from './types.ts'
import {
  GIT_TIMEOUT_MS,
  gitArgv,
  gitDetail,
  isAncestorArgv,
  mergeAbortArgv,
  mergeArgv,
  mergeHeadArgv,
  outputLines,
  revParseHeadArgv,
  statusArgv,
  unmergedFilesArgv,
} from './worktree.ts'

export type IntegrateOutcome = { integrated: Integrated } | { failure: GitFailure }

type ProcessResult = Awaited<ReturnType<CoreEngine['process']['run']>>
type Git = (argv: string[]) => Promise<ProcessResult>

function fail(code: GitFailure['code'], message: string, files?: string[]): { failure: GitFailure } {
  return { failure: files === undefined ? { code, message } : { code, message, files } }
}

function isStrategy(value: unknown): value is IntegrateStrategy {
  return INTEGRATE_STRATEGIES.some((s) => s === value)
}

/** A fatal or error line of git that names a hook, such as `fatal: ref updates aborted by hook`. */
const GIT_NAMES_A_HOOK = /^(?:fatal|error): .*\bhooks?\b/im

/** The line git ends with when a hook refuses a merge commit. orq aborts that merge, so the advice is wrong. */
const GIT_COMMIT_ADVICE = 'Not committing merge;'

const LEFT_PATHS_LISTED = 10

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A shared launch records no branch, so a job also counts when it runs inside the task's worktree. */
function worksOnTask(job: JobRecord, branch: string, worktree: string): boolean {
  if (job.branch !== undefined && shortBranch(job.branch) === shortBranch(branch)) return true
  return isWithin(job.cwd, worktree)
}

/** The id of the first live job on the task: the task's own job first, then the others in id order. */
async function liveJobOn($: CoreEngine, jobsDir: string, task: JobRecord, branch: string, worktree: string): Promise<string | null> {
  const names = (await $.fs.list(jobsDir))
    .filter((entry) => entry.kind === 'dir' && entry.name !== task.id)
    .map((entry) => entry.name)
    .sort()
  const onTask = [task]
  for (const name of names) {
    const job = await readMeta($, jobsDir, name)
    if (job !== null && worksOnTask(job, branch, worktree)) onTask.push(job)
  }
  for (const job of onTask) {
    if (await jobIsLive($, job)) return job.id
  }
  return null
}

/** The hook's output from what the refused merge printed on both streams: redacted, cut to its last 20 lines, without git's advice. */
function hookOutput(stdout: string, stderr: string): string {
  const printed = [stdout, stderr].map((stream) => stream.trimEnd()).filter((stream) => stream !== '')
  const lines = printed.join('\n').split('\n').filter((line) => !line.startsWith(GIT_COMMIT_ADVICE))
  return failureSnippet(lines.join('\n').trim())
}

/** The tool input as the model sent it: a job id, and a strategy that defaults to ff-only. */
export function parseIntegrateInput(raw: unknown): { input: IntegrateInput } | { failure: GitFailure } {
  if (!isRecord(raw) || typeof raw.taskId !== 'string' || raw.taskId === '') {
    return fail('invalid_request', 'taskId must be the job id of the finished task')
  }
  const strategy = raw.strategy ?? 'ff-only'
  if (!isStrategy(strategy)) return fail('invalid_request', `strategy must be one of ${INTEGRATE_STRATEGIES.join(', ')}`)
  return { input: { taskId: raw.taskId, strategy } }
}

type Attempt = { result: ProcessResult } | { unfinished: string }

async function attempt(run: Git, argv: string[]): Promise<Attempt> {
  try {
    return { result: await run(argv) }
  } catch (err) {
    return { unfinished: reasonOf(err) }
  }
}

async function must(run: Git, argv: string[], what: string): Promise<ProcessResult> {
  const r = await run(argv)
  if (r.exitCode !== 0) throw new Error(`${what} failed${gitDetail(r.stderr)}`)
  return r
}

/** The NUL-terminated records of an output. When the engine cut it at its size limit, the text after the last NUL is an unfinished record, and it is dropped. */
function recordsOf(output: ProcessResult): string[] {
  const records = output.stdout.split('\0')
  if (output.isStdoutTruncated) records.pop()
  return records.filter((record) => record !== '')
}

/** What the engine puts in a string for a byte that is not UTF-8: two different paths can read as one. */
const UNDECODED = '\uFFFD'

const CHECKOUT_CUT = 'the checkout has more changes than integrate can read'
const PATHS_CUT = "the task branch changes more files than integrate can read, so it cannot tell which changes are the merge's"
const NOT_UTF8 = "a path that git printed is not valid UTF-8, so integrate cannot tell the merge's paths from the user's"

/** The paths the task branch changes since it left HEAD: a merge touches no tracked path outside them. NUL-separated, so a name is never quoted. */
function mergePathsArgv(repo: string, branch: string): string[] {
  return gitArgv(repo, 'diff', '-z', '--name-only', '--no-renames', '--ignore-submodules=none', `HEAD...${branch}`)
}

type MergePaths = { paths: ReadonlySet<string>; cut: boolean; undecodable: boolean }

function readMergePaths(output: ProcessResult): MergePaths {
  const paths = recordsOf(output)
  return { paths: new Set(paths), cut: output.isStdoutTruncated, undecodable: paths.some((path) => path.includes(UNDECODED)) }
}

/** One entry of `git status --porcelain -z --no-renames`: two status letters, a space, and the path as it is on disk. */
type Change = { status: string; path: string }

async function changesIn(run: Git, repo: string): Promise<{ changes: Change[]; cut: boolean }> {
  const status = await must(run, gitArgv(repo, 'status', '--porcelain', '-z', '--no-renames', '--ignore-submodules=none'), 'git status')
  return { changes: recordsOf(status).map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) })), cut: status.isStdoutTruncated }
}

const isTracked = (change: Change): boolean => change.status !== '??'

async function branchIsInHead(run: Git, repo: string, branch: string): Promise<boolean> {
  const compared = await run(isAncestorArgv(repo, branch))
  if (compared.exitCode !== 0 && compared.exitCode !== 1) throw new Error(`git merge-base --is-ancestor failed${gitDetail(compared.stderr)}`)
  return compared.exitCode === 0
}

type Aftermath = {
  conflicted: string[]
  pending: boolean
  done: 'nothing' | 'aborted' | 'reset'
  yours: string[]
  mergeLeft: boolean
  unreadable: string | null
  headHasBranch: boolean
  changes: Change[]
}

/**
 * Undoes the merge only when every changed tracked path is one the merge touches, staged or not: a pending merge is
 * aborted, and a half-made merge with no MERGE_HEAD is reset. git 2.43 runs pre-merge-commit before it writes MERGE_HEAD,
 * so a git killed there leaves the merge in the index with no merge pending. A tracked path outside the merge is
 * probably the user's own change, and both commands drop it, so then nothing runs. The unmerged files are read before
 * any abort, since merge --abort clears them from the index. `mergeLeft` says that a merge is pending or has changed a
 * tracked path, so that there is a merge to drop. `unreadable` says why nothing was compared and nothing runs: an output
 * that the engine cut at its size limit may have lost a path of the user's, and a path that is not UTF-8 may read as another.
 */
async function cleanUp(run: Git, repo: string, branch: string, killed: boolean, merge: MergePaths): Promise<Aftermath> {
  const conflicted = outputLines((await run(unmergedFilesArgv(repo))).stdout)
  const pending = (await run(mergeHeadArgv(repo))).exitCode === 0
  const headHasBranch = killed && !pending && (await branchIsInHead(run, repo, branch))
  const { changes, cut } = await changesIn(run, repo)
  const tracked = changes.filter(isTracked)
  const yours = tracked.filter((change) => !merge.paths.has(change.path)).map((change) => change.path)
  const mergeLeft = pending || tracked.some((change) => merge.paths.has(change.path))
  const needsCleanup = pending || tracked.length > 0
  const undecodable = merge.undecodable || tracked.some((change) => change.path.includes(UNDECODED))
  const unreadable = cut ? CHECKOUT_CUT : needsCleanup && merge.cut ? PATHS_CUT : needsCleanup && undecodable ? NOT_UTF8 : null
  const left: Aftermath = { conflicted, pending, done: 'nothing', yours, mergeLeft, unreadable, headHasBranch, changes }
  if (headHasBranch || unreadable !== null || yours.length > 0 || !mergeLeft) return left
  if (pending) await must(run, mergeAbortArgv(repo), 'git merge --abort')
  else await must(run, gitArgv(repo, 'reset', '--merge'), 'git reset --merge')
  return { ...left, done: pending ? 'aborted' : 'reset', changes: (await changesIn(run, repo)).changes }
}

function pathList(paths: string[]): string {
  const more = paths.length > LEFT_PATHS_LISTED ? `, and ${paths.length - LEFT_PATHS_LISTED} more` : ''
  return `${paths.slice(0, LEFT_PATHS_LISTED).join(', ')}${more}`
}

type Listing = (changes: Change[]) => string

const keptBy = (repo: string, madeBy: string): Listing => (changes) =>
  changes.length === 0 ? '' : `; ${repo} keeps changes ${madeBy} made: ${pathList(changes.map((change) => change.path))}`

const hasChanges = (repo: string): Listing => (changes) =>
  changes.length === 0 ? '' : `; ${repo} has changes: ${pathList(changes.map((change) => change.path))}`

/** The sentence that leaves the cleanup to the user: the command that drops the merge, and what it drops. */
function byHandClause(repo: string, pending: boolean): string {
  const command = pending ? 'git merge --abort' : 'git reset --merge'
  return `. After you check the paths with git status, run ${command} in ${repo} to drop the merge (staged changes of your own go with it, and untracked files stay)`
}

/** What the cleanup did, or why it did nothing, as the clause that follows the failure in the answer. */
function cleanupClause(repo: string, branch: string, after: Aftermath, listing: Listing): string {
  const { pending, done, yours, mergeLeft, unreadable, headHasBranch, changes } = after
  if (headHasBranch) {
    const finished = `; ${branch} is already part of HEAD of ${repo}, so the merge itself finished`
    const cut = unreadable === CHECKOUT_CUT ? `; ${CHECKOUT_CUT}` : ''
    return changes.length === 0 ? `${finished}${cut}` : `${finished}; nothing was reset${hasChanges(repo)(changes)}${cut}`
  }
  if (unreadable !== null) {
    const read = changes.length > 0 ? `; what it read: ${pathList(changes.map((change) => change.path))}` : ''
    return `; ${pending ? 'the merge was not aborted' : 'nothing was reset'}, because ${unreadable}${read}${byHandClause(repo, pending)}`
  }
  if (yours.length > 0) {
    const one = yours.length === 1
    const own = `${pathList(yours)} ${one ? 'is probably a change' : 'are probably changes'} of your own, and the merge does not touch ${one ? 'it' : 'them'}`
    const rest = changes.map((change) => change.path).filter((path) => !yours.includes(path))
    const others = rest.length > 0 ? `; the rest of what changed: ${pathList(rest)}` : ''
    if (!mergeLeft) return `; ${own}, so nothing was reset${others}`
    return `; ${pending ? 'the merge was not aborted' : 'nothing was reset'}, because ${own}${others}${byHandClause(repo, pending)}`
  }
  if (done === 'aborted') return `; the merge was aborted${listing(changes)}`
  if (done === 'reset') return `; the half-made merge was undone with git reset --merge${listing(changes)}`
  return listing(changes)
}

type Merging = { repo: string; branch: string; strategy: IntegrateStrategy; gitHooks: IntegrateGitHooks; merge: MergePaths }

async function failedMerge(run: Git, { repo, branch, strategy, gitHooks, merge }: Merging, merged: Attempt): Promise<IntegrateOutcome> {
  let after: Aftermath
  try {
    after = await cleanUp(run, repo, branch, 'unfinished' in merged, merge)
  } catch (err) {
    const ended = 'unfinished' in merged ? 'did not finish' : 'failed'
    return fail('git_failed', `git merge of ${branch} into ${repo} ${ended}, and ${reasonOf(err)}; ${repo} may still be mid-merge`)
  }
  if ('unfinished' in merged) {
    return fail('git_failed', `git merge ${branch} into ${repo} did not finish: ${merged.unfinished}${cleanupClause(repo, branch, after, hasChanges(repo))}`)
  }
  const { result } = merged
  if (after.conflicted.length > 0) {
    const clause = cleanupClause(repo, branch, after, keptBy(repo, 'the merge'))
    return fail('merge_conflict', `${branch} conflicts with ${repo} in ${after.conflicted.length} file(s)${clause}`, after.conflicted)
  }
  if (gitHooks === 'run' && (after.pending || GIT_NAMES_A_HOOK.test(result.stderr))) {
    const output = hookOutput(result.stdout, result.stderr)
    const refused = `a git hook refused the merge of ${branch} into ${repo}${cleanupClause(repo, branch, after, keptBy(repo, 'the hook'))}`
    const said = output === '' ? "The checkout's hook printed nothing." : `Output of the checkout's hook:\n${output}`
    return fail('hook_failed', `${refused}. A hook has to pass before the task can merge: fix what it checks, then integrate again.\n${said}`)
  }
  const code = strategy === 'ff-only' ? 'not_fast_forward' : 'git_failed'
  return fail(code, `git merge ${branch} into ${repo} failed${gitDetail(result.stderr)}${cleanupClause(repo, branch, after, keptBy(repo, 'the merge'))}`)
}

/**
 * Merge a finished task's branch into the checkout it was launched from. Every git call is an explicit
 * argv in the destination, with no force. A job still running on the branch or in the task's worktree refuses
 * the merge before git runs. A merge that fails or is killed for outliving git's timeout is undone only when every
 * changed tracked path is one that the merge touches, and the answer lists what stays in the checkout. The worktree stays.
 *
 * `gitHooks` says whether `$` runs the checkout's hooks as they are, which only an engine that keeps them on can do.
 * With `run`, a merge that a hook refuses is aborted too, and answers hook_failed.
 */
export async function integrate($: CoreEngine, jobsDir: string, input: IntegrateInput, gitHooks: IntegrateGitHooks = 'off'): Promise<IntegrateOutcome> {
  const run: Git = (argv) => $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS })
  try {
    const job = await readMeta($, jobsDir, input.taskId)
    if (job === null) return fail('task_not_found', `no task ${input.taskId}`)
    const repo = job.repo
    const branch = job.branch
    const worktree = job.worktree
    if (repo === undefined || branch === undefined || worktree === undefined) {
      return fail('no_worktree', `task ${job.id} ran without a worktree, so it has no branch to merge`)
    }

    const running = await liveJobOn($, jobsDir, job, branch, worktree)
    if (running !== null) {
      return fail('task_running', `task ${running} is still running on ${branch}, or in its worktree ${worktree}; wait for it to finish, or cancel it, then integrate again`)
    }

    const status = await run(statusArgv(repo))
    if (status.exitCode !== 0) {
      return fail('not_a_repository', `${repo} is not a git checkout${gitDetail(status.stderr)}`)
    }
    if (outputLines(status.stdout).length > 0) {
      return fail('dirty_worktree', `${repo} has uncommitted or untracked changes; commit or stash them, then integrate again`)
    }

    const ancestor = await run(isAncestorArgv(repo, branch))
    if (ancestor.exitCode === 0) return fail('already_integrated', `${branch} is already reachable from HEAD of ${repo}`)
    if (ancestor.exitCode !== 1) return fail('git_failed', `git could not compare ${branch} with HEAD${gitDetail(ancestor.stderr)}`)

    const listed = await run(mergePathsArgv(repo, branch))
    if (listed.exitCode !== 0) return fail('git_failed', `git could not list the files that ${branch} changes in ${repo}${gitDetail(listed.stderr)}`)
    const merge = readMergePaths(listed)

    const merged = await attempt(run, mergeArgv(repo, branch, input.strategy))
    if (!('result' in merged) || merged.result.exitCode !== 0) {
      return await failedMerge(run, { repo, branch, strategy: input.strategy, gitHooks, merge }, merged)
    }

    const head = await run(revParseHeadArgv(repo))
    const mergedSha = head.stdout.trim()
    if (head.exitCode !== 0 || mergedSha === '') return fail('git_failed', `merged, but git could not read the new HEAD of ${repo}`)
    return { integrated: { taskId: job.id, mergedSha, branch, worktree } }
  } catch (err) {
    return fail('git_failed', `git could not run: ${String(err)}`)
  }
}

/** What the model reads for one outcome: `{ ok: true, ... }` for a merge, `{ ok: false, error }` for a refusal. */
export type IntegratePayload = ({ ok: true } & Integrated) | { ok: false; error: GitFailure }

export function integratePayload(outcome: IntegrateOutcome): IntegratePayload {
  return 'failure' in outcome ? { ok: false, error: outcome.failure } : { ok: true, ...outcome.integrated }
}
