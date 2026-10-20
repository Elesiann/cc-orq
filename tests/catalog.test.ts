import { expect, test } from 'claude-code/testing'

import {
  CLAUDE_ALIASES,
  buildCapabilities,
  claudeAliasModels,
  isProviderAvailable,
  parseAgyModels,
  parseCatalogInstances,
  parseCodexModels,
  parseOpencodeAuthIds,
  parseOpencodeModels,
  providerConstraints,
  toProviderCapability,
} from '../hooks/catalog.ts'
import type { ProviderInstance } from '../hooks/contract.ts'

// Small samples in the shape each CLI prints. The full captured outputs are in tests/fixtures.
const CODEX_SAMPLE = JSON.stringify({
  models: [
    {
      slug: 'fixture-model-1',
      display_name: 'Fixture Model One',
      visibility: 'list',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth' },
        { effort: 'max', description: 'Maximum reasoning depth' },
      ],
    },
    { slug: 'fixture-hidden', display_name: 'Hidden', visibility: 'hide', supported_reasoning_levels: [] },
    { slug: 'fixture-plain', display_name: 'Plain', visibility: 'list' },
    null,
    { slug: 'fixture-broken-levels', visibility: 'list', supported_reasoning_levels: [null, { effort: 7 }] },
  ],
})

const AUTH_SAMPLE = JSON.stringify([
  { id: 'fixture-provider-a', name: 'Provider A', connections: [{ type: 'env' }] },
  { id: 'fixture-provider-b', name: 'Provider B', connections: [{ type: 'credential' }] },
])

const OPENCODE_SAMPLE = [
  'fixture-provider-a/fixture-model-2',
  'fixture-provider-b/fixture-model-3',
  'fixture-provider-c/fixture-model-4',
  'not-a-model-line',
  '',
].join('\n')

const AGY_SAMPLE = ['fixture-model-5-high\tFixture Model Five (High)', 'fixture-model-6\tFixture Model Six', 'bare-id', ''].join('\n')

function instance(o: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    instanceId: 'x',
    driver: 'codex',
    displayName: null,
    enabled: true,
    installed: true,
    authenticated: true,
    unavailableReason: null,
    models: [],
    ...o,
  }
}

test('codex output keeps listed models with their effort options and default', () => {
  const models = parseCodexModels(CODEX_SAMPLE)
  expect(models.map((m) => m.id)).toEqual(['fixture-model-1', 'fixture-plain', 'fixture-broken-levels'])
  expect(models[0]?.label).toBe('Fixture Model One')
  const effort = models[0]?.options?.[0]
  expect(effort?.id).toBe('reasoningEffort')
  expect(effort?.type).toBe('select')
  expect(effort?.options).toEqual([
    { id: 'low', label: 'low', description: 'Fast responses with lighter reasoning' },
    { id: 'medium', label: 'medium', description: 'Balances speed and reasoning depth', isDefault: true },
    { id: 'max', label: 'max', description: 'Maximum reasoning depth' },
  ])
  expect(effort?.currentValue).toBe('medium')
  expect(models[1]?.options).toBe(undefined)
  expect(models[2]?.options).toBe(undefined)
})

test('codex parsing is total on garbage', () => {
  expect(parseCodexModels('not json')).toEqual([])
  expect(parseCodexModels('{"models": "nope"}')).toEqual([])
  expect(parseCodexModels('{"models": null}')).toEqual([])
  expect(parseCodexModels('[1, 2]')).toEqual([])
  expect(parseCodexModels('null')).toEqual([])
})

test('opencode output keeps only the models of logged-in providers', () => {
  const ids = parseOpencodeAuthIds(AUTH_SAMPLE)
  expect(ids).toEqual(['fixture-provider-a', 'fixture-provider-b'])
  expect(parseOpencodeModels(OPENCODE_SAMPLE, ids)).toEqual([
    { id: 'fixture-provider-a/fixture-model-2', label: 'fixture-model-2' },
    { id: 'fixture-provider-b/fixture-model-3', label: 'fixture-model-3' },
  ])
  expect(parseOpencodeAuthIds('garbage')).toEqual([])
  expect(parseOpencodeAuthIds('[1, {"id": 2}, {"id": "ok"}]')).toEqual(['ok'])
})

