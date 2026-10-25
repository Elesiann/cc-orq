// What the orq tools capabilities, status and cancel answer, and the session-start log of unfinished jobs.
// The stdio server in server/ serves the tools; the mod no longer registers them. Every function takes the
// CoreEngine part of `$`, so the server runs the same code on its Node shim. A refusal is a typed failure,
// `{ error: { code, message } }`, so the model can branch on the code.

import { buildCapabilities, parseCatalogInstances } from './catalog.ts'
import type { OrqConfig } from './config.ts'
import {
  type CapabilitiesResult,
  type Failure,
  type InteractionMode,
  type ProviderInstance,
  type RuntimeMode,
  type TaskCancelResult,
  type TaskStatusResult,
  fail,
} from './contract.ts'
import { jobView, listJobs, readJobStatus, readMeta, taskStatusOf, writeCancel, type CoreEngine } from './engine.ts'
import { formatDuration, isRecord } from './types.ts'

/** The names the model calls the tools by. A refusal that quotes the expected input names the tool it answers. */
export const STATUS_TOOL = 'mcp__plugin_cc-orq_orq__status'
export const CANCEL_TOOL = 'mcp__plugin_cc-orq_orq__cancel'

export const CANCEL_REASON_MAX = 200

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

/** The last probe result. One per server, so a process, and a test, starts with none. */
export type CatalogCache = { entry: { at: number; key: string; instances: ProviderInstance[] } | null }

export function newCatalogCache(): CatalogCache {
  return { entry: null }
}

/** The taskId a tool call carries; null when the input has none. */
function taskIdOf(input: unknown): string | null {
  return isRecord(input) && typeof input.taskId === 'string' && input.taskId !== '' ? input.taskId : null
}

/** The provider instances the probe reports for the configured ones, cached for ten minutes. A failed probe is not cached. */
async function probeInstances($: CoreEngine, config: OrqConfig, cache: CatalogCache): Promise<ProviderInstance[]> {
  const probeConfig = config.instances.map((i) => ({ instanceId: i.id, driver: i.driver, ...(i.env ? { env: i.env } : {}) }))
  const key = JSON.stringify(probeConfig)
  const now = await $.clock.now()
  const cached = cache.entry
  if (cached && cached.key === key && now >= cached.at && now - cached.at < CATALOG_CACHE_MS) return cached.instances
  try {
    const run = await $.process.run(['python3', `${$.plugin.root}/scripts/catalog.py`], {
      timeoutMs: CATALOG_TIMEOUT_MS,
      stdin: key,
    })
    if (run.exitCode !== 0) throw new Error(`catalog.py exited ${run.exitCode}`)
    const instances = parseCatalogInstances(run.stdout)
    cache.entry = { at: now, key, instances }
    return instances
  } catch (err) {
    await $.ui.log(`orq: catalog probe failed: ${String(err)}`, { to: 'debug' })
    return []
  }
}

/** The providers the probe reports, with the modes a task may run in. The caller knows where those modes come from. */
export async function capabilitiesAnswer(
  $: CoreEngine,
  config: OrqConfig,
  modes: { runtimeMode: RuntimeMode; interactionMode: InteractionMode },
  cache: CatalogCache,
): Promise<CapabilitiesResult> {
  const instances = await probeInstances($, config, cache)
  return {
    parentThreadId: null,
    inheritedProviderInstanceId: null,
    inheritedModel: null,
    ...modes,
    providers: buildCapabilities(instances),
    features: CAPABILITY_FEATURES,
  }
}

export async function statusAnswer($: CoreEngine, config: OrqConfig, input: unknown): Promise<TaskStatusResult | Failure> {
  const taskId = taskIdOf(input)
  if (taskId === null) return fail('invalid_request', `${STATUS_TOOL} needs {"taskId": "<id>"}`)
  return (await readJobStatus($, config, taskId)) ?? fail('task_not_found', `no task ${taskId}`)
}

export async function cancelAnswer($: CoreEngine, config: OrqConfig, input: unknown): Promise<TaskCancelResult | Failure> {
  const taskId = taskIdOf(input)
  if (taskId === null) return fail('invalid_request', `${CANCEL_TOOL} needs {"taskId": "<id>"}`)
  const reason = isRecord(input) ? input.reason : undefined
  if (reason !== undefined && (typeof reason !== 'string' || [...reason].length > CANCEL_REASON_MAX)) {
    return fail('invalid_request', `reason must be text of at most ${CANCEL_REASON_MAX} characters`)
  }
  const job = await readMeta($, config.jobsDir, taskId)
  if (!job) return fail('task_not_found', `no task ${taskId}`)
  const status = taskStatusOf(await jobView($, job))
  if (status !== 'running' && status !== 'waiting') {
    return fail('task_not_cancellable', `task ${taskId} is ${status}, so it has nothing left to cancel`)
  }
  await writeCancel($, job, reason)
  return { taskId: job.id, status: 'cancel_requested' }
}

/** One debug line per job in the jobs directory that has no exit file, with its kind and age. */
export async function logUnfinished($: CoreEngine, config: OrqConfig): Promise<void> {
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
