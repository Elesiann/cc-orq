import { expect, test } from 'claude-code/testing'

import type { InstanceConfig } from '../hooks/config.ts'
import { isFailure, type DriverKind, type InteractionMode, type RuntimeMode } from '../hooks/contract.ts'
import {
  effortFlag,
  parentRuntimeModeFromPermissionMode,
  plainArgument,
  resolveInteractionMode,
  resolveRuntimeMode,
  resolveTarget,
  runnerPolicy,
  taskPrompt,
} from '../hooks/target.ts'

const INSTANCES: InstanceConfig[] = [
  { id: 'codex', driver: 'codex' },
  { id: 'codex-work', driver: 'codex', env: { CODEX_HOME: '/srv/example/codex-home' } },
  { id: 'opencode', driver: 'opencode' },
  { id: 'antigravity', driver: 'antigravity' },
  { id: 'claudeAgent', driver: 'claudeAgent' },
]

const EFFORT_HIGH = [{ id: 'reasoningEffort', value: 'high' }]

test('resolveTarget uses the named instance and model from the configuration', () => {
  const r = resolveTarget({
    target: { providerInstanceId: 'codex-work', model: 'fixture-model' },
    instances: INSTANCES,
    parentRuntimeMode: 'auto',
    parentInteractionMode: 'default',
  })
  if (isFailure(r)) throw new Error(r.error.message)
  expect(r.instance.id).toBe('codex-work')
  expect(r.instance.env).toEqual({ CODEX_HOME: '/srv/example/codex-home' })
  expect(r.model).toBe('fixture-model')
})

test('resolveTarget accepts any model string for a configured instance, since no catalog is probed', () => {
  const r = resolveTarget({
    target: { providerInstanceId: 'codex', model: 'fixture-model-unlisted' },
    instances: INSTANCES,
    parentRuntimeMode: 'approval-required',
    parentInteractionMode: 'default',
  })
  if (isFailure(r)) throw new Error(r.error.message)
  expect(r.model).toBe('fixture-model-unlisted')
})

test('resolveTarget refuses an instance that is not configured with provider_unavailable', () => {
  const r = resolveTarget({
    target: { providerInstanceId: 'nope', model: 'fixture-model' },
    instances: INSTANCES,
    parentRuntimeMode: 'auto',
    parentInteractionMode: 'default',
  })
  if (!isFailure(r)) throw new Error('expected failure')
  expect(r.error.code).toBe('provider_unavailable')
  expect(r.error.message).toBe('Provider instance nope is not configured.')
})

test('resolveTarget keeps the effort selection on the resolved target', () => {
  const r = resolveTarget({
    target: { providerInstanceId: 'codex', model: 'fixture-model', options: EFFORT_HIGH },
    instances: INSTANCES,
    parentRuntimeMode: 'auto',
    parentInteractionMode: 'default',
  })
  if (isFailure(r)) throw new Error(r.error.message)
  expect(r.options).toEqual(EFFORT_HIGH)
})

test('resolveTarget without options carries an empty selection', () => {
  const r = resolveTarget({
    target: { providerInstanceId: 'codex', model: 'fixture-model' },
    instances: INSTANCES,
    parentRuntimeMode: 'auto',
    parentInteractionMode: 'default',
  })
  if (isFailure(r)) throw new Error(r.error.message)
  expect(r.options).toEqual([])
})

test('resolveTarget fills modes from the ceiling helpers', () => {
  const r = resolveTarget({
    target: { providerInstanceId: 'codex', model: 'fixture-model' },
    instances: INSTANCES,
    parentRuntimeMode: 'auto',
    parentInteractionMode: 'default',
    runtimeMode: 'auto-accept-edits',
    interactionMode: 'inherit',
  })
  if (isFailure(r)) throw new Error(r.error.message)
  expect(r.runtimeMode).toBe('auto-accept-edits')
  expect(r.interactionMode).toBe('default')
})

test('resolveTarget inherits both parent modes when the header names none', () => {
  const r = resolveTarget({
    target: { providerInstanceId: 'codex', model: 'fixture-model' },
    instances: INSTANCES,
    parentRuntimeMode: 'approval-required',
    parentInteractionMode: 'plan',
  })
  if (isFailure(r)) throw new Error(r.error.message)
  expect(r.runtimeMode).toBe('approval-required')
  expect(r.interactionMode).toBe('plan')
})

test('resolveTarget propagates a runtime escalation refusal', () => {
  const r = resolveTarget({
    target: { providerInstanceId: 'codex', model: 'fixture-model' },
    instances: INSTANCES,
    parentRuntimeMode: 'approval-required',
    parentInteractionMode: 'default',
    runtimeMode: 'auto',
  })
  if (!isFailure(r)) throw new Error('expected failure')
  expect(r.error.code).toBe('runtime_mode_escalation_denied')
  expect(r.error.message).toBe('Child runtime mode auto is broader than parent mode approval-required.')
})

