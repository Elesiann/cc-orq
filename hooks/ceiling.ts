// The permission ceiling: the lower, on each axis, of what the config's `ceiling` allows and what the session's
// permission mode allows. The cc-orq:task agent and the delegate tool both decide a request here.

import {
  INTERACTION_MODES,
  RUNTIME_MODES,
  fail,
  type Failure,
  type InteractionMode,
  type RuntimeMode,
  type TaskIsolation,
} from './contract.ts'
import { interactionModeRank, parentRuntimeModeFromPermissionMode, runtimeModeRank } from './target.ts'
import { isRecord } from './types.ts'

export type Ceiling = { runtimeMode: RuntimeMode; interactionMode: InteractionMode }

export type CeilingField = 'runtime' | 'sharedRuntime' | 'interaction'

/** The `ceiling` of the orq config once parsed. A field whose value was not valid is listed in `invalid` and holds the narrowest mode. */
export type CeilingConfig = {
  /** The most a task in its own worktree may run as. */
  runtime: RuntimeMode
  /** The most a task that runs in the checkout itself may run as. */
  sharedRuntime: RuntimeMode
  interaction: InteractionMode
  invalid: CeilingField[]
}

type CeilingLimits = Omit<CeilingConfig, 'invalid'>

const CEILING_FIELDS: readonly CeilingField[] = ['runtime', 'sharedRuntime', 'interaction']
const DEFAULTS: CeilingLimits = { runtime: 'auto-accept-edits', sharedRuntime: 'approval-required', interaction: 'default' }
const NARROWEST: CeilingLimits = { runtime: 'approval-required', sharedRuntime: 'approval-required', interaction: 'plan' }

const CONFIG_FILE = '~/.config/orq/config.json'

export function defaultCeilingConfig(): CeilingConfig {
  return { ...DEFAULTS, invalid: [] }
}

function invalidWarning(field: CeilingField): string {
  const choices = field === 'interaction' ? INTERACTION_MODES : RUNTIME_MODES
  return `ceiling.${field} must be one of ${choices.join(', ')}; it counts as ${NARROWEST[field]}`
}

/** Reads the `ceiling` value of the config file. An absent value is the defaults; anything invalid fails closed and is named. */
export function parseCeilingConfig(raw: unknown): { ceiling: CeilingConfig; warnings: string[] } {
  if (raw === undefined) return { ceiling: defaultCeilingConfig(), warnings: [] }
  if (!isRecord(raw)) {
    const narrowest = CEILING_FIELDS.map((field) => `${field} ${NARROWEST[field]}`).join(', ')
    return {
      ceiling: { ...NARROWEST, invalid: [...CEILING_FIELDS] },
      warnings: [`ceiling must be an object such as {"runtime": "auto"}; every field counts as its narrowest value (${narrowest})`],
    }
  }
  const ceiling = defaultCeilingConfig()
  const warnings: string[] = []
  for (const key of Object.keys(raw)) {
    if (!CEILING_FIELDS.some((field) => field === key)) {
      warnings.push(`ceiling.${key} is not a ceiling field (${CEILING_FIELDS.join(', ')}), ignored`)
    }
  }
  const reject = (field: CeilingField): void => {
    ceiling.invalid.push(field)
    warnings.push(invalidWarning(field))
  }
  for (const field of CEILING_FIELDS) {
    const value = raw[field]
    if (value === undefined) continue
    if (field === 'interaction') {
      const mode = INTERACTION_MODES.find((candidate) => candidate === value)
      if (mode === undefined) {
        ceiling.interaction = NARROWEST.interaction
        reject(field)
      } else {
        ceiling.interaction = mode
      }
    } else {
      const mode = RUNTIME_MODES.find((candidate) => candidate === value)
      if (mode === undefined) {
        ceiling[field] = NARROWEST[field]
        reject(field)
      } else {
        ceiling[field] = mode
      }
    }
  }
  return { ceiling, warnings }
}

/** What the session's permission mode limits a task to; null when no mode reached orq, and then only the config limits. */
export function sessionCeiling(sessionMode: string | undefined): Ceiling | null {
  return sessionMode === undefined ? null : parentRuntimeModeFromPermissionMode(sessionMode)
}

export function configCeiling(config: CeilingConfig, isolation: TaskIsolation): Ceiling {
  return { runtimeMode: isolation === 'shared' ? config.sharedRuntime : config.runtime, interactionMode: config.interaction }
}

export function lowerCeiling(a: Ceiling, b: Ceiling): Ceiling {
  return {
    runtimeMode: runtimeModeRank(a.runtimeMode) <= runtimeModeRank(b.runtimeMode) ? a.runtimeMode : b.runtimeMode,
    interactionMode: interactionModeRank(a.interactionMode) <= interactionModeRank(b.interactionMode) ? a.interactionMode : b.interactionMode,
  }
}

