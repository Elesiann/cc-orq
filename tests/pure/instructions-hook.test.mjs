import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ORCHESTRATION_INSTRUCTIONS } from '../../hooks/instructions.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = `${ROOT}/scripts/session-start.sh`
const runHook = (pluginRoot) =>
  execFileSync('bash', [SCRIPT], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot }, encoding: 'utf8' })

test('instructions.md is the orchestration instructions constant, byte for byte', () => {
  assert.equal(readFileSync(`${ROOT}/instructions.md`, 'utf8'), ORCHESTRATION_INSTRUCTIONS)
})

test('the session-start script prints valid JSON whose additionalContext is the instructions', () => {
  const parsed = JSON.parse(runHook(ROOT))
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(parsed.hookSpecificOutput.additionalContext, ORCHESTRATION_INSTRUCTIONS)
})

test('the session-start script prints nothing when instructions.md is missing', () => {
  assert.equal(runHook(`${ROOT}/no-such-plugin-root`), '')
})

test('hooks/hooks.json runs the session-start script on SessionStart', () => {
  const hooks = JSON.parse(readFileSync(`${ROOT}/hooks/hooks.json`, 'utf8'))
  const command = hooks.hooks.SessionStart.flatMap((group) => group.hooks.map((hook) => hook.command))
  assert.deepEqual(command, ['bash "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh"'])
})
