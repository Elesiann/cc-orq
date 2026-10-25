// What the client declared on a request, the tasks/* methods, and the answer of a tool that returns a task. A TaskSource
// owns the tasks themselves, so nothing here knows a job.

import { isRecord } from '../hooks/types.ts'
import type { CallToolResult, McpServer, ServerContext } from './vendor/mcp-sdk.mjs'
import { ProtocolError, ProtocolErrorCode, z } from './vendor/mcp-sdk.mjs'

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'
const TOOL_USE_ID_KEY = 'claudecode/toolUseId'

export const POLL_INTERVAL_MS = 2000

export type ClientInfo = { tasks: boolean; forms: boolean; toolUseId?: string }

/**
 * The SDK lifts the envelope out of `_meta` and hands it over as `ctx.mcpReq.envelope`; a request without one, such as
 * the legacy `initialize` handshake, has no tasks and no forms. An `elicitation` capability with no mode is form mode
 * (MCP 2026-07-28, client/elicitation).
 */
export function clientInfoOf(envelope: unknown): ClientInfo {
  const capabilities = isRecord(envelope) ? envelope[CLIENT_CAPABILITIES_KEY] : undefined
  if (!isRecord(capabilities)) return { tasks: false, forms: false }
  const { extensions, elicitation } = capabilities
  return {
    tasks: isRecord(extensions) && isRecord(extensions[TASKS_EXTENSION]),
    forms: isRecord(elicitation) && (isRecord(elicitation.form) || Object.keys(elicitation).length === 0),
  }
}

export type TaskResult = { content: { type: 'text'; text: string }[]; isError: boolean }
export type InputRequest = { method: 'elicitation/create'; params: Record<string, unknown> }
export type TaskError = { code: number; message: string }

export type DetailedTask = { statusMessage?: string; createdAt: string; lastUpdatedAt: string } & (
  | { status: 'working' }
  | { status: 'input_required'; inputRequests: Record<string, InputRequest> }
  | { status: 'completed'; result: TaskResult }
  | { status: 'failed'; error: TaskError }
  | { status: 'cancelled' }
)

export type InputResponse = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }

export type Created = { result: TaskResult } | { taskId: string }

export class TaskNotFound extends Error {
  constructor(taskId: string) {
    super(`no task ${taskId}`)
  }
}

export interface TaskSource {
  /** A `taskId` goes only to a client that declared tasks, and `get` answers it by then: the task is already on disk. */
  create(tool: string, args: unknown, client: ClientInfo): Promise<Created>
  /** Throws TaskNotFound for an id it does not know. */
  get(taskId: string): Promise<DetailedTask>
  /** Responses to keys that are not outstanding are ignored. */
  update(taskId: string, responses: Record<string, InputResponse>): Promise<void>
  /** Cancelling a task that has ended, or that is already cancelling, changes nothing. */
  cancel(taskId: string): Promise<void>
}

function toolUseIdOf(meta: unknown): { toolUseId: string } | Record<string, never> {
  const id = isRecord(meta) ? meta[TOOL_USE_ID_KEY] : undefined
  return typeof id === 'string' && id !== '' ? { toolUseId: id } : {}
}

/** A task is created `working`, as the published state diagram has it; the first tasks/get answers the state it is in. */
function createTaskResult(taskId: string, task: DetailedTask): CallToolResult {
  return {
    resultType: 'task',
    taskId,
    status: 'working',
    ...(task.statusMessage !== undefined ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: null,
    pollIntervalMs: POLL_INTERVAL_MS,
    content: [],
  }
}

export function taskTool(source: TaskSource, tool: string) {
  return async (input: unknown, ctx: ServerContext): Promise<CallToolResult> => {
    const client: ClientInfo = { ...clientInfoOf(ctx.mcpReq.envelope), ...toolUseIdOf(ctx.mcpReq._meta) }
    const created = await source.create(tool, input, client)
    if ('taskId' in created) return createTaskResult(created.taskId, await source.get(created.taskId))
    const { content, isError } = created.result
    return { content, ...(isError ? { isError: true } : {}) }
  }
}

function inputResponseOf(entry: unknown): InputResponse | null {
  if (!isRecord(entry)) return null
  const { action, content } = entry
  if (action !== 'accept' && action !== 'decline' && action !== 'cancel') return null
  if (content === undefined) return { action }
  return isRecord(content) ? { action, content } : null
}

/** The SDK lifts the answers out of the params of tasks/update into `ctx.mcpReq.inputResponses`. */
function inputResponsesOf(ctx: ServerContext): Record<string, InputResponse> {
  const responses: Record<string, InputResponse> = {}
  for (const [key, entry] of Object.entries(ctx.mcpReq.inputResponses ?? {})) {
    const response = inputResponseOf(entry)
    if (response !== null) responses[key] = response
  }
  return responses
}

/** The capability is checked before the id, so a request without it gets -32021 even for an unknown id. */
function requireTasks(ctx: ServerContext): void {
  if (clientInfoOf(ctx.mcpReq.envelope).tasks) return
  throw new ProtocolError(ProtocolErrorCode.MissingRequiredClientCapability, 'Missing required client capability', {
    requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
  })
}

/** Claude Code reads any -32602 as an unknown task and asks again for five minutes, so the code answers nothing else. */
async function readingTask<T>(verb: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof ProtocolError) throw err
    if (err instanceof TaskNotFound) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Failed to ${verb} task: Task not found`)
    throw new ProtocolError(ProtocolErrorCode.InternalError, `Failed to ${verb} task: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** tasks/result and tasks/list have no handler, so the SDK answers them with -32601, as the extension requires. */
export function registerTaskMethods(mcp: McpServer, source: TaskSource): void {
  const params = z.object({ taskId: z.string() })
  mcp.server.setRequestHandler('tasks/get', { params }, async ({ taskId }, ctx) => {
    requireTasks(ctx)
    const task = await readingTask('retrieve', () => source.get(taskId))
    return { taskId, ...task, ttlMs: null, pollIntervalMs: POLL_INTERVAL_MS }
  })
  mcp.server.setRequestHandler('tasks/update', { params }, async ({ taskId }, ctx) => {
    requireTasks(ctx)
    await readingTask('update', () => source.update(taskId, inputResponsesOf(ctx)))
    return {}
  })
  mcp.server.setRequestHandler('tasks/cancel', { params }, async ({ taskId }, ctx) => {
    requireTasks(ctx)
    await readingTask('cancel', () => source.cancel(taskId))
    return {}
  })
}
