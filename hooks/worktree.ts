import type { IntegrateStrategy } from './contract.ts'
import { isSafeJobId } from './types.ts'

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

/**
 * A task id names a branch and a directory, so it must be a job id and must not end in a dot or
 * `.lock`, which git refuses in a ref name.
 */
export function isSafeTaskId(id: string): boolean {
  return isSafeJobId(id) && !/\.(lock)?$/.test(id)
}

/** The non-empty lines of a git list output, kept as git wrote them. */
export function outputLines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '')
}
