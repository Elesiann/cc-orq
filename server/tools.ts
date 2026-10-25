// The six tools of the orq server: capabilities, delegate, status, list, cancel and integrate. Each answers with one
// text block, the JSON that the mod's tools answered in 0.1, and a refusal is the typed `{ error: { code, message } }`
// with `isError`. The answers come from the job core, so the server and the mod read a job the same way.

import { describeCeiling, resolveCeiling, sessionCeiling } from '../hooks/ceiling.ts'
import { loadConfig, type OrqConfig } from '../hooks/config.ts'
import {
  FAILURE_CODES,
  INTEGRATE_DESCRIPTION,
  INTEGRATE_INPUT_SCHEMA,
  INTEGRATE_TOOL,
  INTERACTION_MODES,
  RUNTIME_MODES,
  fail,
  isFailure,
  type Failure,
  type TaskStatus,
} from '../hooks/contract.ts'
import { LIST_LIMIT, jobView, launchTaskFromHeader, listJobs, taskStatusOf, type CoreEngine, type QuestionMode } from '../hooks/engine.ts'
import { integrate, integratePayload, parseIntegrateInput } from '../hooks/integrate.ts'
import { parseTaskHeader, type TaskHeader } from '../hooks/task-header.ts'
import { CANCEL_REASON_MAX, cancelAnswer, capabilitiesAnswer, statusAnswer, type CatalogCache } from '../hooks/tools.ts'
import { isRecord, TASK_REFUSAL } from '../hooks/types.ts'
import { clientInfoOf } from './protocol.ts'
import type { CallToolResult, McpServer, ServerContext, StandardSchemaWithJSON } from './vendor/mcp-sdk.mjs'

const LIST_DEFAULT = 20

const ISOLATIONS = ['worktree', 'shared']
const ROLES = ['implementation', 'research', 'review', 'design', 'test', 'general']
const QUESTION_MODES = ['parent', 'human'] as const satisfies readonly QuestionMode[]
const PROMPT_MAX_CHARS = 200_000

const SESSION_MODE_INPUT = { type: 'string', description: 'Filled by the cc-orq hook; leave it out.' }
const SESSION_MODE_REFUSAL = 'sessionMode must be text; the cc-orq hook fills it, so leave it out'
const CAPABILITIES_INPUT = { type: 'object', properties: { sessionMode: SESSION_MODE_INPUT }, additionalProperties: false }
const DELEGATE_INPUT = {
  type: 'object',
  properties: {
    target: { type: 'string', description: 'The provider instance id, as capabilities lists it.' },
    model: { type: 'string', description: 'A model id of that instance, from capabilities. One word.' },
    effort: { type: 'string', description: 'Reasoning effort, such as high, for a model that has the option.' },
    cwd: {
      type: 'string',
      description: 'Absolute path of the directory to work in: inside the session directory or an allowed root. With isolation worktree it must be inside a git checkout.',
    },
    isolation: {
      type: 'string',
      enum: ISOLATIONS,
      description: 'worktree (default): its own git worktree on a new branch. shared: runs in cwd as it is, for a task that edits nothing.',
    },
    role: { type: 'string', enum: ROLES, description: 'The role the worker is asked to act as. general adds nothing to the prompt.' },
    runtime: {
      type: 'string',
      enum: [...RUNTIME_MODES],
      description: 'What the worker may do, at most the ceiling that capabilities reports. Leave it out to get the ceiling.',
    },
    interaction: {
      type: 'string',
      enum: [...INTERACTION_MODES],
      description: 'default, or plan to have the worker plan and not act. At most the ceiling; leave it out to get the ceiling.',
    },
    questions: {
      type: 'string',
      enum: [...QUESTION_MODES],
      description: 'Who answers a question the worker asks. parent (default): the job ends with BLOCKED in its result, for you to answer. human is not available yet.',
    },
    prompt: {
      type: 'string',
      maxLength: PROMPT_MAX_CHARS,
      description:
        'The whole brief, at most 200,000 characters: the worker has no history, so give the goal, the files it may touch and the check that shows it worked.',
    },
    sessionMode: SESSION_MODE_INPUT,
  },
  required: ['target', 'model', 'cwd', 'prompt'],
  additionalProperties: false,
}
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
  'runtimeMode and interactionMode are the most that a task in its own worktree, the default isolation, may run as: ' +
  'the lower of the config ceiling and the session permission mode. ' +
  'ceiling shows both limits, the effective ceiling of a worktree task and of a shared one, and a warning for a config value that is not valid; ' +
  'client says whether this client gets tasks and forms. ' +
  'Read it before you name a target in a task brief, and do not guess model ids. Takes no input; sessionMode is filled by the cc-orq hook, so leave it out.'