test('resolveTarget propagates an interaction escalation refusal', () => {
  const r = resolveTarget({
    target: { providerInstanceId: 'codex', model: 'fixture-model' },
    instances: INSTANCES,
    parentRuntimeMode: 'auto',
    parentInteractionMode: 'plan',
    interactionMode: 'default',
  })
  if (!isFailure(r)) throw new Error('expected failure')
  expect(r.error.code).toBe('interaction_mode_escalation_denied')
})

const RUNTIME_CASES: { parent: RuntimeMode; requested: 'inherit' | RuntimeMode | undefined; want: RuntimeMode }[] = [
  { parent: 'auto', requested: undefined, want: 'auto' },
  { parent: 'auto', requested: 'inherit', want: 'auto' },
  { parent: 'full-access', requested: 'approval-required', want: 'approval-required' },
  { parent: 'auto', requested: 'auto-accept-edits', want: 'auto-accept-edits' },
  { parent: 'approval-required', requested: 'approval-required', want: 'approval-required' },
]

for (const row of RUNTIME_CASES) {
  test(`resolveRuntimeMode keeps ${String(row.requested)} under ${row.parent}`, () => {
    expect(resolveRuntimeMode(row.parent, row.requested)).toBe(row.want)
  })
}

test('resolveRuntimeMode refuses a broader runtime with runtime_mode_escalation_denied', () => {
  const r = resolveRuntimeMode('auto-accept-edits', 'full-access')
  if (!isFailure(r)) throw new Error('expected failure')
  expect(r.error.code).toBe('runtime_mode_escalation_denied')
  expect(r.error.message).toBe('Child runtime mode full-access is broader than parent mode auto-accept-edits.')
})

test('resolveInteractionMode narrows default to plan but never widens plan to default', () => {
  expect(resolveInteractionMode('default', 'plan')).toBe('plan')
  expect(resolveInteractionMode('default', undefined)).toBe('default')
  const r = resolveInteractionMode('plan', 'default')
  if (!isFailure(r)) throw new Error('expected failure')
  expect(r.error.code).toBe('interaction_mode_escalation_denied')
  expect(r.error.message).toBe('Child interaction mode default is broader than parent mode plan.')
})

const PERMISSION_ROWS: {
  mode: string | undefined
  runtime: RuntimeMode
  interaction: InteractionMode
  why: string
}[] = [
  { mode: 'plan', runtime: 'approval-required', interaction: 'plan', why: 'planning mode runs no tools so it is the narrowest mode' },
  { mode: 'default', runtime: 'approval-required', interaction: 'default', why: 'standard behavior still prompts for dangerous operations' },
  { mode: 'acceptEdits', runtime: 'auto-accept-edits', interaction: 'default', why: 'only file edits are pre-approved' },
  { mode: 'auto', runtime: 'auto', interaction: 'default', why: 'a classifier approves or denies each prompt' },
  { mode: 'dontAsk', runtime: 'approval-required', interaction: 'default', why: 'unapproved prompts are denied, never bypassed' },
  { mode: 'bypassPermissions', runtime: 'full-access', interaction: 'default', why: 'every permission check is bypassed' },
  { mode: undefined, runtime: 'approval-required', interaction: 'default', why: 'an unknown caller gets the narrowest ceiling' },
  { mode: 'quantum', runtime: 'approval-required', interaction: 'default', why: 'an unknown caller gets the narrowest ceiling' },
  { mode: 'manual', runtime: 'approval-required', interaction: 'default', why: 'manual answers every prompt so nothing runs unapproved' },
]

for (const row of PERMISSION_ROWS) {
  test(`permission ${String(row.mode)} maps to ${row.runtime}/${row.interaction} since ${row.why}`, () => {
    expect(parentRuntimeModeFromPermissionMode(row.mode)).toEqual({
      runtimeMode: row.runtime,
      interactionMode: row.interaction,
    })
  })
}

