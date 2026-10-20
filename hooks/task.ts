// The orq:task subagent. Its prompt names a target; the mod runs the task as a detached job and serves
// each step of the subagent itself, so no model call happens for it. The subagent waits on its job
// through mcp__orq__wait, and its answer goes back through SubagentHandback in auto mode, as text otherwise.

import type { EngineInterface, On, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import { loadConfig, MAX_WAIT_SECONDS, type OrqConfig } from './config.ts'
import { fail, isFailure, type Failure } from './contract.ts'
import { composeAnswer, jobLiveness, launchTaskJob, readMeta, writeCancel, type Engine } from './engine.ts'
import { parseTaskHeader } from './task-header.ts'
import {
  effortFlag,
  parentRuntimeModeFromPermissionMode,
  resolveTarget,
  runnerPolicy,
  taskPrompt,
} from './target.ts'
import { formatDuration, isRecord, shellWord } from './types.ts'

type TaskEngine = Engine & Pick<EngineInterface, 'agent' | 'settings' | 'store' | 'tool' | 'ui'>

/** The subagent type a parent spawns with `Agent({ subagent_type: "orq:task" })`. */
export const TASK_SUBAGENT = 'orq:task'
const WAIT_TOOL = 'mcp__orq__wait'
const HANDBACK_TOOL = 'SubagentHandback'

const WAIT_DESCRIPTION =
  'Wait for an orq background job. Input is {"job": "<job-id>"}. Answers finished, supervisor gone, or still running with how long it has run; call again until it finishes.'
const WAIT_SCHEMA = {
  type: 'object',
  properties: { job: { type: 'string' } },
  required: ['job'],
  additionalProperties: false,
}
const TASK_AGENT_DESCRIPTION =
  'Runs one self-contained task on a configured orq instance (Codex, OpenCode, Antigravity or Claude) in the background. ' +
  'The prompt starts with two required header lines, `target: <instance> <model> [effort=<value>] [runtime=<mode>] [interaction=<mode>]` and ' +
  '`cwd: /absolute/path`, then optionally `isolation: worktree | shared` and `role: implementation | research | review | design | test | general`, ' +
  'then the task. runtime and interaction can narrow the session, never widen it. The answer arrives when the job ends.'
const ONE_LINE_PROMPT =
  'An orq runner: the orq plugin serves your steps and runs your task on the external CLI its target line names. Call mcp__orq__wait with the job id until the job finishes.'

/** A launched job's id, or the refusal a step answers with. Stored per agent so a repeated step reuses it. */
type TaskRun = { jobId: string } | { refusal: string }

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

async function storeRead($: TaskEngine, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function sessionId($: TaskEngine): Promise<string | undefined> {
  try {
    return stringValue(await $.session.id())
  } catch {
    return undefined
  }
}

/** The agent id from an agent.spawn result, bare or wrapped in `value`; a denied spawn has none. */
function spawnedAgentId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  const outcome = typeof result.agentId === 'string' || typeof result.deny === 'string' || !isRecord(result.value) ? result : result.value
  if (typeof outcome.deny === 'string') return undefined
  return stringValue(outcome.agentId)
}

function parseTaskRun(value: unknown): TaskRun | null {
  if (!isRecord(value)) return null
  if (typeof value.jobId === 'string') return { jobId: value.jobId }
  if (typeof value.refusal === 'string') return { refusal: value.refusal }
  return null
}

/** The mode this task's own spawn captured. It is the only input to the task's privilege ceiling. */
async function spawnPermissionMode($: TaskEngine, agentId: string): Promise<string | undefined> {
  return stringValue(await storeRead($, `perm:${agentId}`))
}

/**
 * The mode that picks how a finished task is delivered: the spawn's, then the session's last orq:task spawn,
 * then the settings default. It chooses a delivery format, never a privilege.
 */
async function handbackPermissionMode($: TaskEngine, agentId: string): Promise<string | undefined> {
  const own = await spawnPermissionMode($, agentId)
  if (own !== undefined) return own
  const sid = await sessionId($)
  const bySession = sid === undefined ? undefined : stringValue(await storeRead($, `perm:session:${sid}`))
  if (bySession !== undefined) return bySession
  try {
    const settings = await $.settings.read()
    return isRecord(settings.permissions) ? stringValue(settings.permissions.defaultMode) : undefined
  } catch {
    return undefined
  }
}

/** A path with its symlinks resolved through realpath: -e needs the path to exist, -m does not. Null when refused. */
async function resolvePath($: TaskEngine, path: string, mode: '-e' | '-m'): Promise<string | null> {
  try {
    const r = await $.process.run(['realpath', mode, '--', path], { timeoutMs: 10000 })
    const resolved = r.stdout.trim()
    return r.exitCode === 0 && resolved.startsWith('/') ? resolved : null
  } catch {
    return null
  }
}

/** True when `path` is `root` or lies beneath it, on whole path segments: "/a/bc" is not inside "/a/b". */
export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/** The session's directory and each allowedRoots entry, resolved through symlinks. An entry that cannot be resolved is left out. */
async function scopeRoots($: TaskEngine, config: OrqConfig): Promise<string[]> {
  let session = ''
  try {
    session = await $.session.cwd()
  } catch {
    session = ''
  }
  const roots: string[] = []
  for (const candidate of [session, ...config.allowedRoots]) {
    if (candidate === '') continue
    const resolved = await resolvePath($, candidate, '-m')
    if (resolved !== null) roots.push(resolved)
  }
  return roots
}

/**
 * The directory a task runs in, resolved through symlinks. It must lie inside the session's directory or an
 * allowedRoots entry; a path that does not exist, or is not a directory, is refused too.
 */
async function scopedCwd($: TaskEngine, config: OrqConfig, requested: string): Promise<{ cwd: string } | { refusal: string }> {
  const cwd = await resolvePath($, requested, '-e')
  if (cwd === null) return { refusal: `orq: task refused: directory does not exist: ${requested}` }
  const roots = await scopeRoots($, config)
  if (!roots.some((root) => isWithin(cwd, root))) {
    const named = roots.length > 0 ? roots.join(', ') : 'none'
    return {
      refusal: refusalText(fail('cwd_out_of_scope', `cwd ${cwd} is outside the session directory and the allowed roots (${named}).`)),
    }
  }
  try {
    if ((await $.fs.stat(cwd)).kind === 'dir') return { cwd }
  } catch {
    /* reported below as not a directory */
  }
  return { refusal: `orq: task refused: not a directory: ${cwd}` }
}

function firstUserText(messages: { role: string; text: string }[]): string | undefined {
  return messages.find((message) => message.role === 'user')?.text
}

/** A task agent is one whose spawn the mod saw as orq:task. Every other agent passes through untouched. */
async function isTaskAgent($: TaskEngine, agentId: string): Promise<boolean> {
  return (await storeRead($, `task:${agentId}`)) === TASK_SUBAGENT
}

function refusalText(failure: Failure): string {
  return `orq: task refused (${failure.error.code}): ${failure.error.message}`
}

async function readMessages($: TaskEngine, agentId: string): Promise<{ role: string; text: string }[]> {
  try {
    const messages = await $.session.messages({ agentId })
    return Array.isArray(messages) ? messages : []
  } catch {
    return []
  }
}

/** Resolve the header against the ceiling and the configured instances, then launch. Every refusal is text. */
async function launchForAgent($: TaskEngine, config: OrqConfig, agentId: string): Promise<TaskRun> {
  const text = firstUserText(await readMessages($, agentId))
  if (text === undefined) return { refusal: 'orq: task refused: its prompt could not be read.' }
  const header = parseTaskHeader(text)
  if (isFailure(header)) return { refusal: `orq: task refused: ${header.error.message}` }
  const spawnMode = await spawnPermissionMode($, agentId)
  if (spawnMode === undefined) {
    await $.ui.log(`orq: ceiling for ${agentId}: no permission mode captured at spawn, using approval-required`, { to: 'debug' })
  }
  const ceiling = parentRuntimeModeFromPermissionMode(spawnMode)
  const resolved = resolveTarget({
    target: header.target,
    instances: config.instances,
    parentRuntimeMode: ceiling.runtimeMode,
    parentInteractionMode: ceiling.interactionMode,
    runtimeMode: header.runtimeMode ?? 'inherit',
    interactionMode: header.interactionMode ?? 'inherit',
  })
  if (isFailure(resolved)) return { refusal: refusalText(resolved) }
  const policy = runnerPolicy(resolved.instance.driver, resolved.runtimeMode, resolved.interactionMode)
  if (isFailure(policy)) return { refusal: refusalText(policy) }
  const scoped = await scopedCwd($, config, header.cwd)
  if ('refusal' in scoped) return scoped
  if (header.isolation === 'worktree') {
    await $.ui.log(`orq: isolation worktree is not implemented yet; the task for ${agentId} runs in ${scoped.cwd}`, { to: 'debug' })
  }
  const launched = await launchTaskJob($, config, {
    agentId,
    instance: resolved.instance,
    model: resolved.model,
    cwd: scoped.cwd,
    prompt: taskPrompt(header.prompt, header.role),
    flags: [...policy.flags, ...effortFlag(resolved.instance.driver, resolved.options)],
  })
  return 'refusal' in launched ? { refusal: launched.refusal } : { jobId: launched.job.id }
}

/** The run recorded for this agent, or a new one. A repeated step finds the record and does not relaunch. */
async function runFor($: TaskEngine, config: OrqConfig, agentId: string): Promise<TaskRun> {
  const key = `agent:${agentId}`
  const stored = parseTaskRun(await storeRead($, key))
  if (stored !== null) return stored
  const run = await launchForAgent($, config, agentId)
  try {
    await $.store.set(key, run)
  } catch (err) {
    await $.ui.log(`orq: could not record the run of ${agentId}: ${String(err)}`, { to: 'debug' })
  }
  return run
}

async function cancelRun($: TaskEngine, config: OrqConfig, agentId: string, reason: string): Promise<void> {
  try {
    const run = parseTaskRun(await storeRead($, `agent:${agentId}`))
    if (run === null || !('jobId' in run)) return
    const job = await readMeta($, config.jobsDir, run.jobId)
    if (job !== null) await writeCancel($, job, reason)
  } catch (err) {
    await $.ui.log(`orq: could not cancel the run of ${agentId}: ${String(err)}`, { to: 'debug' })
  }
}

async function handbackDue($: TaskEngine, agentId: string): Promise<boolean> {
  if ((await storeRead($, `handedback:${agentId}`)) === true) return false
  const mode = await handbackPermissionMode($, agentId)
  if (mode === 'auto') return true
  const why = mode === undefined ? 'no permission mode' : `mode is ${mode}, not auto`
  await $.ui.log(`orq: handback skipped for ${agentId}: ${why}`, { to: 'debug' })
  return false
}

/** The step's final answer: SubagentHandback under auto mode, the text otherwise. */
async function* answerStep($: TaskEngine, e: TurnStepInput, agentId: string, answer: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if (await handbackDue($, agentId)) {
    await $.store.set(`handedback:${agentId}`, true)
    const input = { message: answer }
    yield { kind: 'tool', index: 0, id: `handback-${agentId}-${e.index}`, name: HANDBACK_TOOL }
    yield { kind: 'input', index: 0, json: JSON.stringify(input) }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: HANDBACK_TOOL, input }], stopReason: 'tool_use', usage: null }
  }
  yield { kind: 'text', index: 0, text: answer }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
}

