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

type Aftermath = {
  conflicted: string[]
  abortedMerge: boolean
  headHasBranch: boolean
  leftBehind: string[]
}

async function branchIsInHead(run: Git, repo: string, branch: string): Promise<boolean> {
  const compared = await run(isAncestorArgv(repo, branch))
  if (compared.exitCode !== 0 && compared.exitCode !== 1) throw new Error(`git merge-base --is-ancestor failed${gitDetail(compared.stderr)}`)
  return compared.exitCode === 0
}

/**
 * Aborts a pending merge, then reads what stays in the checkout. The unmerged files are read before any abort, since
 * merge --abort clears them from the index. git 2.43 runs pre-merge-commit before it writes MERGE_HEAD, so a git killed
 * there leaves the merge in the index with no merge pending. Nothing resets that: its changes cannot be told from the
 * ones the user made while the hook ran, so the answer lists them.
 */
async function cleanUp(run: Git, repo: string, branch: string, killed: boolean): Promise<Aftermath> {
  const conflicted = outputLines((await run(unmergedFilesArgv(repo))).stdout)
  const pending = (await run(mergeHeadArgv(repo))).exitCode === 0
  if (pending) await must(run, mergeAbortArgv(repo), 'git merge --abort')
  const headHasBranch = killed && !pending && (await branchIsInHead(run, repo, branch))
  const leftBehind = outputLines((await must(run, statusArgv(repo), 'git status')).stdout)
  return { conflicted, abortedMerge: pending, headHasBranch, leftBehind }
}

function pathList(leftBehind: string[]): string {
  const paths = leftBehind.slice(0, LEFT_PATHS_LISTED).map((line) => line.slice(3))
  const more = leftBehind.length > LEFT_PATHS_LISTED ? `, and ${leftBehind.length - LEFT_PATHS_LISTED} more` : ''
  return `${paths.join(', ')}${more}`
}

function keptClause(repo: string, madeBy: string, leftBehind: string[]): string {
  return leftBehind.length === 0 ? '' : `; ${repo} keeps changes ${madeBy} made: ${pathList(leftBehind)}`
}

function killedClause(repo: string, branch: string, { abortedMerge, headHasBranch, leftBehind }: Aftermath): string {
  const aborted = abortedMerge ? '; the merge was aborted' : ''
  const finished = headHasBranch ? `; ${branch} is already part of HEAD of ${repo}, so the merge itself finished` : ''
  if (leftBehind.length === 0) return `${aborted}${finished}`
  const safe = abortedMerge ? '' : '; nothing was reset, so changes of your own are safe'
  const manual =
    abortedMerge || headHasBranch
      ? ''
      : `. If the merge left them, check them with git status, then run git reset --merge in ${repo} to drop what it staged (untracked files stay, and staged changes of your own go with it)`
  return `${aborted}${finished}${safe}; ${repo} has changes: ${pathList(leftBehind)}${manual}`
}

type Merging = { repo: string; branch: string; strategy: IntegrateStrategy; gitHooks: IntegrateGitHooks }

async function failedMerge(run: Git, { repo, branch, strategy, gitHooks }: Merging, merged: Attempt): Promise<IntegrateOutcome> {
  let after: Aftermath
  try {
    after = await cleanUp(run, repo, branch, 'unfinished' in merged)
  } catch (err) {
    const ended = 'unfinished' in merged ? 'did not finish' : 'failed'
    return fail('git_failed', `git merge of ${branch} into ${repo} ${ended}, and ${reasonOf(err)}; ${repo} may still be mid-merge`)
  }
  if ('unfinished' in merged) {
    return fail('git_failed', `git merge ${branch} into ${repo} did not finish: ${merged.unfinished}${killedClause(repo, branch, after)}`)
  }
  const { conflicted, abortedMerge, leftBehind } = after
  const aborted = abortedMerge ? '; the merge was aborted' : ''
  const { result } = merged
  if (conflicted.length > 0) {
    const kept = keptClause(repo, 'the merge', leftBehind)
    return fail('merge_conflict', `${branch} conflicts with ${repo} in ${conflicted.length} file(s); the merge was aborted${kept}`, conflicted)
  }
  if (gitHooks === 'run' && (abortedMerge || GIT_NAMES_A_HOOK.test(result.stderr))) {
    const output = hookOutput(result.stdout, result.stderr)
    const refused = `a git hook refused the merge of ${branch} into ${repo}${aborted}${keptClause(repo, 'the hook', leftBehind)}`
    const said = output === '' ? "The checkout's hook printed nothing." : `Output of the checkout's hook:\n${output}`
    return fail('hook_failed', `${refused}. A hook has to pass before the task can merge: fix what it checks, then integrate again.\n${said}`)
  }
  const code = strategy === 'ff-only' ? 'not_fast_forward' : 'git_failed'
  return fail(code, `git merge ${branch} into ${repo} failed${gitDetail(result.stderr)}${aborted}${keptClause(repo, 'the merge', leftBehind)}`)
}

/**
 * Merge a finished task's branch into the checkout it was launched from. Every git call is an explicit
 * argv in the destination, with no force. A job still running on the branch or in the task's worktree refuses
 * the merge before git runs. A merge that fails has its pending merge aborted, and the answer lists what stays in
 * the checkout. A merge killed for outliving git's timeout with none pending resets nothing. The worktree stays.
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

    const merged = await attempt(run, mergeArgv(repo, branch, input.strategy))
    if (!('result' in merged) || merged.result.exitCode !== 0) {
      return await failedMerge(run, { repo, branch, strategy: input.strategy, gitHooks }, merged)
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
