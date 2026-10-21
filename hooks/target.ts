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
import { QUESTION_PROTOCOL } from './question.ts'

export type ResolveTargetInput = {
  target: Target
  instances: readonly InstanceConfig[]
  parentRuntimeMode: RuntimeMode
  parentInteractionMode: InteractionMode
  runtimeMode?: 'inherit' | RuntimeMode
  interactionMode?: 'inherit' | InteractionMode
}

export type RunnerPolicy = { flags: string[] }

export function hasControlCharacters(text: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(text)
}

/** A model name the runner receives as one argv item: no leading "-", no control characters. */
export function plainArgument(text: string): boolean {
  return !text.startsWith('-') && !hasControlCharacters(text)
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

/**
 * The runtime modes each driver's flags enforce. A mode outside this list has no flag that narrows the
 * CLI to it, so a child on that driver would run with the CLI's own defaults, which may be broader.
 */
export const SUPPORTED_RUNTIME_MODES: Record<DriverKind, readonly RuntimeMode[]> = {
  codex: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'],
  opencode: ['approval-required', 'auto'],
  antigravity: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'],
  claudeAgent: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'],
}

/** The runner flags a driver needs to enforce one runtime and interaction mode, or a refusal when it cannot. */
export function runnerPolicy(driver: DriverKind, runtimeMode: RuntimeMode, interactionMode: InteractionMode): RunnerPolicy | Failure {
  const supported = SUPPORTED_RUNTIME_MODES[driver]
  if (!supported.includes(runtimeMode)) {
    return fail(
      'runtime_mode_unsupported',
      `Driver ${driver} cannot enforce runtime mode ${runtimeMode}; it supports ${supported.join(', ')}.`,
    )
  }
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
      }
    }
    case 'opencode':
      // The table above leaves approval-required and auto; plan interaction narrows auto to the plan agent.
      return runtimeMode === 'auto' && interactionMode === 'default' ? { flags: ['--auto'] } : { flags: ['--agent', 'plan'] }
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
          return { flags: ['--permission-mode', 'manual'] }
        case 'auto-accept-edits':
          return { flags: ['--permission-mode', 'acceptEdits'] }
        case 'auto':
          return { flags: ['--permission-mode', 'auto'] }
        case 'full-access':
          return { flags: ['--permission-mode', 'bypassPermissions'] }
      }
    }
  }
}

/** The effort the driver passes to its CLI, so the job can record it; undefined when effortFlag passes none. */
export function appliedEffort(driver: DriverKind, options: readonly OptionSelection[]): string | undefined {
  if (effortFlag(driver, options).length === 0) return undefined
  const effort = options.find((selection) => selection.id === EFFORT_OPTION)?.value
  return typeof effort === 'string' ? effort : undefined
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

/** The prompt a task job runs: the role line when a role is given, the task, then the question protocol. */
export function taskPrompt(task: string, role: TaskRole | undefined): string {
  const body = role === undefined || role === 'general' ? task : `Act as the ${role} sub-agent for this task.\n\n${task}`
  return `${body}\n\n${QUESTION_PROTOCOL}`
}
