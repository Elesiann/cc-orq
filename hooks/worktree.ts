import type { IntegrateStrategy } from './contract.ts'
import { redactSecrets } from './types.ts'

/** Pure planning of the git argv orq runs. No I/O here: the engine and integrate run the argv. */

export const GIT_TIMEOUT_MS = 60000

/** A git call against one checkout. The argv is explicit, so no shell reads it. */
export function gitArgv(cwd: string, ...args: string[]): string[] {
  return ['git', '-C', cwd, ...args]
}

export function revParseToplevelArgv(cwd: string): string[] {
  return gitArgv(cwd, 'rev-parse', '--show-toplevel')
}

export function revParseHeadArgv(cwd: string): string[] {
  return gitArgv(cwd, 'rev-parse', 'HEAD')
}

export function worktreeAddArgv(cwd: string, worktree: string, branch: string, baseSha: string): string[] {
  return gitArgv(cwd, 'worktree', 'add', worktree, '-b', branch, baseSha)
}

/** Undo of worktreeAddArgv, for a launch that failed after the worktree was created. */
export function worktreeRemoveArgv(cwd: string, worktree: string): string[] {
  return gitArgv(cwd, 'worktree', 'remove', '--force', worktree)
}

/** Undo of the branch worktreeAddArgv created. The branch is new and only the launch wrote to it. */
export function branchDeleteArgv(cwd: string, branch: string): string[] {
  return gitArgv(cwd, 'branch', '-D', branch)
}

export function statusArgv(cwd: string): string[] {
  return gitArgv(cwd, 'status', '--porcelain')
}

/** Exit 0 when the branch is reachable from HEAD, 1 when it is not, anything else is an error. */
export function isAncestorArgv(cwd: string, branch: string): string[] {
  return gitArgv(cwd, 'merge-base', '--is-ancestor', branch, 'HEAD')
}

export function mergeArgv(cwd: string, branch: string, strategy: IntegrateStrategy): string[] {
  return strategy === 'merge'
    ? gitArgv(cwd, 'merge', '--no-ff', '--no-edit', branch)
    : gitArgv(cwd, 'merge', '--ff-only', branch)
}

export function unmergedFilesArgv(cwd: string): string[] {
  return gitArgv(cwd, 'diff', '--name-only', '--diff-filter=U')
}

export function mergeAbortArgv(cwd: string): string[] {
  return gitArgv(cwd, 'merge', '--abort')
}

/** Exit 0 while a merge is pending in the checkout, since MERGE_HEAD exists; 1 when none is. */
export function mergeHeadArgv(cwd: string): string[] {
  return gitArgv(cwd, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')
}

/** The branch a task works on: orq/TASK_ID. */
export function branchFor(taskId: string): string {
  return `orq/${taskId}`
}

/** REPO_PARENT/REPO_NAME-wt/TASK_ID: the worktrees sit beside the checkout they came from. */
export function worktreePathFor(toplevel: string, taskId: string): string {
  const cut = toplevel.lastIndexOf('/')
  const parent = cut <= 0 ? '' : toplevel.slice(0, cut)
  const name = toplevel.slice(cut + 1)
  return `${parent}/${name}-wt/${taskId}`
}

/** One job's worktree facts as the busy check reads them from its directory. */
export type JobPlace = { id: string; cwd: string; worktree?: string; exited: boolean }

/** The id of the first job without an exit file whose cwd or worktree is `path`, or null. */
export function busyJob(jobs: readonly JobPlace[], path: string): string | null {
  const holder = jobs.find((job) => !job.exited && (job.cwd === path || job.worktree === path))
  return holder?.id ?? null
}

/** The first line of a git error, redacted and cut, so it can sit in a failure message. */
export function gitDetail(stderr: string): string {
  const line = outputLines(stderr)[0] ?? ''
  return line === '' ? '' : `: ${redactSecrets(line).slice(0, 200)}`
}

/** The non-empty lines of a git list output, kept as git wrote them. */
export function outputLines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '')
}