const RUNNER_CASES: {
  driver: DriverKind
  runtime: RuntimeMode
  interaction: InteractionMode
  flags: string[]
}[] = [
  { driver: 'codex', runtime: 'approval-required', interaction: 'default', flags: ['-s', 'read-only'] },
  { driver: 'codex', runtime: 'auto-accept-edits', interaction: 'default', flags: ['-s', 'workspace-write'] },
  { driver: 'codex', runtime: 'auto', interaction: 'default', flags: ['--approve-for-me'] },
  { driver: 'codex', runtime: 'full-access', interaction: 'default', flags: ['-s', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox'] },
  { driver: 'opencode', runtime: 'approval-required', interaction: 'default', flags: ['--agent', 'plan'] },
  { driver: 'opencode', runtime: 'auto-accept-edits', interaction: 'default', flags: [] },
  { driver: 'opencode', runtime: 'auto', interaction: 'default', flags: ['--auto'] },
  { driver: 'opencode', runtime: 'auto', interaction: 'plan', flags: ['--agent', 'plan'] },
  { driver: 'antigravity', runtime: 'approval-required', interaction: 'default', flags: ['--sandbox'] },
  { driver: 'antigravity', runtime: 'auto-accept-edits', interaction: 'default', flags: ['--mode', 'accept-edits'] },
  { driver: 'antigravity', runtime: 'approval-required', interaction: 'plan', flags: ['--sandbox', '--mode', 'plan'] },
  { driver: 'antigravity', runtime: 'full-access', interaction: 'default', flags: ['--dangerously-skip-permissions'] },
  { driver: 'claudeAgent', runtime: 'approval-required', interaction: 'default', flags: [] },
  { driver: 'claudeAgent', runtime: 'auto-accept-edits', interaction: 'default', flags: ['--permission-mode', 'acceptEdits'] },
  { driver: 'claudeAgent', runtime: 'auto', interaction: 'default', flags: ['--permission-mode', 'auto'] },
  { driver: 'claudeAgent', runtime: 'full-access', interaction: 'default', flags: ['--permission-mode', 'bypassPermissions'] },
  { driver: 'claudeAgent', runtime: 'auto', interaction: 'plan', flags: ['--permission-mode', 'plan'] },
]

for (const row of RUNNER_CASES) {
  test(`runnerPolicy ${row.driver} ${row.runtime}/${row.interaction} gives ${JSON.stringify(row.flags)}`, () => {
    const r = runnerPolicy(row.driver, row.runtime, row.interaction)
    if (isFailure(r)) throw new Error(r.error.message)
    expect(r.flags).toEqual(row.flags)
  })
}

test('runnerPolicy refuses codex in plan interaction, which its exec flags cannot enforce', () => {
  const r = runnerPolicy('codex', 'auto', 'plan')
  if (!isFailure(r)) throw new Error('expected failure')
  expect(r.error.code).toBe('invalid_request')
})

test('runnerPolicy refuses opencode full-access, which its run flags cannot enforce', () => {
  const r = runnerPolicy('opencode', 'full-access', 'default')
  if (!isFailure(r)) throw new Error('expected failure')
  expect(r.error.code).toBe('invalid_request')
})

test('runnerPolicy runs antigravity auto as the narrower accept-edits, since agy has no auto-review mode', () => {
  expect(runnerPolicy('antigravity', 'auto', 'default')).toEqual({ flags: ['--mode', 'accept-edits'] })
})

test('effortFlag codex passes model_reasoning_effort through -c', () => {
  expect(effortFlag('codex', EFFORT_HIGH)).toEqual(['-c', 'model_reasoning_effort=high'])
})

test('effortFlag antigravity and claudeAgent pass the effort through --effort', () => {
  expect(effortFlag('antigravity', [{ id: 'reasoningEffort', value: 'medium' }])).toEqual(['--effort', 'medium'])
  expect(effortFlag('claudeAgent', [{ id: 'reasoningEffort', value: 'max' }])).toEqual(['--effort', 'max'])
})

test('effortFlag opencode has no flag, since its run command carries effort only inside the model name', () => {
  expect(effortFlag('opencode', EFFORT_HIGH)).toEqual([])
})

test('effortFlag returns [] without a non-empty reasoningEffort string', () => {
  expect(effortFlag('codex', [])).toEqual([])
  expect(effortFlag('codex', [{ id: 'other', value: 'high' }])).toEqual([])
  expect(effortFlag('codex', [{ id: 'reasoningEffort', value: true }])).toEqual([])
  expect(effortFlag('codex', [{ id: 'reasoningEffort', value: '' }])).toEqual([])
})

test('taskPrompt returns the bare task for general and missing roles, and names the role otherwise', () => {
  expect(taskPrompt('do it', undefined)).toBe('do it')
  expect(taskPrompt('do it', 'general')).toBe('do it')
  expect(taskPrompt('do it', 'review')).toBe('Act as the review sub-agent for this task.\n\ndo it')
  expect(taskPrompt('do it', 'implementation')).toBe('Act as the implementation sub-agent for this task.\n\ndo it')
})

test('plainArgument refuses a leading dash and control characters, and accepts a plain word', () => {
  expect(plainArgument('fixture-model')).toBe(true)
  expect(plainArgument('-x')).toBe(false)
  expect(plainArgument('a\nb')).toBe(false)
  expect(plainArgument('a\r')).toBe(false)
  expect(plainArgument('a\u0000b')).toBe(false)
  expect(plainArgument('a\u007fb')).toBe(false)
})
