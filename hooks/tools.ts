// The three MCP tools of the orq mod: capabilities, status and cancel. Each is served by a
// `tool.call` hook on its full name and answers with a JSON string. A refusal is a typed failure,
// `{ error: { code, message } }`, so the model can branch on the code.

import type { EngineInterface, On } from 'claude-code'

import {
  type CapabilitiesResult,
  type Failure,
  type FailureCode,
  type InteractionMode,
  type ProviderInstance,
  type RuntimeMode,
  type TaskCancelResult,
} from './contract.ts'
import { buildCapabilities, parseCatalogInstances } from './catalog.ts'
import { loadConfig, type OrqConfig } from './config.ts'
import { jobView, listJobs, readJobStatus, readMeta, taskStatusOf, writeCancel } from './engine.ts'
import { formatDuration, isRecord } from './types.ts'

const CAPABILITIES_TOOL = 'mcp__orq__capabilities'
const STATUS_TOOL = 'mcp__orq__status'
const CANCEL_TOOL = 'mcp__orq__cancel'

const NO_INPUT = { type: 'object', properties: {}, required: [], additionalProperties: false }
const TASK_ID_INPUT = {
  type: 'object',
  properties: { taskId: { type: 'string' } },
  required: ['taskId'],
  additionalProperties: false,
}

const TOOL_SPECS = [
  {
    name: 'capabilities',
    description:
      'List the orq provider instances (as configured in the instances list) with their live models from the catalog probe, ' +
      `each model's options and allowed values (such as reasoningEffort), each instance's constraints, and the parent session's runtimeMode and interactionMode. ` +
      'Read it before you name a target in an orq:task brief, and do not guess model ids. Takes no input.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'status',
    description:
      "Read one orq task's state from its job directory: status (queued, running, waiting, completed, failed, cancelled or interrupted), " +
      'workState (working, waiting_for_children or result_available), and once it has ended its result or error. ' +
      'Input: {"taskId": "<id>"}. Works for tasks of earlier sessions. An unknown id answers task_not_found.',
    inputSchema: TASK_ID_INPUT,
  },
  {
    name: 'cancel',
    description:
      'Cancel a running orq task. Input: {"taskId": "<id>"}. A running task answers cancel_requested and ends as cancelled once its supervisor stops it. ' +
      'A task that has already ended answers task_not_cancellable, and nothing is written.',
    inputSchema: TASK_ID_INPUT,
  },
]

const CAPABILITY_FEATURES: CapabilitiesResult['features'] = {
  appOwnedSubagents: true,
  asyncPolling: true,
  cancellation: true,
  batchThreadCreation: false,
  threadManagement: false,
  incrementalThreadRead: false,
  scheduledTasks: false,
  maxBatchThreads: 0,
}

const CATALOG_CACHE_MS = 10 * 60 * 1000
const CATALOG_TIMEOUT_MS = 90000

type CatalogCache = { at: number; key: string; instances: ProviderInstance[] }
let catalogCache: CatalogCache | null = null

function fail(code: FailureCode, message: string): { result: string } {
  const failure: Failure = { error: { code, message } }
  return { result: JSON.stringify(failure) }
}

/** The taskId a tool call carries; null when the input has none. */
function taskIdOf(input: unknown): string | null {
  return isRecord(input) && typeof input.taskId === 'string' && input.taskId !== '' ? input.taskId : null
}

async function configOf($: EngineInterface): Promise<OrqConfig> {
  const { config, warning } = await loadConfig($)
  if (warning) await $.ui.log(`orq: ${warning}`, { to: 'debug' })
  return config
}

/** The provider instances the probe reports for the configured ones, cached for ten minutes. A failed probe is not cached. */
async function probeInstances($: EngineInterface, config: OrqConfig): Promise<ProviderInstance[]> {
  const probeConfig = config.instances.map((i) => ({ instanceId: i.id, driver: i.driver, ...(i.env ? { env: i.env } : {}) }))
  const key = JSON.stringify(probeConfig)
  const now = await $.clock.now()
  const cached = catalogCache
  if (cached && cached.key === key && now >= cached.at && now - cached.at < CATALOG_CACHE_MS) return cached.instances
  try {
    const run = await $.process.run(['python3', `${$.plugin.root}/scripts/catalog.py`], {
      timeoutMs: CATALOG_TIMEOUT_MS,
      stdin: key,
    })
    if (run.exitCode !== 0) throw new Error(`catalog.py exited ${run.exitCode}`)
    const instances = parseCatalogInstances(run.stdout)
    catalogCache = { at: now, key, instances }
    return instances
  } catch (err) {
    await $.ui.log(`orq: catalog probe failed: ${String(err)}`, { to: 'debug' })
    return []
  }
}

