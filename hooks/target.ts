// Resolves a task's target against the configured instances and the parent session's modes, then
// turns the resolved target into the runner's flags. The privilege ceiling lives here: a child never
// runs broader than the session that spawned it.

import type { DriverKind, InstanceConfig } from './config.ts'
import {
  EFFORT_OPTION,
  fail,
  isFailure,
  type Failure,
  type InteractionMode,
  type OptionSelection,
  type ResolvedTarget,
  type RuntimeMode,
  type Target,
  type TaskRole,
} from './contract.ts'

export type ResolveTargetInput = {
  target: Target
  instances: readonly InstanceConfig[]
  parentRuntimeMode: RuntimeMode
  parentInteractionMode: InteractionMode
  runtimeMode?: 'inherit' | RuntimeMode
  interactionMode?: 'inherit' | InteractionMode
}

export type RunnerPolicy = { flags: string[] }

/** One argv item the runner receives unchanged: no leading "-", no control characters. */
export function plainArgument(text: string): boolean {
  return !text.startsWith('-') && !/[\u0000-\u001f\u007f]/.test(text)
}

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case 'approval-required':
      return 0
    case 'auto-accept-edits':
      return 1
    case 'auto':
      return 2
    case 'full-access':
      return 3
  }
}

function interactionModeRank(mode: InteractionMode): number {
  return mode === 'plan' ? 0 : 1
}

export function resolveRuntimeMode(parentMode: RuntimeMode, requested: 'inherit' | RuntimeMode | undefined): RuntimeMode | Failure {
  const resolved = requested === undefined || requested === 'inherit' ? parentMode : requested
  if (runtimeModeRank(resolved) > runtimeModeRank(parentMode)) {
    return fail('runtime_mode_escalation_denied', `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`)
  }
  return resolved
}

export function resolveInteractionMode(
  parentMode: InteractionMode,
  requested: 'inherit' | InteractionMode | undefined,
): InteractionMode | Failure {
  const resolved = requested === undefined || requested === 'inherit' ? parentMode : requested
  if (interactionModeRank(resolved) > interactionModeRank(parentMode)) {
    return fail('interaction_mode_escalation_denied', `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`)
  }
  return resolved
}

/** The ceiling a parent's permission mode sets for its children. Unknown modes stay restrictive. */
export function parentRuntimeModeFromPermissionMode(mode: string | undefined): {
  runtimeMode: RuntimeMode
  interactionMode: InteractionMode
} {
  switch (mode) {
    case 'plan':
      return { runtimeMode: 'approval-required', interactionMode: 'plan' }
    case 'acceptEdits':
      return { runtimeMode: 'auto-accept-edits', interactionMode: 'default' }
    case 'auto':
      return { runtimeMode: 'auto', interactionMode: 'default' }
    case 'dontAsk':
      // `dontAsk` denies anything needing approval instead of prompting, so
      // the child ceiling stays restrictive and never becomes a bypass.
      return { runtimeMode: 'approval-required', interactionMode: 'default' }
    case 'bypassPermissions':
      return { runtimeMode: 'full-access', interactionMode: 'default' }
    case 'default':
    default:
      return { runtimeMode: 'approval-required', interactionMode: 'default' }
  }
}

export function resolveTarget(input: ResolveTargetInput): ResolvedTarget | Failure {
  const instance = input.instances.find((candidate) => candidate.id === input.target.providerInstanceId)
  if (instance === undefined) {
    return fail('provider_unavailable', `Provider instance ${input.target.providerInstanceId} is not configured.`)
  }
  const runtimeMode = resolveRuntimeMode(input.parentRuntimeMode, input.runtimeMode)
  if (isFailure(runtimeMode)) return runtimeMode
  const interactionMode = resolveInteractionMode(input.parentInteractionMode, input.interactionMode)
  if (isFailure(interactionMode)) return interactionMode
  return {
    instance,
    model: input.target.model,
    options: input.target.options ?? [],
    runtimeMode,
    interactionMode,
  }
}

/** The runner flags a driver needs to enforce one runtime and interaction mode, or a refusal when it cannot. */
export function runnerPolicy(driver: DriverKind, runtimeMode: RuntimeMode, interactionMode: InteractionMode): RunnerPolicy | Failure {
  switch (driver) {
    case 'codex': {
      if (interactionMode === 'plan') return fail('invalid_request', 'Driver codex cannot enforce interaction mode plan.')
      switch (runtimeMode) {
        case 'approval-required':
          return { flags: ['-s', 'read-only'] }
        case 'auto-accept-edits':
          return { flags: ['-s', 'workspace-write'] }
        case 'auto':
          return { flags: ['--approve-for-me'] }
        case 'full-access':
          return { flags: ['-s', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox'] }
        default:
          return fail('invalid_request', `Driver codex cannot enforce runtime mode ${runtimeMode}.`)
      }
    }
    case 'opencode': {
      if (interactionMode === 'plan' || runtimeMode === 'approval-required') return { flags: ['--agent', 'plan'] }
      switch (runtimeMode) {
        case 'auto-accept-edits':
          return { flags: [] }
        case 'auto':
          return { flags: ['--auto'] }
        case 'full-access':
          return fail('invalid_request', 'Driver opencode cannot enforce runtime mode full-access.')
        default:
          return fail('invalid_request', `Driver opencode cannot enforce runtime mode ${runtimeMode}.`)
      }
    }
    case 'antigravity': {
      // agy has no classifier-reviewed mode, so auto runs as accept-edits: narrower, never broader.
      const mode: RuntimeMode = runtimeMode === 'auto' ? 'auto-accept-edits' : runtimeMode
      const flags: string[] = []
      if (mode === 'approval-required') flags.push('--sandbox')
      if (mode === 'full-access') flags.push('--dangerously-skip-permissions')
      if (interactionMode === 'plan') flags.push('--mode', 'plan')
      else if (mode === 'auto-accept-edits') flags.push('--mode', 'accept-edits')
      return { flags }
    }
    case 'claudeAgent': {
      if (interactionMode === 'plan') return { flags: ['--permission-mode', 'plan'] }
      switch (runtimeMode) {
        case 'approval-required':
          return { flags: [] }
        case 'auto-accept-edits':
          return { flags: ['--permission-mode', 'acceptEdits'] }
        case 'auto':
          return { flags: ['--permission-mode', 'auto'] }
        case 'full-access':
          return { flags: ['--permission-mode', 'bypassPermissions'] }
        default:
          return fail('invalid_request', `Driver claudeAgent cannot enforce runtime mode ${runtimeMode}.`)
      }
    }
  }
}

/** The effort flag a driver takes for the reasoning-effort selection; none when the selection is absent or empty. */
export function effortFlag(driver: DriverKind, options: readonly OptionSelection[]): string[] {
  const effort = options.find((selection) => selection.id === EFFORT_OPTION)?.value
  if (typeof effort !== 'string' || effort.length === 0) return []
  switch (driver) {
    case 'codex':
      return ['-c', `model_reasoning_effort=${effort}`]
    case 'antigravity':
    case 'claudeAgent':
      return ['--effort', effort]
    case 'opencode':
      return []
  }
}

export function taskPrompt(task: string, role: TaskRole | undefined): string {
  return role === undefined || role === 'general' ? task : `Act as the ${role} sub-agent for this task.\n\n${task}`
}
