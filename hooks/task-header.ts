// The header a task prompt starts with: its target, working directory, and optional isolation and
// role. Header lines may come in any order; the first line that is not one starts the task text.

import {
  EFFORT_OPTION,
  fail,
  isFailure,
  type Failure,
  type InteractionMode,
  type OptionSelection,
  type RuntimeMode,
  type TaskIsolation,
  type TaskRole,
  type Target,
} from './contract.ts'
import { plainArgument } from './target.ts'

export type TaskHeader = {
  target: Target
  cwd: string
  isolation: TaskIsolation
  role?: TaskRole
  runtimeMode?: RuntimeMode
  interactionMode?: InteractionMode
  prompt: string
}

const HEADER_LINE = /^\s*(target|cwd|isolation|role)\s*:\s*(.*?)\s*$/i
const RUNTIME_MODES: readonly RuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
const INTERACTION_MODES: readonly InteractionMode[] = ['default', 'plan']
const ROLES: readonly TaskRole[] = ['implementation', 'research', 'review', 'design', 'test', 'general']
const ISOLATIONS: readonly TaskIsolation[] = ['worktree', 'shared']
const EFFORT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TARGET_FORMAT =
  'Header lines may come in any order; `target:` and `cwd:` are required. A target reads `target: <instance> <model> [effort=<value>] [runtime=<mode>] [interaction=<mode>]`.'

function oneOf<T extends string>(choices: readonly T[], text: string): T | undefined {
  return choices.find((choice) => choice === text)
}

type TargetLine = { target: Target; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode }

/** `<instance> <model> [key=value ...]`: effort, runtime and interaction are the only options a header may set. */
function parseTargetLine(text: string | undefined): TargetLine | Failure {
  if (text === undefined || text === '') return fail('invalid_request', TARGET_FORMAT)
  const words = text.split(/\s+/)
  const positional = words.filter((word) => !word.includes('='))
  if (positional.length !== 2) return fail('invalid_request', `Target "${text}" must name an instance and a model. ${TARGET_FORMAT}`)
  const providerInstanceId = positional[0] ?? ''
  const model = positional[1] ?? ''
  if (!plainArgument(model)) {
    return fail('invalid_request', 'The model must be one word that does not start with "-" and has no control characters.')
  }
  const options: OptionSelection[] = []
  const seen = new Set<string>()
  let runtimeMode: RuntimeMode | undefined
  let interactionMode: InteractionMode | undefined
  for (const pair of words.filter((word) => word.includes('='))) {
    const at = pair.indexOf('=')
    const key = pair.slice(0, at)
    const value = pair.slice(at + 1)
    if (key === '' || value === '') return fail('invalid_request', `Target option "${pair}" must be key=value.`)
    if (seen.has(key)) return fail('invalid_request', `Target option ${key} is given more than once.`)
    seen.add(key)
    if (key === 'effort') {
      if (!EFFORT_VALUE.test(value)) return fail('invalid_request', `effort must be one word, such as high, got "${value}".`)
      options.push({ id: EFFORT_OPTION, value })
    } else if (key === 'runtime') {
      const mode = oneOf(RUNTIME_MODES, value)
      if (mode === undefined) return fail('invalid_request', `runtime must be one of: ${RUNTIME_MODES.join(', ')}.`)
      runtimeMode = mode
    } else if (key === 'interaction') {
      const mode = oneOf(INTERACTION_MODES, value)
      if (mode === undefined) return fail('invalid_request', `interaction must be one of: ${INTERACTION_MODES.join(', ')}.`)
      interactionMode = mode
    } else {
      return fail('invalid_request', `Target option ${key} is not supported; use effort, runtime or interaction.`)
    }
  }
  const target: Target = options.length > 0 ? { providerInstanceId, model, options } : { providerInstanceId, model }
  return { target, runtimeMode, interactionMode }
}

/** Reads the header from the top of a task prompt. A repeated header name, a missing target or cwd, or an empty body is refused. */
export function parseTaskHeader(text: string): TaskHeader | Failure {
  const lines = text.split('\n')
  const fields = new Map<string, string>()
  let bodyStart = 0
  for (; bodyStart < lines.length; bodyStart += 1) {
    const match = HEADER_LINE.exec(lines[bodyStart] ?? '')
    if (match === null) break
    const key = (match[1] ?? '').toLowerCase()
    if (fields.has(key)) return fail('invalid_request', `The ${key}: line is given more than once.`)
    fields.set(key, match[2] ?? '')
  }
  const line = parseTargetLine(fields.get('target'))
  if (isFailure(line)) return line
  const cwd = fields.get('cwd')
  if (cwd === undefined || cwd === '') return fail('invalid_request', 'The cwd: line is required and must be an absolute path.')
  if (!cwd.startsWith('/')) return fail('invalid_request', `cwd must be an absolute path, got '${cwd}'.`)
  const isolationText = fields.get('isolation')
  const isolation = isolationText === undefined ? 'worktree' : oneOf(ISOLATIONS, isolationText)
  if (isolation === undefined) return fail('invalid_request', `isolation must be one of: ${ISOLATIONS.join(', ')}.`)
  const roleText = fields.get('role')
  const role = roleText === undefined ? undefined : oneOf(ROLES, roleText)
  if (roleText !== undefined && role === undefined) return fail('invalid_request', `role must be one of: ${ROLES.join(', ')}.`)
  const prompt = lines.slice(bodyStart).join('\n').trim()
  if (prompt === '') return fail('invalid_request', 'The task text after the header is empty.')
  return {
    target: line.target,
    cwd,
    isolation,
    role,
    runtimeMode: line.runtimeMode,
    interactionMode: line.interactionMode,
    prompt,
  }
}
