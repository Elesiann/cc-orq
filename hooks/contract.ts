// Shapes from T3 Code's orchestrator contract (MIT), reduced to what orq:task uses. Thread,
// scheduling and context-transfer fields are left out. The driver list lives in config.ts.

import type { DriverKind, InstanceConfig } from './config.ts'

export type { DriverKind } from './config.ts'

export type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'
export type InteractionMode = 'default' | 'plan'
export type TaskRole = 'implementation' | 'research' | 'review' | 'design' | 'test' | 'general'
export type TaskIsolation = 'worktree' | 'shared'

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