/** The step that waits on a running job: one mcp__orq__wait call, with no model call. */
async function* waitStep(e: TurnStepInput, jobId: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'tool', index: 0, id: `wait-${jobId}-${e.index}`, name: WAIT_TOOL }
  yield { kind: 'input', index: 0, json: JSON.stringify({ job: jobId }) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: WAIT_TOOL, input: { job: jobId } }], stopReason: 'tool_use', usage: null }
}

/** Sleeps in 2-second steps until the job exits (0), its supervisor is gone (12), or the budget ends (11). */
function waitScript(dir: string, iterations: number): string {
  const exit = shellWord(`${dir}/exit`)
  const pgid = shellWord(`${dir}/pgid`)
  return (
    `# orq:wait\nfor i in $(seq 1 ${iterations}); do\n` +
    `  [ -e ${exit} ] && exit 0\n` +
    `  pgid=$(cat ${pgid} 2>/dev/null | tr -d ' \\t\\n')\n` +
    `  case "$pgid" in ''|*[!0-9]*) exit 12 ;; esac\n` +
    `  kill -0 -"$pgid" 2>/dev/null || { [ -e ${exit} ] && exit 0; exit 12; }\n` +
    `  sleep 2\n` +
    `done\nexit 11`
  )
}

/** Declares the wait tool and the orq:task agent. Called from the session.start hook, which owns that event. */
export async function registerTaskSurface($: Pick<EngineInterface, 'agent' | 'tool'>): Promise<void> {
  await $.tool.register({ name: 'wait', description: WAIT_DESCRIPTION, inputSchema: WAIT_SCHEMA })
  await $.agent.register({
    name: 'task',
    description: TASK_AGENT_DESCRIPTION,
    prompt: ONE_LINE_PROMPT,
    tools: [WAIT_TOOL],
    background: true,
  })
}