const DELEGATE_DESCRIPTION =
  'Start one orq job: a Codex, OpenCode, Antigravity or Claude CLI working on one self-contained task in the background. ' +
  'The answer comes at once, as {"taskId", "status": "running"}; read the job with status until it ends. ' +
  'The worker has no history, so the prompt carries the whole brief, at most 200,000 characters. ' +
  'isolation worktree, the default, gives the worker its own git worktree on a new branch: tell it to commit, because integrate merges commits only. ' +
  'The worker runs at most as broad as the ceiling that capabilities reports, the lower of the config ceiling and the session permission mode. ' +
  'runtime and interaction ask for less; a request above the ceiling is refused with runtime_mode_escalation_denied or interaction_mode_escalation_denied, and the refusal says how to lift it. ' +
  'questions parent, the default, ends a job that asks a question with BLOCKED in its result; questions human is not available yet. ' +
  'Input: {"target", "model", "cwd", "prompt"}, and optionally effort, isolation, role, runtime, interaction and questions.'
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
function guarded($: CoreEngine, name: string, answer: (input: unknown, ctx: ServerContext) => Promise<CallToolResult>) {
  return async (input: unknown, ctx: ServerContext): Promise<CallToolResult> => {
    try {
      return await answer(input, ctx)
    } catch (err) {
      return failed($, name, err)
    }
  }
}

/** The answer of a tool that refuses with a typed failure: the failure is the text, and `isError` marks it. */
const reply = (answer: object): CallToolResult => textResult(answer, isFailure(answer))

/** Absent, or the text the hook put there. Anything else is refused, since only the hook sets it. */
function sessionModeOf(input: unknown): string | undefined | Failure {
  const value = isRecord(input) ? input.sessionMode : undefined
  return value === undefined || typeof value === 'string' ? value : fail('invalid_request', SESSION_MODE_REFUSAL)
}

const DELEGATE_FIELDS = ['target', 'model', 'effort', 'cwd', 'isolation', 'role', 'runtime', 'interaction', 'questions', 'prompt'] as const
/** The fields on the `target:` line, where a space would start another word. */
const ONE_WORD_FIELDS = ['target', 'model', 'effort', 'runtime', 'interaction'] as const
/** The other header fields, where a line break would start another line. */
const ONE_LINE_FIELDS = ['cwd', 'isolation', 'role'] as const

const HUMAN_REFUSAL =
  'questions: human is not available yet: it needs a client with MCP tasks and form input, which this server does not offer. ' +
  'Leave questions out, and a question the worker asks comes back to you in its result.'

/**
 * The header a cc-orq:task prompt would carry for these fields, so that the header parser holds each field to its rules
 * and a mistake gets the same message. A blank line ends the header, so the prompt is never read as a header line.
 */
function headerText(text: Record<string, string>): string {
  const words = [text.target, text.model].filter((word): word is string => word !== undefined)
  for (const key of ['effort', 'runtime', 'interaction'] as const) {
    if (text[key] !== undefined) words.push(`${key}=${text[key]}`)
  }
  const lines = [
    ...(words.length > 0 ? [`target: ${words.join(' ')}`] : []),
    ...(text.cwd !== undefined ? [`cwd: ${text.cwd}`] : []),
    ...(text.isolation !== undefined ? [`isolation: ${text.isolation}`] : []),
    ...(text.role !== undefined ? [`role: ${text.role}`] : []),
  ]
  return `${lines.join('\n')}\n\n${text.prompt ?? ''}`
}

