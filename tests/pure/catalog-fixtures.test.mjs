import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseAgyModels,
  parseCodexModels,
  parseOpencodeModels,
} from '../../hooks/catalog.ts'

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

test('the codex fixture keeps the listed models with their default effort', () => {
  const models = parseCodexModels(fixture('codex-models.json'))
  assert.deepEqual(models.map((m) => m.id), ['fixture-model-1', 'fixture-model-2'])
  const effort = models[0].options[0]
  assert.equal(effort.id, 'reasoningEffort')
  assert.equal(effort.currentValue, 'medium')
  assert.deepEqual(effort.options.map((o) => o.id), ['low', 'medium', 'high', 'max'])
  assert.equal(effort.options.find((o) => o.id === 'medium').isDefault, true)
})

test('the opencode fixture keeps the models of every listed provider', () => {
  const models = parseOpencodeModels(fixture('opencode-models.txt'))
  assert.deepEqual(models.map((m) => m.id), [
    'fixture-provider-1/fixture-model-4',
    'fixture-provider-1/fixture-model-5',
    'fixture-provider-2/fixture-model-6',
    'fixture-provider-4/fixture-model-7',
  ])
})

test('the antigravity fixture keeps the effort in the id and tolerates a missing label', () => {
  assert.deepEqual(parseAgyModels(fixture('agy-models.txt')), [
    { id: 'fixture-model-8-high', label: 'Fixture Model Eight (High)' },
    { id: 'fixture-model-8-low', label: 'Fixture Model Eight (Low)' },
    { id: 'fixture-model-9', label: 'Fixture Model Nine' },
  ])
})

test('the catalog fixtures name no real model or provider', () => {
  const real = /gpt|gemini|claude|muse|luna|sol|deepseek|qwen|nova|opus|sonnet|haiku|bedrock|cerebras|openai|google|nvidia|zenmux/i
  for (const name of ['codex-models.json', 'opencode-models.txt', 'agy-models.txt']) {
    assert.equal(real.test(fixture(name)), false, name)
  }
})
