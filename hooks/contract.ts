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

// What the capabilities, status and cancel tools answer, in the shapes T3 Code publishes
// (packages/contracts/src/orchestratorMcp.ts, MIT).
export type OptionChoice = { id: string; label: string; description?: string; isDefault?: boolean }
export type OptionDescriptor = {
  id: string
  label: string
  type: 'select'
  options: OptionChoice[]
  currentValue?: string
}

export type CatalogModel = { id: string; label: string | null; options?: OptionDescriptor[] }

/** One configured provider instance as the catalog probe reports it. */
export type ProviderInstance = {
  instanceId: string
  driver: DriverKind
  displayName: string | null
  enabled: boolean
  installed: boolean
  authenticated: boolean | null
  /** Why the driver cannot run now; null when it can. */
  unavailableReason: string | null
  models: CatalogModel[]
}

export type ProviderCapability = {
  providerInstanceId: string
  driverKind: DriverKind
  displayName: string | null
  models: CatalogModel[]
  canRunChildTask: boolean
  canRunCrossProviderChildTask: boolean
  constraints: string[]
}

export type CapabilitiesResult = {
  parentThreadId: null
  inheritedProviderInstanceId: null
  inheritedModel: null
  runtimeMode: RuntimeMode
  interactionMode: InteractionMode
  providers: ProviderCapability[]
  features: {
    appOwnedSubagents: true
    asyncPolling: true
    cancellation: true
    batchThreadCreation: false
    threadManagement: false
    incrementalThreadRead: false
    scheduledTasks: false
    maxBatchThreads: 0
  }
}

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type WorkState = 'working' | 'waiting_for_children' | 'result_available'

/** What `mcp__orq__status` answers for one task, read from its job directory. */
export type TaskStatusResult = {
  taskId: string
  status: TaskStatus
  workState: WorkState
  kind: string
  startedAtIso: string
  finishedAtIso?: string
  instanceId?: string
  model?: string
  /** The final answer of a completed task. */
  result?: string
  /** Why a failed or interrupted task ended. */
  error?: string
}

export type TaskCancelResult = { taskId: string; status: 'cancel_requested' }

/**
 * Every failure code an orq answer can name, refusals of orq:task and tool answers alike. A code is
 * part of the contract, so a rename is a breaking change for the instructions that name it.
 */
export const FAILURE_CODES = [
  // The named provider instance is not configured.
  'provider_unavailable',
  // The task asked for a broader runtime or interaction mode than the parent's ceiling.
  'runtime_mode_escalation_denied',
  'interaction_mode_escalation_denied',
  // The driver has no flag that enforces the resolved runtime or interaction mode.
  'runtime_mode_unsupported',
  // The input does not match the schema, or a header line is malformed.
  'invalid_request',
  // cwd resolves outside the session directory and the allowed roots.
  'cwd_out_of_scope',
  // The directory is not inside a git checkout, or git cannot read the checkout.
  'not_a_repository',
  // A shared launch into a checkout where a live job runs, or is a worktree of it. Worktree launches are never refused for it.
  'worktree_busy',
  // No meta.json for the task id.
  'task_not_found',
  // mcp__orq__cancel on a task that has ended or is interrupted.
  'task_not_cancellable',
  // The capability probe found the provider unable to run a child task.
  'capability_denied',
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
  // git failed in a way no other code names.
  'git_failed',
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

/** A typed failure in T3's shape, so the model can branch on the code. */
export type Failure = { error: { code: FailureCode; message: string } }

export function fail(code: FailureCode, message: string): Failure {
  return { error: { code, message } }
}

export function isFailure(value: unknown): value is Failure {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = value.error
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error
}

/** The failure of a worktree or integrate step; integrate answers it as `{ ok: false, error }`. */
export type GitFailure = { code: FailureCode; message: string; files?: string[] }

/** The tool names and the input of `integrate`. */
export const INTEGRATE_TOOL = 'integrate'
export const INTEGRATE_TOOL_NAME = 'mcp__orq__integrate'

export const INTEGRATE_STRATEGIES = ['ff-only', 'merge'] as const
export type IntegrateStrategy = (typeof INTEGRATE_STRATEGIES)[number]

export type IntegrateInput = { taskId: string; strategy: IntegrateStrategy }

export type Integrated = { taskId: string; mergedSha: string; branch: string; worktree: string }

export const INTEGRATE_DESCRIPTION =
  "Merges a finished task's branch into the checkout the task was launched from. Call it once the task has " +
  'finished: only its commits are merged, and uncommitted work in the task worktree is not. The default strategy ' +
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