export function registerTask(on: On): void {
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      const agentId = spawnedAgentId(r)
      if (agentId !== undefined && e.subagentType === TASK_SUBAGENT) {
        await $.store.set(`task:${agentId}`, TASK_SUBAGENT)
        const mode = stringValue(e.permissionMode)
        if (mode !== undefined) {
          await $.store.set(`perm:${agentId}`, mode)
          const sid = await sessionId($)
          if (sid !== undefined) await $.store.set(`perm:session:${sid}`, mode)
        }
      }
    } catch (err) {
      await $.ui.log(`orq: could not record the spawn: ${String(err)}`, { to: 'debug' })
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId === undefined || !(await isTaskAgent($, agentId))) return yield* next(e)
    const { config } = await loadConfig($)
    next.signal.addEventListener('abort', () => void cancelRun($, config, agentId, 'turn-abort'), { once: true })
    const run = await runFor($, config, agentId)
    if (next.signal.aborted) await cancelRun($, config, agentId, 'turn-abort')
    if ('refusal' in run) return yield* answerStep($, e, agentId, run.refusal)
    const job = await readMeta($, config.jobsDir, run.jobId)
    if (job === null) return yield* answerStep($, e, agentId, `orq: task job ${run.jobId} has no readable metadata.`)
    if ((await jobLiveness($, job)) === 'running') return yield* waitStep(e, job.id)
    return yield* answerStep($, e, agentId, await composeAnswer($, config, job))
  })

  on('tool.call', { tool: WAIT_TOOL }, async ($, e, next) => {
    const jobId = isRecord(e) && typeof e.job === 'string' ? e.job : ''
    const { config } = await loadConfig($)
    const job = await readMeta($, config.jobsDir, jobId)
    if (job === null) return { result: `unknown job ${jobId || '(missing)'}` }
    next.signal.addEventListener('abort', () => void writeCancel($, job, 'wait-abort').catch(() => undefined), { once: true })
    try {
      const slice = Math.min(config.waitSeconds, MAX_WAIT_SECONDS)
      const w = await $.process.run(['bash', '-c', waitScript(job.dir, Math.floor(slice / 2))], {
        timeoutMs: slice * 1000 + 5000,
      })
      if (w.exitCode === 0) return { result: 'finished' }
      if (w.exitCode === 12) return { result: 'supervisor gone' }
      if (w.exitCode !== 11) return { result: `orq: wait failed (exit ${w.exitCode})` }
      const now = await $.clock.now()
      return { result: `still running, ${formatDuration(now - job.startedAt)}` }
    } catch {
      // The engine rejects the wait's process run when the dispatch aborts, so a throw here is a stop.
      await writeCancel($, job, 'wait-throw')
      return { result: 'cancelled' }
    }
  })
}
