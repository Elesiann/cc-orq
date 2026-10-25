// The permission ceiling: what the session's permission mode and the config's `ceiling` let a task run as, and what a
// request above that is refused with. The expectations are tables written out here, not computed with the module's own
// ranking, so a wrong order in the module cannot make a test agree with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultConfig, parseConfig } from '../../hooks/config.ts'
import {
  configCeiling,
  defaultCeilingConfig,
  describeCeiling,
  effectiveCeiling,
  lowerCeiling,
  parseCeilingConfig,
  resolveCeiling,
  sessionCeiling,
} from '../../hooks/ceiling.ts'
import { resolveTarget } from '../../hooks/target.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOME = '/home/test'

const RUNTIME = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] // narrowest first
const INTERACTION = ['plan', 'default'] // narrowest first
const rank = (list, mode) => list.indexOf(mode)
const lower = (list, a, b) => (rank(list, a) <= rank(list, b) ? a : b)

// What each permission mode limits a task to. `manual` is the name `claude --help` gives the prompting mode in 2.1.310.
const SESSION_MODES = {
  none: undefined,
  default: { runtime: 'approval-required', interaction: 'default' },
  manual: { runtime: 'approval-required', interaction: 'default' },
  acceptEdits: { runtime: 'auto-accept-edits', interaction: 'default' },
  auto: { runtime: 'auto', interaction: 'default' },
  bypassPermissions: { runtime: 'full-access', interaction: 'default' },
  dontAsk: { runtime: 'approval-required', interaction: 'default' },
  plan: { runtime: 'approval-required', interaction: 'plan' },
  'a forged mode': { runtime: 'approval-required', interaction: 'default' },
}
const sessionText = (name) => (name === 'none' ? undefined : name === 'a forged mode' ? 'root-please' : name)

const CONFIGS = {
  defaults: { ceiling: undefined, limits: { runtime: 'auto-accept-edits', sharedRuntime: 'approval-required', interaction: 'default' }, invalid: [] },
  'runtime: auto': { ceiling: { runtime: 'auto' }, limits: { runtime: 'auto', sharedRuntime: 'approval-required', interaction: 'default' }, invalid: [] },
  'runtime and sharedRuntime: auto': {
    ceiling: { runtime: 'auto', sharedRuntime: 'auto' },
    limits: { runtime: 'auto', sharedRuntime: 'auto', interaction: 'default' },
    invalid: [],
  },
  'full-access everywhere': {
    ceiling: { runtime: 'full-access', sharedRuntime: 'full-access', interaction: 'default' },
    limits: { runtime: 'full-access', sharedRuntime: 'full-access', interaction: 'default' },
    invalid: [],
  },
  'interaction: plan': { ceiling: { interaction: 'plan' }, limits: { runtime: 'auto-accept-edits', sharedRuntime: 'approval-required', interaction: 'plan' }, invalid: [] },
  'an invalid runtime': {
    ceiling: { runtime: 'turbo', sharedRuntime: 'auto' },
    limits: { runtime: 'approval-required', sharedRuntime: 'auto', interaction: 'default' },
    invalid: ['runtime'],
  },
  'an invalid sharedRuntime': {
    ceiling: { runtime: 'auto', sharedRuntime: 3 },
    limits: { runtime: 'auto', sharedRuntime: 'approval-required', interaction: 'default' },
    invalid: ['sharedRuntime'],
  },
  'an invalid interaction': {
    ceiling: { runtime: 'auto', interaction: 'strict' },
    limits: { runtime: 'auto', sharedRuntime: 'approval-required', interaction: 'plan' },
    invalid: ['interaction'],
  },
}

const parsed = (ceiling) => parseConfig(ceiling === undefined ? '{}' : JSON.stringify({ ceiling }), HOME).config.ceiling
const withoutInvalid = ({ invalid, ...limits }) => limits

// ---------------------------------------------------------------------------------------------------------------------
// The session's mode

