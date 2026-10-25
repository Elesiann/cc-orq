// The five tools of the orq server: capabilities, status, list, cancel and integrate. Each answers with one text
// block, the JSON that the mod's tools answered in 0.1, and a refusal is the typed `{ error: { code, message } }`
// with `isError`. The answers come from the job core, so the server and the mod read a job the same way.

import { loadConfig, type OrqConfig } from '../hooks/config.ts'
import {
  INTEGRATE_DESCRIPTION,
  INTEGRATE_INPUT_SCHEMA,
  INTEGRATE_TOOL,
  fail,
  isFailure,
  type Failure,
  type TaskStatus,
} from '../hooks/contract.ts'
import { LIST_LIMIT, jobView, listJobs, taskStatusOf, type CoreEngine } from '../hooks/engine.ts'
import { integrate, integratePayload, parseIntegrateInput } from '../hooks/integrate.ts'
import { parentRuntimeModeFromPermissionMode } from '../hooks/target.ts'
import { CANCEL_REASON_MAX, cancelAnswer, capabilitiesAnswer, statusAnswer, type CatalogCache } from '../hooks/tools.ts'
import { isRecord } from '../hooks/types.ts'
import { nodeEngine } from './node-engine.ts'
import type { CallToolResult, McpServer, StandardSchemaWithJSON } from './vendor/mcp-sdk.mjs'

const LIST_DEFAULT = 20

const NO_INPUT = { type: 'object', properties: {}, required: [], additionalProperties: false }
const TASK_ID_INPUT = {
  type: 'object',
  properties: { taskId: { type: 'string' } },
  required: ['taskId'],
  additionalProperties: false,
}
const CANCEL_INPUT = {
  type: 'object',
  properties: { taskId: { type: 'string' }, reason: { type: 'string', maxLength: CANCEL_REASON_MAX } },
  required: ['taskId'],
  additionalProperties: false,
}
const LIST_INPUT = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: LIST_LIMIT,
      description: `How many jobs to list, from 1 to ${LIST_LIMIT}. Default ${LIST_DEFAULT}.`,
    },
  },
  additionalProperties: false,
}

const CAPABILITIES_DESCRIPTION =
  'List the orq provider instances (as configured in the instances list) with their live models from the catalog probe, ' +
  "each model's options and allowed values (such as reasoningEffort), and each instance's constraints. " +
  'runtimeMode and interactionMode are the most that orq grants a task while it does not know the permission mode of the session: ' +
  'approval-required and default. They do not follow the session yet. ' +
  'Read it before you name a target in a task brief, and do not guess model ids. Takes no input.'
const STATUS_DESCRIPTION =
  "Read one orq task's state from its job directory: status (queued, running, waiting, completed, failed, cancelled or interrupted), " +
  'workState (working or result_available), and once it has ended its result or error; a task blocked on a question has the BLOCKED text as its result. ' +
  'Input: {"taskId": "<id>"}. Works for tasks of earlier sessions. An unknown id answers task_not_found.'
const LIST_DESCRIPTION =
  'List orq jobs, newest first, whoever started them: a cc-orq:task agent, /orq launch, or an earlier session. ' +
  `Input: {"limit": <1 to ${LIST_LIMIT}, default ${LIST_DEFAULT}>}. The answer is {"jobs": [...]}, and each job has taskId, ` +
  'status (as in the status tool), kind, instanceId, model, startedAt (ISO text), durationMs (null for an interrupted job), cwd, ' +
  'branch (null without a worktree), parent (null) and question (true when the job ended blocked on a question). ' +
  'Pass a taskId to status for the result of a job.'
const CANCEL_DESCRIPTION =
  `Cancel a running or waiting orq task. Input: {"taskId": "<id>", "reason": "<optional, up to ${CANCEL_REASON_MAX} characters>"}. ` +
  'A running or waiting task answers cancel_requested and ends as cancelled once its supervisor stops it. ' +
  'A task that has already ended answers task_not_cancellable, and nothing is written.'

/**
 * A schema that advertises JSON Schema in tools/list and accepts every input. The handler checks its input and
 * refuses with the typed `invalid_request` that the tools have always answered, where the SDK would answer with
 * a text of its own.
 */
function advertise(schema: Record<string, unknown>): StandardSchemaWithJSON {
  return {
    '~standard': {
      version: 1,
      vendor: 'cc-orq',
      validate: (value) => ({ value }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  }
}

function textResult(payload: unknown, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) }
}

/** What a tool call fails with when it throws: the SDK would send the bare message, so the text names the tool. */
async function failed($: CoreEngine, tool: string, err: unknown): Promise<CallToolResult> {
  const text = `orq: ${tool} failed: ${String(err)}`
  await $.ui.log(text)
  return { content: [{ type: 'text', text }], isError: true }
}

