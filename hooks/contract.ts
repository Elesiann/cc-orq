// Shapes from T3 Code's orchestrator contract (MIT), reduced to what orq:task uses. Thread,
// scheduling and context-transfer fields are left out. The driver list lives in config.ts.

import type { DriverKind, InstanceConfig } from './config.ts'

export type { DriverKind } from './config.ts'

export type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'
export type InteractionMode = 'default' | 'plan'
export type TaskRole = 'implementation' | 'research' | 'review' | 'design' | 'test' | 'general'
export type TaskIsolation = 'worktree' | 'shared'

export const RUNTIME_MODES: readonly RuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
export const INTERACTION_MODES: readonly InteractionMode[] = ['default', 'plan']

export type OptionValue = string | boolean
export type OptionSelection = { id: string; value: OptionValue }

/** The reasoning-effort option id T3 advertises across drivers. */
export const EFFORT_OPTION = 'reasoningEffort'

/** What a task header names: a configured instance and the model it runs. */
export type Target = {
  providerInstanceId: string
  model: string
  options?: OptionSelection[]
}

/** A target after resolution: what the runner launches. */
export type ResolvedTarget = {
  instance: InstanceConfig
  model: string
  options: OptionSelection[]
  runtimeMode: RuntimeMode
  interactionMode: InteractionMode
}

export type FailureCode =
  | 'provider_unavailable'
  | 'runtime_mode_escalation_denied'
  | 'interaction_mode_escalation_denied'
  | 'invalid_request'
  | 'runtime_mode_unsupported'
  | 'cwd_out_of_scope'
  | 'merge_conflict'
  | 'dirty_worktree'
  | 'already_integrated'
  | 'worktree_busy'

export type Failure = { error: { code: FailureCode; message: string } }

export function fail(code: FailureCode, message: string): Failure {
  return { error: { code, message } }
}

export function isFailure(value: unknown): value is Failure {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = value.error
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error
}

/**
 * The model-facing contract of the worktree and integrate tools: the tool names, the input of
 * `integrate` and the failure codes every answer uses. A code is part of the contract, so a rename
 * is a breaking change for the instructions that name it.
 */

export const INTEGRATE_TOOL = 'integrate'
export const INTEGRATE_TOOL_NAME = `mcp__orq__${INTEGRATE_TOOL}`

export const FAILURE_CODES = [
  // The directory is not inside a git checkout, or git cannot read the checkout.
  'not_a_repository',
  // Another job without an exit file already uses the worktree path.
  'worktree_busy',
  // No meta.json for the task id.
  'task_not_found',
  // The task ran without a worktree, so it has no branch to merge.
  'no_worktree',
  // The destination checkout has uncommitted or untracked changes.
  'dirty_worktree',
  // The task branch is already reachable from HEAD.
  'already_integrated',
  // ff-only cannot move HEAD: the destination has commits the task does not have.
  'not_fast_forward',
  // The merge stopped on conflicts. It was aborted; the answer lists the files.
  'merge_conflict',
  // The tool input does not match the schema.
  'invalid_input',
  // git failed in a way no other code names.
  'git_failed',
] as const

export type IntegrateFailureCode = (typeof FAILURE_CODES)[number]

export type IntegrateFailure = { code: IntegrateFailureCode; message: string; files?: string[] }

export const INTEGRATE_STRATEGIES = ['ff-only', 'merge'] as const
export type IntegrateStrategy = (typeof INTEGRATE_STRATEGIES)[number]

export type IntegrateInput = { taskId: string; strategy: IntegrateStrategy }

export type Integrated = { taskId: string; mergedSha: string; branch: string; worktree: string }

export const INTEGRATE_DESCRIPTION =
  "Merges a finished task's branch into the checkout the task was launched from. The default strategy " +
  'ff-only moves HEAD without a merge commit; merge makes one. A conflict is aborted and its files are ' +
  'listed: redelegate a rebase to the same worker, then integrate again. The task worktree stays in place, ' +
  'and orq never forces a merge.'

export const INTEGRATE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'The job id of the finished task.' },
    strategy: {
      type: 'string',
      enum: [...INTEGRATE_STRATEGIES],
      description: 'ff-only (the default) or merge.',
    },
  },
  required: ['taskId'],
}
