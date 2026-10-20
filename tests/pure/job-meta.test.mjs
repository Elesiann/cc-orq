import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJobMeta } from '../../hooks/types.ts'

const base = { id: 'task-1-a-1-abc', kind: 'task', agentId: 'a-1', cwd: '/srv/example/repo', startedAt: 1 }

test('a meta.json without the mode fields reads with both modes absent', () => {
  const job = parseJobMeta(base, '/jobs', base.id)
  assert.equal(job.runtimeMode, undefined)
  assert.equal(job.interactionMode, undefined)
})

test('a recorded runtime and interaction mode is read, and an unknown value is left out', () => {
  const job = parseJobMeta({ ...base, runtimeMode: 'auto', interactionMode: 'plan' }, '/jobs', base.id)
  assert.equal(job.runtimeMode, 'auto')
  assert.equal(job.interactionMode, 'plan')
  const unknown = parseJobMeta({ ...base, runtimeMode: 'bypass', interactionMode: 7 }, '/jobs', base.id)
  assert.ok(unknown)
  assert.equal(unknown.runtimeMode, undefined)
  assert.equal(unknown.interactionMode, undefined)
})