async function configOf($: CoreEngine): Promise<OrqConfig> {
  const { config, warning } = await loadConfig($)
  if (warning) await $.ui.log(`orq: ${warning}`)
  return config
}

/** The `limit` of a list call: absent means the default, anything but a whole number from 1 to the maximum is refused. */
function parseListInput(input: unknown): { limit: number } | Failure {
  const refusal = fail('invalid_request', `limit must be a whole number from 1 to ${LIST_LIMIT}`)
  if (!isRecord(input)) return refusal
  const { limit } = input
  if (limit === undefined) return { limit: LIST_DEFAULT }
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= LIST_LIMIT ? { limit } : refusal
}

/** The exit file's mtime has sub-millisecond digits, and a duration in whole milliseconds is easier to read. */
const whole = (ms: number): number => Math.max(0, Math.round(ms))

export type JobRow = {
  taskId: string
  status: TaskStatus
  kind: string
  instanceId: string | null
  model: string | null
  startedAt: string
  durationMs: number | null
  cwd: string
  branch: string | null
  parent: null
  question: boolean
}

/**
 * The newest jobs, as many as `limit` asks. Every job's meta is read to find the newest, and the liveness of a job
 * is checked only for the rows that are returned.
 */
async function listAnswer($: CoreEngine, config: OrqConfig, input: unknown): Promise<{ jobs: JobRow[] } | Failure> {
  const parsed = parseListInput(input)
  if (isFailure(parsed)) return parsed
  const jobs = (await listJobs($, config.jobsDir)).slice(0, parsed.limit)
  const now = await $.clock.now()
  const rows = await Promise.all(
    jobs.map(async (job): Promise<JobRow> => {
      const view = await jobView($, job)
      const status = taskStatusOf(view)
      const running = status === 'running' || status === 'waiting'
      return {
        taskId: job.id,
        status,
        kind: job.kind,
        instanceId: job.instanceId ?? null,
        model: job.model ?? null,
        startedAt: job.startedAtIso,
        durationMs: view.endedAt !== null ? whole(view.endedAt - job.startedAt) : running ? whole(now - job.startedAt) : null,
        cwd: job.cwd,
        branch: job.branch ?? null,
        parent: null,
        question: 'question' in view && view.question !== null,
      }
    }),
  )
  return { jobs: rows }
}

/** A tool callback that answers a failure naming the tool when its body throws. */
function guarded($: CoreEngine, name: string, answer: (input: unknown) => Promise<CallToolResult>) {
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      return await answer(input)
    } catch (err) {
      return failed($, name, err)
    }
  }
}

/** The answer of a tool that refuses with a typed failure: the failure is the text, and `isError` marks it. */
const reply = (answer: object): CallToolResult => textResult(answer, isFailure(answer))

export function registerTools(mcp: McpServer, $: CoreEngine, catalog: CatalogCache): void {
  const modes = parentRuntimeModeFromPermissionMode(undefined)

  mcp.registerTool(
    'capabilities',
    { description: CAPABILITIES_DESCRIPTION, inputSchema: advertise(NO_INPUT) },
    guarded($, 'capabilities', async () => textResult(await capabilitiesAnswer($, await configOf($), modes, catalog), false)),
  )
  mcp.registerTool(
    'status',
    { description: STATUS_DESCRIPTION, inputSchema: advertise(TASK_ID_INPUT) },
    guarded($, 'status', async (input) => reply(await statusAnswer($, await configOf($), input))),
  )
  mcp.registerTool(
    'list',
    { description: LIST_DESCRIPTION, inputSchema: advertise(LIST_INPUT) },
    guarded($, 'list', async (input) => reply(await listAnswer($, await configOf($), input))),
  )
  mcp.registerTool(
    'cancel',
    { description: CANCEL_DESCRIPTION, inputSchema: advertise(CANCEL_INPUT) },
    guarded($, 'cancel', async (input) => reply(await cancelAnswer($, await configOf($), input))),
  )
  mcp.registerTool(
    INTEGRATE_TOOL,
    { description: INTEGRATE_DESCRIPTION, inputSchema: advertise(INTEGRATE_INPUT_SCHEMA) },
    guarded($, INTEGRATE_TOOL, async (input) => {
      const parsed = parseIntegrateInput(input)
      if ('failure' in parsed) return textResult(integratePayload(parsed), true)
      const config = await configOf($)
      const { gitHooks } = config.integrate
      const engine = gitHooks === 'run' ? nodeEngine({ pluginRoot: $.plugin.root, gitHooks: 'repository' }) : $
      const payload = integratePayload(await integrate(engine, config.jobsDir, parsed.input, gitHooks))
      return textResult(payload, !payload.ok)
    }),
  )
}