/** The permission mode the parent session runs under: `perm:session:<id>` when recorded, else the settings' defaultMode. */
async function parentPermissionMode($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  const recorded = await $.store.get(`perm:session:${sessionId}`)
  if (typeof recorded === 'string') return recorded
  const { permissions } = await $.settings.read()
  return isRecord(permissions) && typeof permissions.defaultMode === 'string' ? permissions.defaultMode : undefined
}

/** T3's mapping of a Claude Code permission mode to the modes a child task may run in. */
function parentRuntimeModeFromPermissionMode(mode: string | undefined): {
  runtimeMode: RuntimeMode
  interactionMode: InteractionMode
} {
  switch (mode) {
    case 'plan':
      return { runtimeMode: 'approval-required', interactionMode: 'plan' }
    case 'acceptEdits':
      return { runtimeMode: 'auto-accept-edits', interactionMode: 'default' }
    case 'auto':
      return { runtimeMode: 'auto', interactionMode: 'default' }
    case 'dontAsk':
      // `dontAsk` denies anything needing approval instead of prompting, so the child
      // ceiling stays restrictive and never becomes a bypass.
      return { runtimeMode: 'approval-required', interactionMode: 'default' }
    case 'bypassPermissions':
      return { runtimeMode: 'full-access', interactionMode: 'default' }
    case 'default':
    default:
      return { runtimeMode: 'approval-required', interactionMode: 'default' }
  }
}

async function capabilitiesAnswer($: EngineInterface): Promise<{ result: string }> {
  const config = await configOf($)
  const instances = await probeInstances($, config)
  const modes = parentRuntimeModeFromPermissionMode(await parentPermissionMode($))
  const answer: CapabilitiesResult = {
    parentThreadId: null,
    inheritedProviderInstanceId: null,
    inheritedModel: null,
    ...modes,
    providers: buildCapabilities(instances),
    features: CAPABILITY_FEATURES,
  }
  return { result: JSON.stringify(answer) }
}

async function statusAnswer($: EngineInterface, input: unknown): Promise<{ result: string }> {
  const taskId = taskIdOf(input)
  if (taskId === null) return fail('invalid_request', `${STATUS_TOOL} needs {"taskId": "<id>"}`)
  const status = await readJobStatus($, await configOf($), taskId)
  if (status === null) return fail('task_not_found', `no task ${taskId}`)
  return { result: JSON.stringify(status) }
}

async function cancelAnswer($: EngineInterface, input: unknown): Promise<{ result: string }> {
  const taskId = taskIdOf(input)
  if (taskId === null) return fail('invalid_request', `${CANCEL_TOOL} needs {"taskId": "<id>"}`)
  const config = await configOf($)
  const job = await readMeta($, config.jobsDir, taskId)
  if (!job) return fail('task_not_found', `no task ${taskId}`)
  const status = taskStatusOf(await jobView($, job))
  if (status !== 'running') return fail('task_not_cancellable', `task ${taskId} is ${status}, not running`)
  await writeCancel($, job)
  const answer: TaskCancelResult = { taskId: job.id, status: 'cancel_requested' }
  return { result: JSON.stringify(answer) }
}

/** One debug line per job in the jobs directory that has no exit file, with its kind and age. */
async function logUnfinished($: EngineInterface, config: OrqConfig): Promise<void> {
  const jobs = await listJobs($, config.jobsDir)
  if (jobs.length === 0) return
  const now = await $.clock.now()
  for (const job of jobs) {
    if (await $.fs.exists(`${job.dir}/exit`)) continue
    await $.ui.log(`orq: unfinished job ${job.id} (${job.kind}), started ${formatDuration(now - job.startedAt)} ago`, {
      to: 'debug',
    })
  }
}

/**
 * Declares the three tools and logs the unfinished jobs. Called from the one session.start hook,
 * since a plugin registers one hook per event.
 */
export async function startTools($: EngineInterface, config: OrqConfig): Promise<void> {
  catalogCache = null
  for (const spec of TOOL_SPECS) await $.tool.register(spec)
  await logUnfinished($, config)
}

/** Serves the three tools. Their declaration happens in startTools, at session.start. */
export function registerTools(on: On): void {
  on('tool.call', { tool: CAPABILITIES_TOOL }, async ($) => capabilitiesAnswer($))
  on('tool.call', { tool: STATUS_TOOL }, async ($, e) => statusAnswer($, e))
  on('tool.call', { tool: CANCEL_TOOL }, async ($, e) => cancelAnswer($, e))
}
