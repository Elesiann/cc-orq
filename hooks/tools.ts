// The three MCP tools of the orq mod: capabilities, status and cancel. Each is served by a
// `tool.call` hook on its full name. A tool answers with a JSON string; a refusal is a typed
// failure, `{ error: { code, message } }`, so the model can branch on the code.

import type { EngineInterface, On } from 'claude-code'

import type { Failure, FailureCode, TaskCancelResult } from './contract.ts'
import { loadConfig, type OrqConfig } from './config.ts'
import { jobView, readJobStatus, readMeta, taskStatusOf, writeCancel } from './engine.ts'
import { isRecord } from './types.ts'

export const STATUS_TOOL = 'mcp__orq__status'
export const CANCEL_TOOL = 'mcp__orq__cancel'

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

/** Declares the status and cancel tools' hooks. The tools themselves are declared at session.start. */
export function registerTools(on: On): void {
  on('tool.call', { tool: STATUS_TOOL }, async ($, e) => statusAnswer($, e))
  on('tool.call', { tool: CANCEL_TOOL }, async ($, e) => cancelAnswer($, e))
}
