import type { EngineInterface, On } from 'claude-code'

import { loadConfig } from './config.ts'
import { readMeta, type Engine } from './engine.ts'
import {
  INTEGRATE_DESCRIPTION,
  INTEGRATE_INPUT_SCHEMA,
  INTEGRATE_STRATEGIES,
  INTEGRATE_TOOL,
  INTEGRATE_TOOL_NAME,
  type Failure,
  type IntegrateInput,
  type IntegrateStrategy,
  type Integrated,
} from './contract.ts'
import { isRecord } from './types.ts'
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

export type IntegrateOutcome = { integrated: Integrated } | { failure: Failure }

function fail(code: Failure['code'], message: string, files?: string[]): { failure: Failure } {
  return { failure: files === undefined ? { code, message } : { code, message, files } }
}

function isStrategy(value: unknown): value is IntegrateStrategy {
  return INTEGRATE_STRATEGIES.some((s) => s === value)
}

/** The tool input as the model sent it: a job id, and a strategy that defaults to ff-only. */
export function parseIntegrateInput(raw: unknown): { input: IntegrateInput } | { failure: Failure } {
  if (!isRecord(raw) || typeof raw.taskId !== 'string' || raw.taskId === '') {
    return fail('invalid_input', 'taskId must be the job id of the finished task')
  }
  const strategy = raw.strategy ?? 'ff-only'
  if (!isStrategy(strategy)) return fail('invalid_input', `strategy must be one of ${INTEGRATE_STRATEGIES.join(', ')}`)
  return { input: { taskId: raw.taskId, strategy } }
}

/**
 * Merge a finished task's branch into the checkout it was launched from. Every git call is an explicit
 * argv in the destination, with no force. A conflict is listed, then aborted; the worktree stays.
 */
export async function integrate($: Engine, jobsDir: string, input: IntegrateInput): Promise<IntegrateOutcome> {
  const run = (argv: string[]) => $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS })
  try {
    const job = await readMeta($, jobsDir, input.taskId)
    if (job === null) return fail('task_not_found', `no task ${input.taskId}`)
    const repo = job.repo
    const branch = job.branch
    const worktree = job.worktree
    if (repo === undefined || branch === undefined || worktree === undefined) {
      return fail('no_worktree', `task ${job.id} ran without a worktree, so it has no branch to merge`)
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

    const merged = await run(mergeArgv(repo, branch, input.strategy))
    if (merged.exitCode !== 0) {
      // The unmerged files are read before any abort, since merge --abort clears them from the index.
      const files = outputLines((await run(unmergedFilesArgv(repo))).stdout)
      const pending = (await run(mergeHeadArgv(repo))).exitCode === 0
      if (pending) {
        const abort = await run(mergeAbortArgv(repo))
        if (abort.exitCode !== 0) {
          return fail('git_failed', `git merge of ${branch} into ${repo} failed, and git merge --abort failed; ${repo} may still be mid-merge${gitDetail(abort.stderr)}`)
        }
      }
      if (files.length > 0) {
        return fail('merge_conflict', `${branch} conflicts with ${repo} in ${files.length} file(s); the merge was aborted`, files)
      }
      const code = input.strategy === 'ff-only' ? 'not_fast_forward' : 'git_failed'
      const aborted = pending ? '; the merge was aborted' : ''
      return fail(code, `git merge ${branch} into ${repo} failed${gitDetail(merged.stderr)}${aborted}`)
    }

    const head = await run(revParseHeadArgv(repo))
    const mergedSha = head.stdout.trim()
    if (head.exitCode !== 0 || mergedSha === '') return fail('git_failed', `merged, but git could not read the new HEAD of ${repo}`)
    return { integrated: { taskId: job.id, mergedSha, branch, worktree } }
  } catch (err) {
    return fail('git_failed', `git could not run: ${String(err)}`)
  }
}

/**
 * The answer the model reads: the payload as one JSON string. A plugin tool answers with a string
 * result; an MCP-shaped object is read as invalid input by the model.
 */
function answer(outcome: IntegrateOutcome) {
  const payload = 'failure' in outcome ? { ok: false, error: outcome.failure } : { ok: true, ...outcome.integrated }
  return { result: JSON.stringify(payload) }
}

/** Declare the integrate tool; called from session.start, since a tool registers before the first prompt. */
export async function declareIntegrateTool($: Pick<EngineInterface, 'tool'>): Promise<void> {
  await $.tool.register({ name: INTEGRATE_TOOL, description: INTEGRATE_DESCRIPTION, inputSchema: INTEGRATE_INPUT_SCHEMA })
}

/** Serve mcp__orq__integrate. */
export function registerIntegrate(on: On): void {
  on('tool.call', { tool: INTEGRATE_TOOL_NAME }, async ($, e) => {
    try {
      const parsed = parseIntegrateInput(e)
      if ('failure' in parsed) return answer({ failure: parsed.failure })
      const { config } = await loadConfig($)
      return answer(await integrate($, config.jobsDir, parsed.input))
    } catch (err) {
      return { deny: `orq: ${INTEGRATE_TOOL_NAME} failed: ${String(err)}` }
    }
  })
}