for (const [name, expected] of Object.entries(SESSION_MODES)) {
  test(`${name} session mode limits a task to ${expected?.runtime ?? 'nothing'} and ${expected?.interaction ?? 'nothing'}`, () => {
    const ceiling = sessionCeiling(sessionText(name))
    if (expected === undefined) return assert.equal(ceiling, null, 'no session mode, no session limit')
    assert.deepEqual(ceiling, { runtimeMode: expected.runtime, interactionMode: expected.interaction })
  })
}

test('a mode is matched exactly: another spelling or case is not a mode, and stays narrowest', () => {
  for (const text of ['AUTO', 'Auto', ' auto', 'auto ', 'bypass', 'acceptedits', '', '__proto__', 'constructor']) {
    assert.deepEqual(sessionCeiling(text), { runtimeMode: 'approval-required', interactionMode: 'default' }, JSON.stringify(text))
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// The config's `ceiling`

test('the default ceiling lets a worktree task edit its own worktree, keeps a shared task read-only, and leaves interaction open', () => {
  assert.deepEqual(defaultCeilingConfig(), { runtime: 'auto-accept-edits', sharedRuntime: 'approval-required', interaction: 'default', invalid: [] })
  assert.deepEqual(parseCeilingConfig(undefined), { ceiling: defaultCeilingConfig(), warnings: [] })
  assert.deepEqual(defaultConfig(HOME).ceiling, defaultCeilingConfig())
  assert.notEqual(defaultConfig(HOME).ceiling, defaultConfig(HOME).ceiling, 'each config has an object of its own')
})

for (const [name, { ceiling, limits, invalid }] of Object.entries(CONFIGS)) {
  test(`a config with ${name} parses to ${JSON.stringify(limits)}`, () => {
    const config = parsed(ceiling)
    assert.deepEqual(withoutInvalid(config), limits)
    assert.deepEqual(config.invalid, invalid)
    const { warning } = parseConfig(ceiling === undefined ? '{}' : JSON.stringify({ ceiling }), HOME)
    if (invalid.length === 0) assert.equal(warning, undefined)
    else for (const field of invalid) assert.match(warning, new RegExp(`ceiling\\.${field} must be one of`), field)
  })
}

test('an invalid value counts as the narrowest mode of its axis and says so, in the warning and in the parsed config', () => {
  const { ceiling, warnings } = parseCeilingConfig({ runtime: 'root', sharedRuntime: null, interaction: 7 })
  assert.deepEqual(ceiling, { runtime: 'approval-required', sharedRuntime: 'approval-required', interaction: 'plan', invalid: ['runtime', 'sharedRuntime', 'interaction'] })
  assert.deepEqual(warnings, [
    'ceiling.runtime must be one of approval-required, auto-accept-edits, auto, full-access; it counts as approval-required',
    'ceiling.sharedRuntime must be one of approval-required, auto-accept-edits, auto, full-access; it counts as approval-required',
    'ceiling.interaction must be one of default, plan; it counts as plan',
  ])
})

test('a ceiling that is not an object puts every field at its narrowest, whatever it is', () => {
  for (const raw of [null, 'auto', 5, true, [], ['auto']]) {
    const { ceiling, warnings } = parseCeilingConfig(raw)
    assert.deepEqual(ceiling, { runtime: 'approval-required', sharedRuntime: 'approval-required', interaction: 'plan', invalid: ['runtime', 'sharedRuntime', 'interaction'] }, JSON.stringify(raw))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /^ceiling must be an object such as \{"runtime": "auto"\}; every field counts as its narrowest value/)
  }
})

test('a ceiling key that is not a field is named and ignored, and changes no limit', () => {
  const { ceiling, warnings } = parseCeilingConfig({ runtim: 'auto', runtime: 'auto' })
  assert.deepEqual(withoutInvalid(ceiling), { runtime: 'auto', sharedRuntime: 'approval-required', interaction: 'default' })
  assert.deepEqual(ceiling.invalid, [])
  assert.deepEqual(warnings, ['ceiling.runtim is not a ceiling field (runtime, sharedRuntime, interaction), ignored'])
})

test('an inherited property name in the ceiling is not a field', () => {
  const { ceiling } = parseCeilingConfig(JSON.parse('{"__proto__": {"runtime": "full-access"}, "constructor": "x"}'))
  assert.deepEqual(withoutInvalid(ceiling), { runtime: 'auto-accept-edits', sharedRuntime: 'approval-required', interaction: 'default' })
})

// ---------------------------------------------------------------------------------------------------------------------
// The effective ceiling and the request, over the whole matrix

const ISOLATIONS = ['worktree', 'shared']
const expectedLimit = (limits, isolation) => (isolation === 'shared' ? limits.sharedRuntime : limits.runtime)

for (const [sessionName, session] of Object.entries(SESSION_MODES)) {
  for (const [configName, { ceiling, limits }] of Object.entries(CONFIGS)) {
    test(`${sessionName} session and ${configName}: the effective ceiling is the lower of the two, and a request above it is refused`, () => {
      const config = parsed(ceiling)
      const sessionLimit = sessionCeiling(sessionText(sessionName))
      for (const isolation of ISOLATIONS) {
        const where = `${isolation} task`
        const configRuntime = expectedLimit(limits, isolation)
        const effectiveRuntime = session === undefined ? configRuntime : lower(RUNTIME, configRuntime, session.runtime)
        const effectiveInteraction = session === undefined ? limits.interaction : lower(INTERACTION, limits.interaction, session.interaction)
        const effective = { runtimeMode: effectiveRuntime, interactionMode: effectiveInteraction }

        assert.deepEqual(effectiveCeiling(config, sessionLimit, isolation), effective, `${where}: effective ceiling`)
        assert.deepEqual(configCeiling(config, isolation), { runtimeMode: configRuntime, interactionMode: limits.interaction }, `${where}: config ceiling`)

        // A runtime request: omitted, below, equal and above the effective ceiling. Interaction stays omitted.
        const requests = [
          ['omitted', undefined],
          ...RUNTIME.map((mode) => [rank(RUNTIME, mode) < rank(RUNTIME, effectiveRuntime) ? 'below' : mode === effectiveRuntime ? 'equal' : 'above', mode]),
        ]
        for (const [kind, runtimeMode] of requests) {
          const decision = resolveCeiling({ config, session: sessionLimit, isolation, request: { runtimeMode } })
          const label = `${where}, runtime request ${kind} ${runtimeMode ?? ''}`
          assert.deepEqual(decision.effective, effective, `${label}: the decision carries the effective ceiling`)
          if (kind === 'above') {
            assert.equal(decision.refusal?.error.code, 'runtime_mode_escalation_denied', label)
            const message = decision.refusal.error.message
            const field = isolation === 'shared' ? 'ceiling.sharedRuntime' : 'ceiling.runtime'
            assert.ok(message.startsWith(`Runtime mode ${runtimeMode} is above the ceiling ${effectiveRuntime} for this task: `), `${label}: ${message}`)
            assert.ok(message.includes(`the config allows ${configRuntime} (${field})`), `${label}: ${message}`)
            assert.equal(message.includes("the session's permission mode allows"), session !== undefined, `${label}: ${message}`)
            // The hint names each limit that stands in the way, and only those.
            const configInTheWay = rank(RUNTIME, configRuntime) < rank(RUNTIME, runtimeMode)
            const sessionInTheWay = session !== undefined && rank(RUNTIME, session.runtime) < rank(RUNTIME, runtimeMode)
            assert.equal(message.includes(`raise ${field} in ~/.config/orq/config.json`), configInTheWay, `${label}: ${message}`)
            assert.equal(message.includes('use a session permission mode that allows it'), sessionInTheWay, `${label}: ${message}`)
            assert.ok(message.endsWith(`; otherwise ask for ${effectiveRuntime} at most.`), `${label}: ${message}`)
          } else {
            assert.equal(decision.refusal, null, label)
          }
          // The launch resolves the same request against the effective ceiling, and agrees on the outcome.
          const resolved = resolveTarget({
            target: { providerInstanceId: 'codex', model: 'm' },
            instances: [{ id: 'codex', driver: 'codex' }],
            parentRuntimeMode: decision.effective.runtimeMode,
            parentInteractionMode: decision.effective.interactionMode,
            runtimeMode: runtimeMode ?? 'inherit',
            interactionMode: 'inherit',
          })
          if (kind === 'above') assert.equal(resolved.error?.code, 'runtime_mode_escalation_denied', `${label}: the launch refuses it too`)
          else assert.equal(resolved.runtimeMode, runtimeMode ?? effectiveRuntime, `${label}: an omitted runtime inherits the effective ceiling`)
        }

        // An interaction request: omitted, plan and default.
        for (const interactionMode of [undefined, 'plan', 'default']) {
          const decision = resolveCeiling({ config, session: sessionLimit, isolation, request: { interactionMode } })
          const label = `${where}, interaction request ${interactionMode ?? 'omitted'}`
          const above = interactionMode !== undefined && rank(INTERACTION, interactionMode) > rank(INTERACTION, effectiveInteraction)
          if (above) {
            assert.equal(decision.refusal?.error.code, 'interaction_mode_escalation_denied', label)
            const message = decision.refusal.error.message
            assert.ok(message.startsWith(`Interaction mode ${interactionMode} is above the ceiling ${effectiveInteraction} for this task: `), `${label}: ${message}`)
            assert.ok(message.includes(`the config allows ${limits.interaction} (ceiling.interaction)`), `${label}: ${message}`)
            assert.ok(message.endsWith(`; otherwise ask for ${effectiveInteraction} at most.`), `${label}: ${message}`)
          } else {
            assert.equal(decision.refusal, null, label)
          }
        }
      }
    })
  }
}

test('a request above both axes is refused for its runtime mode first, as the launch refuses it', () => {
  const decision = resolveCeiling({
    config: defaultCeilingConfig(),
    session: sessionCeiling('plan'),
    isolation: 'worktree',
    request: { runtimeMode: 'full-access', interactionMode: 'default' },
  })
  assert.equal(decision.refusal?.error.code, 'runtime_mode_escalation_denied')
})

test('the effective ceiling is never above the config ceiling or the session ceiling, whatever the session says', () => {
  const sessionTexts = [...Object.keys(SESSION_MODES).map(sessionText), 'bypassPermissions', 'full-access', 'root', '{"mode":"auto"}']
  for (const { ceiling } of Object.values(CONFIGS)) {
    const config = parsed(ceiling)
    for (const isolation of ISOLATIONS) {
      const alone = effectiveCeiling(config, null, isolation)
      for (const text of sessionTexts) {
        const session = sessionCeiling(text)
        const effective = effectiveCeiling(config, session, isolation)
        const label = `${isolation} task, session ${JSON.stringify(text)}`
        assert.ok(rank(RUNTIME, effective.runtimeMode) <= rank(RUNTIME, alone.runtimeMode), `${label}: runtime above the config`)
        assert.ok(rank(INTERACTION, effective.interactionMode) <= rank(INTERACTION, alone.interactionMode), `${label}: interaction above the config`)
        if (session !== null) {
          assert.ok(rank(RUNTIME, effective.runtimeMode) <= rank(RUNTIME, session.runtimeMode), `${label}: runtime above the session`)
          assert.ok(rank(INTERACTION, effective.interactionMode) <= rank(INTERACTION, session.interactionMode), `${label}: interaction above the session`)
        }
      }
    }
  }
})

test('without a session mode only the config limits, and an invalid config limits to the narrowest', () => {
  const defaults = parsed(undefined)
  assert.deepEqual(effectiveCeiling(defaults, null, 'worktree'), { runtimeMode: 'auto-accept-edits', interactionMode: 'default' })
  assert.deepEqual(effectiveCeiling(defaults, null, 'shared'), { runtimeMode: 'approval-required', interactionMode: 'default' })
  const broken = parseCeilingConfig('auto').ceiling
  for (const isolation of ISOLATIONS) {
    assert.deepEqual(effectiveCeiling(broken, null, isolation), { runtimeMode: 'approval-required', interactionMode: 'plan' })
    assert.equal(resolveCeiling({ config: broken, session: null, isolation, request: {} }).refusal, null, 'a request that names nothing is never refused')
  }
})

test('lowerCeiling takes each axis from the narrower of the two', () => {
  assert.deepEqual(
    lowerCeiling({ runtimeMode: 'auto', interactionMode: 'plan' }, { runtimeMode: 'auto-accept-edits', interactionMode: 'default' }),
    { runtimeMode: 'auto-accept-edits', interactionMode: 'plan' },
  )
  assert.deepEqual(
    lowerCeiling({ runtimeMode: 'full-access', interactionMode: 'default' }, { runtimeMode: 'full-access', interactionMode: 'default' }),
    { runtimeMode: 'full-access', interactionMode: 'default' },
  )
})

// ---------------------------------------------------------------------------------------------------------------------
// What capabilities reports

test('describeCeiling reports the config, the session with its mode, and the effective ceiling of each isolation', () => {
  assert.deepEqual(describeCeiling(parsed(undefined), undefined), {
    config: { runtime: 'auto-accept-edits', sharedRuntime: 'approval-required', interaction: 'default' },
    session: null,
    effective: {
      worktree: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
      shared: { runtimeMode: 'approval-required', interactionMode: 'default' },
    },
  })
  assert.deepEqual(describeCeiling(parsed({ runtime: 'auto', sharedRuntime: 'auto' }), 'plan'), {
    config: { runtime: 'auto', sharedRuntime: 'auto', interaction: 'default' },
    session: { mode: 'plan', runtimeMode: 'approval-required', interactionMode: 'plan' },
    effective: {
      worktree: { runtimeMode: 'approval-required', interactionMode: 'plan' },
      shared: { runtimeMode: 'approval-required', interactionMode: 'plan' },
    },
  })
  const forged = describeCeiling(parsed({ runtime: 'full-access' }), 'god-mode')
  assert.deepEqual(forged.session, { mode: 'god-mode', runtimeMode: 'approval-required', interactionMode: 'default' })
  assert.equal(forged.effective.worktree.runtimeMode, 'approval-required')
})

test('describeCeiling warns about each invalid field, and carries no warnings key when there is none', () => {
  assert.equal('warnings' in describeCeiling(parsed({ runtime: 'auto' }), 'auto'), false)
  const report = describeCeiling(parsed({ runtime: 'turbo', interaction: 'strict' }), undefined)
  assert.deepEqual(report.warnings, [
    'ceiling.runtime must be one of approval-required, auto-accept-edits, auto, full-access; it counts as approval-required',
    'ceiling.interaction must be one of default, plan; it counts as plan',
  ])
  assert.deepEqual(report.config, { runtime: 'approval-required', sharedRuntime: 'approval-required', interaction: 'plan' })
})

// ---------------------------------------------------------------------------------------------------------------------
// The hook that supplies the session's mode

test('hooks.json runs the session-mode hook before delegate, answer and capabilities, and decides nothing itself', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))
  assert.deepEqual(Object.keys(hooks.hooks), ['PreToolUse'])
  const [entry, ...rest] = hooks.hooks.PreToolUse
  assert.equal(rest.length, 0)
  assert.equal(entry.matcher, 'mcp__plugin_cc-orq_orq__(delegate|answer|capabilities)')
  assert.deepEqual(entry.hooks.map((hook) => hook.type), ['command'])
  assert.equal(entry.hooks[0].command, 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/session-mode-hook.sh"')
  assert.ok(entry.hooks[0].timeout <= 10)
  const matcher = new RegExp(`^(?:${entry.matcher})$`)
  for (const tool of ['delegate', 'answer', 'capabilities']) assert.ok(matcher.test(`mcp__plugin_cc-orq_orq__${tool}`), tool)
  for (const tool of ['status', 'list', 'cancel', 'integrate']) assert.equal(matcher.test(`mcp__plugin_cc-orq_orq__${tool}`), false, tool)
})

test('the session-mode hook script prints no permission decision and no other hook output than updatedInput', () => {
  const script = readFileSync(join(ROOT, 'scripts', 'session-mode-hook.sh'), 'utf8')
  assert.equal(/permissionDecision|"decision"|"continue"|additionalContext/.test(script), false)
  assert.ok(script.includes('python3 -I -c'), 'python3 runs isolated, so a module in the working directory is never imported')
})
