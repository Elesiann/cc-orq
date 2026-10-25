// The part of the MCP protocol that no tool owns: what the client declared on a request, and the tasks/* methods.
// This server serves no task yet, so each tasks/* method answers an error, and which error depends on whether the
// client declared the tasks extension.

import { isRecord } from '../hooks/types.ts'
import type { McpServer, ServerContext } from './vendor/mcp-sdk.mjs'
import { ProtocolError, ProtocolErrorCode, z } from './vendor/mcp-sdk.mjs'

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'

/** What the client behind one request can do, as far as the server's answers depend on it. */
export type ClientInfo = { tasks: boolean; forms: boolean }

/**
 * Reads the client's capabilities from a request envelope. The SDK lifts the envelope out of `_meta` before a handler
 * runs and hands it over as `ctx.mcpReq.envelope`; a request without one, such as the legacy `initialize` handshake,
 * has no tasks and no forms. Tasks are declared by `extensions['io.modelcontextprotocol/tasks']` and forms by
 * `elicitation.form`.
 */
export function clientInfoOf(envelope: unknown): ClientInfo {
  const capabilities = isRecord(envelope) ? envelope[CLIENT_CAPABILITIES_KEY] : undefined
  if (!isRecord(capabilities)) return { tasks: false, forms: false }
  const { extensions, elicitation } = capabilities
  return {
    tasks: isRecord(extensions) && isRecord(extensions[TASKS_EXTENSION]),
    forms: isRecord(elicitation) && isRecord(elicitation.form),
  }
}

const TASK_METHODS = [
  ['tasks/get', 'retrieve'],
  ['tasks/update', 'update'],
  ['tasks/cancel', 'cancel'],
] as const

/**
 * A client that did not declare the extension gets -32021 with the capability it lacks; one that did gets -32602,
 * since no id names a task here. They are handlers of their own, because an error thrown inside a tool callback
 * reaches the client as a tool result with `isError`, not as a JSON-RPC error.
 */
function refuseTask(ctx: ServerContext, verb: string): never {
  if (!clientInfoOf(ctx.mcpReq.envelope).tasks) {
    throw new ProtocolError(ProtocolErrorCode.MissingRequiredClientCapability, 'Missing required client capability', {
      requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
    })
  }
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Failed to ${verb} task: Task not found`)
}

export function registerTaskMethods(mcp: McpServer): void {
  const params = z.object({ taskId: z.string() })
  for (const [method, verb] of TASK_METHODS) {
    mcp.server.setRequestHandler(method, { params }, (_params: unknown, ctx: ServerContext): never => refuseTask(ctx, verb))
  }
}