/** Characters as the schema's maxLength counts them: code points, so an emoji is one. */
function characterCount(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

type DelegateCall = { header: TaskHeader; questions: QuestionMode; sessionMode: string | undefined }

function parseDelegateInput(input: unknown): DelegateCall | Failure {
  if (!isRecord(input)) {
    return fail('invalid_request', 'delegate needs {"target": "<instance>", "model": "<model>", "cwd": "/absolute/path", "prompt": "<the whole brief>"}')
  }
  for (const key of Object.keys(input)) {
    if (key !== 'sessionMode' && !DELEGATE_FIELDS.some((field) => field === key)) {
      return fail('invalid_request', `delegate has no field "${key}"; its fields are ${DELEGATE_FIELDS.join(', ')}`)
    }
  }
  const text: Record<string, string> = {}
  for (const key of [...DELEGATE_FIELDS, 'sessionMode']) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== 'string') return fail('invalid_request', key === 'sessionMode' ? SESSION_MODE_REFUSAL : `${key} must be text`)
    text[key] = value
  }
  const promptLength = characterCount(text.prompt ?? '')
  if (promptLength > PROMPT_MAX_CHARS) return fail('invalid_request', `prompt must be at most ${PROMPT_MAX_CHARS} characters, got ${promptLength}`)
  for (const key of ONE_WORD_FIELDS) {
    if (/\s/.test(text[key] ?? '')) return fail('invalid_request', `${key} must be one word, without spaces or line breaks`)
  }
  for (const key of ONE_LINE_FIELDS) {
    if (/[\r\n]/.test(text[key] ?? '')) return fail('invalid_request', `${key} must be on one line`)
  }
  const header = parseTaskHeader(headerText(text))
  if (isFailure(header)) return header
  const questions = QUESTION_MODES.find((mode) => mode === (text.questions ?? 'parent'))
  if (questions === undefined) return fail('invalid_request', `questions must be one of: ${QUESTION_MODES.join(', ')}.`)
  return { header, questions, sessionMode: text.sessionMode }
}

/** Launch refusals that name no code and are the caller's to fix. */
const REQUEST_PROBLEMS = ['directory does not exist: ', 'not a directory: ']

/** The launch words a refusal as the text the cc-orq:task agent answers, so the code is read back from it. */
async function launchRefusal($: CoreEngine, text: string): Promise<CallToolResult> {
  const prefix = `${TASK_REFUSAL}: `
  const body = text.startsWith(prefix) ? text.slice(prefix.length) : text
  const named = /^([a-z_]+): ([\s\S]*)$/.exec(body)
  const code = FAILURE_CODES.find((candidate) => candidate === named?.[1])
  if (code !== undefined && named?.[2] !== undefined) return reply(fail(code, named[2]))
  if (REQUEST_PROBLEMS.some((start) => body.startsWith(start))) return reply(fail('invalid_request', body))
  const failure = `orq: delegate failed: ${body}`
  await $.ui.log(failure)
  return { content: [{ type: 'text', text: failure }], isError: true }
}

/** The job is of kind mcp, and belongs to the session that the environment names, or to mcp without one. */
async function delegateAnswer($: CoreEngine, config: OrqConfig, input: unknown): Promise<CallToolResult> {
  const call = parseDelegateInput(input)
  if (isFailure(call)) return reply(call)
  if (call.questions === 'human') return reply(fail('invalid_request', HUMAN_REFUSAL))
  const { header } = call
  const { effective, refusal } = resolveCeiling({
    config: config.ceiling,
    session: sessionCeiling(call.sessionMode),
    isolation: header.isolation,
    request: { runtimeMode: header.runtimeMode, interactionMode: header.interactionMode },
  })
  if (refusal !== null) return reply(refusal)
  const launched = await launchTaskFromHeader($, config, {
    agentId: (await $.env.get('CLAUDE_CODE_SESSION_ID')) || 'mcp',
    header,
    ceiling: effective,
    sessionDir: (await $.env.get('CLAUDE_PROJECT_DIR')) ?? '',
    kind: 'mcp',
    questions: call.questions,
  })
  if ('job' in launched) return textResult({ taskId: launched.job.id, status: 'running' }, false)
  return launchRefusal($, launched.refusal)
}

export function registerTools(mcp: McpServer, $: CoreEngine, catalog: CatalogCache): void {
  mcp.registerTool(
    'capabilities',
    { description: CAPABILITIES_DESCRIPTION, inputSchema: advertise(CAPABILITIES_INPUT) },
    guarded($, 'capabilities', async (input, ctx) => {
      const sessionMode = sessionModeOf(input)
      if (isFailure(sessionMode)) return reply(sessionMode)
      const config = await configOf($)
      const ceiling = describeCeiling(config.ceiling, sessionMode)
      const answer = await capabilitiesAnswer($, config, ceiling.effective.worktree, catalog)
      return textResult({ ...answer, ceiling, client: clientInfoOf(ctx.mcpReq.envelope) }, false)
    }),
  )
  mcp.registerTool(
    'delegate',
    { description: DELEGATE_DESCRIPTION, inputSchema: advertise(DELEGATE_INPUT) },
    guarded($, 'delegate', async (input) => delegateAnswer($, await configOf($), input)),
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
      const payload = integratePayload('failure' in parsed ? parsed : await integrate($, (await configOf($)).jobsDir, parsed.input))
      return textResult(payload, !payload.ok)
    }),
  )
}