test('antigravity output keeps the effort in the id and tolerates bare lines', () => {
  expect(parseAgyModels(AGY_SAMPLE)).toEqual([
    { id: 'fixture-model-5-high', label: 'Fixture Model Five (High)' },
    { id: 'fixture-model-6', label: 'Fixture Model Six' },
    { id: 'bare-id', label: null },
  ])
})

test('claude models are the haiku, sonnet and opus aliases', () => {
  expect([...CLAUDE_ALIASES]).toEqual(['haiku', 'sonnet', 'opus'])
  expect(claudeAliasModels()).toEqual([
    { id: 'haiku', label: null },
    { id: 'sonnet', label: null },
    { id: 'opus', label: null },
  ])
})

test('constraints use the T3 wording and an unavailable instance is not capable', () => {
  expect(providerConstraints(instance())).toEqual([])
  expect(providerConstraints(instance({ enabled: false }))).toEqual([
    'Provider instance is disabled.',
    'Provider driver is unavailable.',
  ])
  expect(providerConstraints(instance({ installed: false, unavailableReason: 'gone' }))).toEqual([
    'Provider executable is not installed.',
    'gone',
  ])
  expect(providerConstraints(instance({ authenticated: false }))).toEqual([
    'Provider driver is unavailable.',
    'Provider is not authenticated.',
  ])
  expect(isProviderAvailable(instance())).toBe(true)
  expect(isProviderAvailable(instance({ authenticated: null }))).toBe(true)
  expect(isProviderAvailable(instance({ authenticated: false }))).toBe(false)
})

test('capability assembly maps an instance the way T3 capabilities does', () => {
  const cap = toProviderCapability(
    instance({ instanceId: 'codex', displayName: 'Codex', models: [{ id: 'm', label: 'M', options: [] }] }),
  )
  expect(cap).toEqual({
    providerInstanceId: 'codex',
    driverKind: 'codex',
    displayName: 'Codex',
    models: [{ id: 'm', label: 'M', options: [] }],
    canRunChildTask: true,
    canRunCrossProviderChildTask: true,
    constraints: [],
  })
  const down = toProviderCapability(instance({ instanceId: 'z', installed: false }))
  expect(down.canRunChildTask).toBe(false)
  expect(down.canRunCrossProviderChildTask).toBe(false)
  expect(down.constraints.length > 0).toBe(true)
  expect(buildCapabilities([instance({ instanceId: 'a' }), instance({ instanceId: 'b' })]).map((c) => c.providerInstanceId)).toEqual(['a', 'b'])
})

test('catalog output parses to instances, drops unknown drivers and never carries a configured env value', () => {
  const text = JSON.stringify([
    { instanceId: 'codex', driver: 'codex', displayName: null, enabled: true, installed: true, authenticated: true, unavailableReason: null, models: [] },
    {
      instanceId: 'legacy',
      driver: 'opencode',
      env: { EXAMPLE_VALUE: 'sentinel-not-a-real-value' },
      models: [{ id: 'fixture-model-7', label: null }, { label: 'no id' }, 'bare'],
    },
  ])
  const instances = parseCatalogInstances(text)
  expect(instances.map((i) => i.instanceId)).toEqual(['codex', 'legacy'])
  expect(instances[1]?.models).toEqual([{ id: 'fixture-model-7', label: null }])
  expect(JSON.stringify(instances)).not.toContain('sentinel-not-a-real-value')
})

test('catalog output parsing is total on garbage', () => {
  expect(parseCatalogInstances('not json')).toEqual([])
  expect(parseCatalogInstances('{"instanceId": "x"}')).toEqual([])
  expect(
    parseCatalogInstances(
      JSON.stringify([{ instanceId: '', driver: 'codex' }, { instanceId: 'x', driver: 'bogus' }, null, 'codex']),
    ),
  ).toEqual([])
})