export function effectiveCeiling(config: CeilingConfig, session: Ceiling | null, isolation: TaskIsolation): Ceiling {
  const limit = configCeiling(config, isolation)
  return session === null ? limit : lowerCeiling(limit, session)
}

/** What a task asks for; a mode left out inherits the effective ceiling. */
export type CeilingRequest = { runtimeMode?: RuntimeMode; interactionMode?: InteractionMode }

export type CeilingDecision = {
  effective: Ceiling
  /** Why the request cannot run, as the typed failure the caller answers; null when it is within the ceiling. */
  refusal: Failure | null
}

type Axis<Mode extends string> = {
  code: 'runtime_mode_escalation_denied' | 'interaction_mode_escalation_denied'
  label: string
  field: string
  rank: (mode: Mode) => number
}

/** The session's mode can be the lower limit, and then the config alone cannot lift it, so the refusal names each limit in the way. */
function refuseAbove<Mode extends string>(axis: Axis<Mode>, asked: Mode, limits: { config: Mode; session: Mode | null; effective: Mode }): Failure {
  const steps = [
    ...(axis.rank(limits.config) < axis.rank(asked) ? [`raise ceiling.${axis.field} in ${CONFIG_FILE}`] : []),
    ...(limits.session !== null && axis.rank(limits.session) < axis.rank(asked) ? ['use a session permission mode that allows it'] : []),
  ]
  const session = limits.session === null ? '' : ` and the session's permission mode allows ${limits.session}`
  return fail(
    axis.code,
    `${axis.label} ${asked} is above the ceiling ${limits.effective} for this task: the config allows ${limits.config} (ceiling.${axis.field})${session}. ` +
      `To allow ${asked}, ${steps.join(' and ')}; otherwise ask for ${limits.effective} at most.`,
  )
}

const RUNTIME_AXIS = { code: 'runtime_mode_escalation_denied', label: 'Runtime mode', rank: runtimeModeRank } as const
const INTERACTION_AXIS = { code: 'interaction_mode_escalation_denied', label: 'Interaction mode', field: 'interaction', rank: interactionModeRank } as const

/** The effective ceiling of a task, and the refusal when its request is above it. The runtime mode is judged first, as the launch judges it. */
export function resolveCeiling(input: {
  config: CeilingConfig
  /** What the session's permission mode limits to; null when none reached orq. */
  session: Ceiling | null
  isolation: TaskIsolation
  request: CeilingRequest
}): CeilingDecision {
  const { config, session, isolation, request } = input
  const fromConfig = configCeiling(config, isolation)
  const effective = session === null ? fromConfig : lowerCeiling(fromConfig, session)
  const { runtimeMode, interactionMode } = request
  if (runtimeMode !== undefined && runtimeModeRank(runtimeMode) > runtimeModeRank(effective.runtimeMode)) {
    const axis = { ...RUNTIME_AXIS, field: isolation === 'shared' ? 'sharedRuntime' : 'runtime' }
    const limits = { config: fromConfig.runtimeMode, session: session?.runtimeMode ?? null, effective: effective.runtimeMode }
    return { effective, refusal: refuseAbove(axis, runtimeMode, limits) }
  }
  if (interactionMode !== undefined && interactionModeRank(interactionMode) > interactionModeRank(effective.interactionMode)) {
    const limits = { config: fromConfig.interactionMode, session: session?.interactionMode ?? null, effective: effective.interactionMode }
    return { effective, refusal: refuseAbove(INTERACTION_AXIS, interactionMode, limits) }
  }
  return { effective, refusal: null }
}

/** What `capabilities` tells the model about the ceiling. `effective` has one entry per isolation, since the config limits them apart. */
export type CeilingReport = {
  config: CeilingLimits
  session: (Ceiling & { mode: string }) | null
  effective: Record<TaskIsolation, Ceiling>
  warnings?: string[]
}

export function describeCeiling(config: CeilingConfig, sessionMode: string | undefined): CeilingReport {
  const session = sessionMode === undefined ? null : { mode: sessionMode, ...parentRuntimeModeFromPermissionMode(sessionMode) }
  const report: CeilingReport = {
    config: { runtime: config.runtime, sharedRuntime: config.sharedRuntime, interaction: config.interaction },
    session,
    effective: { worktree: effectiveCeiling(config, session, 'worktree'), shared: effectiveCeiling(config, session, 'shared') },
  }
  if (config.invalid.length > 0) report.warnings = config.invalid.map(invalidWarning)
  return report
}
