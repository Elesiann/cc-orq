import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ORCHESTRATION_INSTRUCTIONS } from '../../hooks/instructions.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = `${ROOT}/scripts/session-start.sh`
// The variable is set or removed on purpose: the shell that runs the tests may carry it.
const runHook = (pluginRoot, hooks) => {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot }
  if (hooks === undefined) delete env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
  else env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = hooks
  return execFileSync('bash', [SCRIPT], { env, encoding: 'utf8' })
}

test('instructions.md is the orchestration instructions constant, byte for byte', () => {
  assert.equal(readFileSync(`${ROOT}/instructions.md`, 'utf8'), ORCHESTRATION_INSTRUCTIONS)
})

test('with function hooks on, the session-start script prints valid JSON whose additionalContext is the instructions', () => {
  const parsed = JSON.parse(runHook(ROOT, '1'))
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(parsed.hookSpecificOutput.additionalContext, ORCHESTRATION_INSTRUCTIONS)
})

test('without function hooks, the session-start script prints nothing: the snippet teaches an agent that does not exist then', () => {
  for (const hooks of [undefined, '', '0', 'false']) {
    assert.equal(runHook(ROOT, hooks), '', `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=${JSON.stringify(hooks)}`)
  }
})

test('the session-start script prints nothing when instructions.md is missing', () => {
  assert.equal(runHook(`${ROOT}/no-such-plugin-root`, '1'), '')
})

// Spelled in parts, so that this file is not a match of its own search.
const OLD_PREFIX = ['mcp', 'cc-orq', ''].join('__')

test('no text that names a tool uses the old prefix, except for the wait tool the mod still serves', (t) => {
  const found = spawnSync('git', ['grep', '-n', OLD_PREFIX, '--', '.', ':!CHANGELOG.md'], { cwd: ROOT, encoding: 'utf8' })
  if (found.status !== 0 && found.status !== 1) return t.skip('not inside a git checkout, so there are no tracked files to search')
  const stale = found.stdout.split('\n').filter((line) => line !== '' && line.replaceAll(`${OLD_PREFIX}wait`, '').includes(OLD_PREFIX))
  assert.deepEqual(stale, [])
})

test('hooks/hooks.json runs the session-start script on SessionStart', () => {
  const hooks = JSON.parse(readFileSync(`${ROOT}/hooks/hooks.json`, 'utf8'))
  const command = hooks.hooks.SessionStart.flatMap((group) => group.hooks.map((hook) => hook.command))
  assert.deepEqual(command, ['bash "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh"'])
})
