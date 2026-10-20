import { expect, test } from 'claude-code/testing'

import { isFailure } from '../hooks/contract.ts'
import { parseTaskHeader } from '../hooks/task-header.ts'

const REPO = '/srv/example/repo'

function refusal(text: string): { code: string; message: string } {
  const r = parseTaskHeader(text)
  if (!isFailure(r)) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`)
  return r.error
}

test('a full header yields every field and the task text after it', () => {
  const r = parseTaskHeader(
    `target: codex fixture-model effort=high runtime=auto interaction=plan\ncwd: ${REPO}\nisolation: shared\nrole: review\n\nCheck the diff.\nAnd the tests.`,
  )
  if (isFailure(r)) throw new Error(r.error.message)
  expect(r).toEqual({
    target: {
      providerInstanceId: 'codex',
      model: 'fixture-model',
      options: [{ id: 'reasoningEffort', value: 'high' }],
    },
    cwd: REPO,
    isolation: 'shared',
    role: 'review',
    runtimeMode: 'auto',
    interactionMode: 'plan',
    prompt: 'Check the diff.\nAnd the tests.',
  })
})

test('header lines may come in any order, and isolation defaults to worktree', () => {
  const r = parseTaskHeader(`role: test\ncwd: ${REPO}\ntarget: opencode fixture-model\n\nRun the suite.`)
  if (isFailure(r)) throw new Error(r.error.message)
  expect(r.target).toEqual({ providerInstanceId: 'opencode', model: 'fixture-model' })
  expect(r.isolation).toBe('worktree')
  expect(r.role).toBe('test')
  expect(r.prompt).toBe('Run the suite.')
})

test('the first line that is not a header starts the task text, even when it looks like one later', () => {
  const r = parseTaskHeader(`target: codex fixture-model\ncwd: ${REPO}\nRun it.\ncwd: /srv/example/other`)
  if (isFailure(r)) throw new Error(r.error.message)
  expect(r.cwd).toBe(REPO)
  expect(r.prompt).toBe('Run it.\ncwd: /srv/example/other')
})

test('a missing target line is refused with the expected format', () => {
  const error = refusal(`cwd: ${REPO}\nJust do it.`)
  expect(error.code).toBe('invalid_request')
  expect(error.message).toContain('Header lines may come in any order; `target:` and `cwd:` are required.')
})

test('an unknown isolation is refused and names the choices', () => {
  const error = refusal(`target: codex fixture-model\ncwd: ${REPO}\nisolation: sandbox\nGo.`)
  expect(error.code).toBe('invalid_request')
  expect(error.message).toBe('isolation must be one of: worktree, shared.')
})

test('an unknown role is refused and names the choices', () => {
  const error = refusal(`target: codex fixture-model\ncwd: ${REPO}\nrole: boss\nGo.`)
  expect(error.code).toBe('invalid_request')
  expect(error.message).toBe('role must be one of: implementation, research, review, design, test, general.')
})

test('a header with no task text after it is refused', () => {
  const error = refusal(`target: codex fixture-model\ncwd: ${REPO}\n\n   \n`)
  expect(error.code).toBe('invalid_request')
  expect(error.message).toBe('The task text after the header is empty.')
})

test('a relative cwd is refused, and so is a missing one', () => {
  expect(refusal('target: codex fixture-model\ncwd: work/repo\nGo.').message).toBe(
    "cwd must be an absolute path, got 'work/repo'.",
  )
  expect(refusal('target: codex fixture-model\nGo.').message).toBe(
    'The cwd: line is required and must be an absolute path.',
  )
})

test('a model that starts with a dash is refused', () => {
  const error = refusal(`target: codex -fixture-model\ncwd: ${REPO}\nGo.`)
  expect(error.code).toBe('invalid_request')
  expect(error.message).toBe(
    'The model must be one word that does not start with "-" and has no control characters.',
  )
})

test('an option other than effort, runtime or interaction is refused rather than passed on unchecked', () => {
  const error = refusal(`target: codex fixture-model efort=high\ncwd: ${REPO}\nGo.`)
  expect(error.code).toBe('invalid_request')
  expect(error.message).toBe('Target option efort is not supported; use effort, runtime or interaction.')
})

test('effort must be one word, and runtime must name a known mode', () => {
  expect(refusal(`target: codex fixture-model effort=-x\ncwd: ${REPO}\nGo.`).message).toBe(
    'effort must be one word, such as high, got "-x".',
  )
  expect(refusal(`target: codex fixture-model runtime=root\ncwd: ${REPO}\nGo.`).message).toBe(
    'runtime must be one of: approval-required, auto-accept-edits, auto, full-access.',
  )
})

test('a header line given twice is refused, not silently overwritten', () => {
  const error = refusal(`target: codex fixture-model\ncwd: ${REPO}\ncwd: /srv/example/other\nGo.`)
  expect(error.code).toBe('invalid_request')
  expect(error.message).toBe('The cwd: line is given more than once.')
})

test('a target with more than two words before its options is refused', () => {
  const error = refusal(`target: codex fixture-model extra\ncwd: ${REPO}\nGo.`)
  expect(error.code).toBe('invalid_request')
  expect(error.message.startsWith('Target "codex fixture-model extra" must name an instance and a model.')).toBe(true)
})
