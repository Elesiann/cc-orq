// The tasks of the delegate tool, kept in the jobs directory. A task has the id of its first job, so status, integrate
// and list accept the id that /tasks shows. Its state is derived from files on every request, never held in memory.

import { configCeiling, lowerCeiling, resolveCeiling, sessionCeiling } from '../hooks/ceiling.ts'
import type { OrqConfig } from '../hooks/config.ts'
import {
  FAILURE_CODES,
  INTERACTION_MODES,
  RUNTIME_MODES,
  fail,
  isFailure,
  type Failure,
  type InteractionMode,
  type RuntimeMode,
  type TaskIsolation,
} from '../hooks/contract.ts'
import {
  alreadyAnswered,
  composeAnswer,
  continuationPlan,
  jobView,
  launchContinuation,
  launchTaskFromHeader,
  launchTaskJob,
  newJobId,
  planTaskLaunch,
  readMeta,
  readNext,
  taskStatusOf,
  writeCancel,
  type ContinuationPlan,
  type CoreEngine,
  type JobView,
  type TaskLaunchSpec,
} from '../hooks/engine.ts'
import { renderTail } from '../hooks/event-line.ts'
import { interactionModeRank, runtimeModeRank } from '../hooks/target.ts'
import { TASK_REFUSAL, formatDuration, isRecord, isSafeJobId, type JobRecord } from '../hooks/types.ts'
import {
  TaskNotFound,
  type ClientInfo,
  type Created,
  type DetailedTask,
  type InputRequest,
  type InputResponse,
  type TaskResult,
  type TaskSource,
} from './protocol.ts'
import { QUESTION_MODES, parseAnswerInput, parseDelegateInput } from './tools.ts'

const TASKS_DIR = '.tasks'
const APPROVE = 'approve'
const RESULT_LIMIT_BYTES = 100 * 1024
const EVENTS_TAIL_BYTES = 32768
const JOB_FILES = ['meta.json', 'events.jsonl', 'question.txt', 'last.txt', 'cancel', 'exit']

const HUMAN_REFUSAL =
  'questions: human is not available yet: this version cannot resume a worker with an answer from a form. ' +
  'Leave questions out, and a question the worker asks comes back to you in its result.'

type Modes = { runtimeMode: RuntimeMode; interactionMode: InteractionMode }

type Approval = {
  target: string
  model: string
  cwd: string
  isolation: TaskIsolation
  launch: Modes
  config: Modes
  session: Modes | null
  refusal: Failure
}

const ISOLATIONS: readonly TaskIsolation[] = ['worktree', 'shared']
const TASK_TOOLS = ['delegate', 'answer'] as const

/** `task.json` is written once, before the task is answered, and never changed. */
type TaskRecord = {
  taskId: string
  createdAt: string
  tool: 'delegate' | 'answer'
  questions: (typeof QUESTION_MODES)[number]
  request: Record<string, string>
  toolUseId?: string
  approval?: Approval
}

function parseModes(raw: unknown): Modes | null {
  if (!isRecord(raw)) return null
  const runtimeMode = RUNTIME_MODES.find((mode) => mode === raw.runtimeMode)
  const interactionMode = INTERACTION_MODES.find((mode) => mode === raw.interactionMode)
  return runtimeMode !== undefined && interactionMode !== undefined ? { runtimeMode, interactionMode } : null
}

function parseApproval(raw: unknown): Approval | null {
  if (!isRecord(raw)) return null
  const { target, model, cwd, refusal } = raw
  const isolation = ISOLATIONS.find((candidate) => candidate === raw.isolation)
  const launch = parseModes(raw.launch)
  const config = parseModes(raw.config)
  const session = raw.session === null ? null : parseModes(raw.session)
  if (typeof target !== 'string' || typeof model !== 'string' || typeof cwd !== 'string' || isolation === undefined) return null
  if (launch === null || config === null || (session === null && raw.session !== null) || !isFailure(refusal)) return null
  return { target, model, cwd, isolation, launch, config, session, refusal }
}

function parseRecord(raw: unknown, taskId: string): TaskRecord | null {
  const tool = isRecord(raw) ? TASK_TOOLS.find((candidate) => candidate === raw.tool) : undefined
  if (!isRecord(raw) || raw.taskId !== taskId || tool === undefined) return null
  const { createdAt, questions, request, toolUseId, approval } = raw
  const mode = QUESTION_MODES.find((candidate) => candidate === questions)
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)) || mode === undefined || !isRecord(request)) return null
  const text: Record<string, string> = {}
  for (const [key, value] of Object.entries(request)) {
    if (typeof value !== 'string') return null
    text[key] = value
  }
  const parsedApproval = approval === undefined ? undefined : parseApproval(approval)
  if (parsedApproval === null) return null
  return {
    taskId,
    createdAt,
    tool,
    questions: mode,
    request: text,
    ...(typeof toolUseId === 'string' ? { toolUseId } : {}),
    ...(parsedApproval !== undefined ? { approval: parsedApproval } : {}),
  }
}

type Loaded =
  | { kind: 'job'; job: JobRecord }
  | { kind: 'corrupt' }
  | { kind: 'task'; record: TaskRecord; dir: string; names: ReadonlySet<string> }

type Stage =
  | { kind: 'cancelled' }
  | { kind: 'declined'; refusal: Failure }
  | { kind: 'refused'; text: string }
  | { kind: 'launching' }
  | { kind: 'form'; approval: Approval }
  | { kind: 'job'; job: JobRecord }

const iso = (ms: number): string => new Date(ms).toISOString()
const answerOf = (payload: unknown, isError: boolean): TaskResult => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError })

async function load($: CoreEngine, config: OrqConfig, taskId: string): Promise<Loaded> {
  if (!isSafeJobId(taskId)) throw new TaskNotFound(taskId)
  const dir = `${config.jobsDir}/${TASKS_DIR}/${taskId}`
  if (!(await $.fs.exists(`${dir}/task.json`))) {
    const job = await readMeta($, config.jobsDir, taskId)
    if (job === null) throw new TaskNotFound(taskId)
    return { kind: 'job', job }
  }
  let record: TaskRecord | null
  try {
    record = parseRecord(JSON.parse(await $.fs.read(`${dir}/task.json`)), taskId)
  } catch (err) {
    if (err instanceof SyntaxError) return { kind: 'corrupt' }
    throw err
  }
  if (record === null) return { kind: 'corrupt' }
  const names = new Set((await $.fs.list(dir)).map((entry) => entry.name))
  return { kind: 'task', record, dir, names }
}

async function stageOf($: CoreEngine, config: OrqConfig, loaded: Extract<Loaded, { kind: 'task' }>): Promise<Stage> {
  const { record, dir, names } = loaded
  const { approval } = record
  if (names.has('cancelled')) return { kind: 'cancelled' }
  if (approval !== undefined && names.has('declined')) return { kind: 'declined', refusal: approval.refusal }
  const job = await readMeta($, config.jobsDir, record.taskId)
  if (job !== null) return { kind: 'job', job }
  if (names.has('refused')) return { kind: 'refused', text: await $.fs.read(`${dir}/refused`) }
  if (approval === undefined) throw new TaskNotFound(record.taskId)
  return names.has('approved') ? { kind: 'launching' } : { kind: 'form', approval }
}

async function newest($: CoreEngine, paths: string[], floor: string): Promise<string> {
  const times = await Promise.all(paths.map((path) => $.fs.stat(path).then((info) => info.mtimeMs, () => 0)))
  return iso(Math.max(Date.parse(floor), ...times))
}

async function lastAction($: CoreEngine, dir: string): Promise<string> {
  try {
    const tail = await $.process.run(['tail', '-c', String(EVENTS_TAIL_BYTES), `${dir}/events.jsonl`], { timeoutMs: 15000 })
    return renderTail(tail.exitCode === 0 ? tail.stdout : '', 1)[0] ?? '—'
  } catch {
    return '—'
  }
}

const whoIs = (job: JobRecord): string => `${job.instanceId ?? job.runner ?? job.kind} · ${job.model ?? '?'}`

function capText(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= RESULT_LIMIT_BYTES) return text
  const cut = bytes.subarray(0, RESULT_LIMIT_BYTES).toString('utf8').replace(/\uFFFD$/, '')
  return `${cut}\n\n[cut at 100 KB: the full text is in last.txt and in the answer of the status tool]`
}

const WHERE: Record<TaskIsolation, string> = { worktree: 'in its own worktree', shared: 'in your checkout itself (shared, no worktree)' }
const WHERE_SHORT: Record<TaskIsolation, string> = { worktree: 'in its own worktree', shared: 'in your checkout itself' }

const effectiveOf = (approval: Approval): Modes => (approval.session === null ? approval.config : lowerCeiling(approval.config, approval.session))

/** The model chose this text, so it is quoted, cut and written out, and cannot add text to the question. */
function shown(text: string, limit = 120): string {
  const characters = [...text]
  const cut = characters.length > limit ? `${characters.slice(0, limit).join('')}…` : text
  return JSON.stringify(cut).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`)
}

/** Only a limit below the level is in its way, so only that one is named. */
function limitsBelow<Mode extends string>(level: Mode, key: string, config: Mode, session: Mode | null, rank: (mode: Mode) => number): string {
  return [
    ...(rank(config) < rank(level) ? [`${key} ${config}`] : []),
    ...(session !== null && rank(session) < rank(level) ? [`the session's permission mode ${session}`] : []),
  ].join(' and ')
}

function exceeded(approval: Approval): { level: string; limit: string }[] {
  const effective = effectiveOf(approval)
  const { launch, config, session, isolation } = approval
  return [
    ...(runtimeModeRank(launch.runtimeMode) > runtimeModeRank(effective.runtimeMode)
      ? [{ level: `runtime ${launch.runtimeMode}`, limit: limitsBelow(launch.runtimeMode, isolation === 'shared' ? 'ceiling.sharedRuntime' : 'ceiling.runtime', config.runtimeMode, session?.runtimeMode ?? null, runtimeModeRank) }]
      : []),
    ...(interactionModeRank(launch.interactionMode) > interactionModeRank(effective.interactionMode)
      ? [{ level: `interaction ${launch.interactionMode}`, limit: limitsBelow(launch.interactionMode, 'ceiling.interaction', config.interactionMode, session?.interactionMode ?? null, interactionModeRank) }]
      : []),
  ]
}

/**
 * Claude Code shows the first three lines of the message, collapses the rest, and cuts a field title at about 47
 * characters, so the levels and the place come first and the limits go in the description. Closed lists make the
 * question, apart from three values that the model chose, which `shown` quotes.
 */
function approvalRequest(approval: Approval): InputRequest {
  const above = exceeded(approval)
  return {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: [
        `A task asks for more than your ceiling allows: ${above.map(({ level }) => level).join(' and ')}.`,
        `It runs ${WHERE[approval.isolation]}.`,
        `Worker ${shown(approval.target)}, model ${shown(approval.model)}, directory ${shown(approval.cwd)}.`,
      ].join('\n'),
      requestedSchema: {
        type: 'object',
        properties: {
          [APPROVE]: {
            type: 'boolean',
            title: `Allow ${WHERE_SHORT[approval.isolation]}, this task only`,
            description: `${above.map(({ level, limit }) => `${level} is above ${limit}`).join('; ')}.`,
            default: true,
          },
        },
        required: [APPROVE],
      },
    },
  }
}

async function finishedTask($: CoreEngine, config: OrqConfig, job: JobRecord, view: JobView, base: { createdAt: string; lastUpdatedAt: string }): Promise<DetailedTask> {
  if (view.status === 'running' || view.status === 'cancelling' || view.status === 'waiting') {
    return { ...base, status: 'working', statusMessage: `${whoIs(job)} · ${await lastAction($, job.dir)} · ${formatDuration((await $.clock.now()) - job.startedAt)}` }
  }
  const elapsed = formatDuration((view.endedAt ?? (await $.clock.now())) - job.startedAt)
  if (view.status === 'cancelled') return { ...base, status: 'cancelled', statusMessage: `${whoIs(job)} · cancelled · ${elapsed}` }
  const merge = view.status === 'done' && view.question === null && job.branch !== undefined
  const text = capText(await composeAnswer($, config, job, view)) + (merge ? `\n\nBranch ${job.branch}. Merge it with integrate: {"taskId": "${job.id}"}` : '')
  const word = view.status === 'done' ? (view.question === null ? 'finished' : 'blocked on a question') : view.status
  return {
    ...base,
    status: 'completed',
    statusMessage: `${whoIs(job)} · ${word} · ${elapsed}`,
    result: { content: [{ type: 'text', text }], isError: view.status !== 'done' },
  }
}

async function render($: CoreEngine, config: OrqConfig, loaded: Loaded): Promise<DetailedTask> {
  const now = await $.clock.now()
  if (loaded.kind === 'corrupt') {
    const message = 'the record of this task cannot be read'
    return { status: 'failed', statusMessage: message, error: { code: -32603, message }, createdAt: iso(now), lastUpdatedAt: iso(now) }
  }
  const jobPaths = (job: JobRecord): string[] => JOB_FILES.map((name) => `${job.dir}/${name}`)
  if (loaded.kind === 'job') {
    const { job } = loaded
    const base = { createdAt: job.startedAtIso, lastUpdatedAt: await newest($, jobPaths(job), job.startedAtIso) }
    return finishedTask($, config, job, await jobView($, job), base)
  }
  const { record, dir, names } = loaded
  const stage = await stageOf($, config, loaded)
  const touched = [`${dir}/task.json`, ...[...names].map((name) => `${dir}/${name}`), ...(stage.kind === 'job' ? jobPaths(stage.job) : [])]
  const base = { createdAt: record.createdAt, lastUpdatedAt: await newest($, touched, record.createdAt) }
  switch (stage.kind) {
    case 'cancelled':
      return { ...base, status: 'cancelled', statusMessage: 'cancelled' }
    case 'declined':
      return { ...base, status: 'completed', statusMessage: 'not allowed', result: answerOf(stage.refusal, true) }
    case 'refused':
      return { ...base, status: 'completed', statusMessage: 'could not start', result: { content: [{ type: 'text', text: stage.text }], isError: true } }
    case 'launching':
      return { ...base, status: 'working', statusMessage: 'starting after your approval' }
    case 'form':
      return {
        ...base,
        status: 'input_required',
        statusMessage: 'waiting for your approval to go above the ceiling',
        inputRequests: { [APPROVE]: approvalRequest(stage.approval) },
      }
    case 'job':
      return finishedTask($, config, stage.job, await jobView($, stage.job), base)
  }
}

const REQUEST_PROBLEMS = ['directory does not exist: ', 'not a directory: ']

/** The launch words a refusal as the text the cc-orq:task agent answers, so the code is read back from it. */
async function launchRefusal($: CoreEngine, text: string): Promise<TaskResult> {
  const prefix = `${TASK_REFUSAL}: `
  const body = text.startsWith(prefix) ? text.slice(prefix.length) : text
  const named = /^([a-z_]+): ([\s\S]*)$/.exec(body)
  const code = FAILURE_CODES.find((candidate) => candidate === named?.[1])
  if (code !== undefined && named?.[2] !== undefined) return answerOf(fail(code, named[2]), true)
  if (REQUEST_PROBLEMS.some((start) => body.startsWith(start))) return answerOf(fail('invalid_request', body), true)
  const failure = `orq: delegate failed: ${body}`
  await $.ui.log(failure)
  return { content: [{ type: 'text', text: failure }], isError: true }
}

const CHANGED_SINCE_SHOWN =
  'orq: this task no longer matches what you approved: its worker, model, directory, isolation or modes changed since the form was shown, so it was not started'

const textOf = (result: TaskResult): string => result.content[0]?.text ?? ''

function isWhatWasShown(spec: TaskLaunchSpec, approval: Approval): boolean {
  return (
    spec.instance.id === approval.target &&
    spec.model === approval.model &&
    spec.cwd === approval.cwd &&
    spec.isolation === approval.isolation &&
    spec.runtimeMode === approval.launch.runtimeMode &&
    spec.interactionMode === approval.launch.interactionMode
  )
}

/** The ceiling refusal, said for a worker that is resumed rather than launched: an answer has no level to ask for less. */
function aboveCeilingNow(refusal: Failure, modes: Modes): Failure {
  const level = refusal.error.code === 'interaction_mode_escalation_denied' ? `interaction mode ${modes.interactionMode}` : `runtime mode ${modes.runtimeMode}`
  const message = refusal.error.message.replace(/otherwise ask for [^.]* at most\.$/, 'otherwise delegate the task anew within the ceiling.')
  return fail(refusal.error.code, `the worker ran with ${level}, which is above the ceiling now, so it is not resumed. ${message}`)
}

/** The worker is the one the user was shown, and no more than the level they allowed. */
function withinApproval(approval: Approval, plan: ContinuationPlan): boolean {
  return (
    approval.target === plan.instance.id &&
    approval.model === plan.model &&
    approval.cwd === plan.requestCwd &&
    approval.isolation === plan.isolation &&
    runtimeModeRank(plan.modes.runtimeMode) <= runtimeModeRank(approval.launch.runtimeMode) &&
    interactionModeRank(plan.modes.interactionMode) <= interactionModeRank(approval.launch.interactionMode)
  )
}

/** A launch that did not start, said as the typed code it carries when it names one. */
async function continuationRefusal($: CoreEngine, text: string): Promise<TaskResult> {
  const named = /^orq: mcp refused: ([a-z_]+): ([\s\S]*)$/.exec(text)
  const code = FAILURE_CODES.find((candidate) => candidate === named?.[1])
  if (code !== undefined && named?.[2] !== undefined) return answerOf(fail(code, named[2]), true)
  const failure = `orq: answer failed: ${text}`
  await $.ui.log(failure)
  return { content: [{ type: 'text', text: failure }], isError: true }
}

const widest = <Mode extends string>(asked: Mode | undefined, effective: Mode, rank: (mode: Mode) => number): Mode =>
  asked !== undefined && rank(asked) > rank(effective) ? asked : effective

export function jobTasks($: CoreEngine, getConfig: () => Promise<OrqConfig>): TaskSource {
  const answering = new Set<string>()

  async function agentId(): Promise<string> {
    return (await $.env.get('CLAUDE_CODE_SESSION_ID')) || 'mcp'
  }

  async function sessionDir(): Promise<string> {
    return (await $.env.get('CLAUDE_PROJECT_DIR')) ?? ''
  }

  async function writeRecord(config: OrqConfig, record: TaskRecord): Promise<void> {
    await $.fs.write(`${config.jobsDir}/${TASKS_DIR}/${record.taskId}/task.json`, JSON.stringify(record))
  }

  /**
   * What the user approved in a form for the task this worker belongs to, read from the server's own task records and never
   * from meta.json, which the worker can write. The record of the job names the approval, or, for the task of an answer,
   * the job it answered, and the walk goes on from there. A record without the `approved` marker approves nothing.
   */
  async function approvalOfChain(config: OrqConfig, jobId: string): Promise<Approval | null> {
    let id = jobId
    for (let hops = 0; hops < 64; hops += 1) {
      const dir = `${config.jobsDir}/${TASKS_DIR}/${id}`
      if (!isSafeJobId(id) || !(await $.fs.exists(`${dir}/task.json`))) return null
      let record: TaskRecord | null
      try {
        record = parseRecord(JSON.parse(await $.fs.read(`${dir}/task.json`)), id)
      } catch {
        return null
      }
      if (record === null) return null
      if (record.approval !== undefined) return (await $.fs.exists(`${dir}/approved`)) ? record.approval : null
      if (record.tool !== 'answer') return null
      id = record.request.taskId ?? ''
    }
    return null
  }

  async function answerCreate(args: unknown, client: ClientInfo): Promise<Created> {
    const config = await getConfig()
    const call = parseAnswerInput(args)
    if (isFailure(call)) return { result: answerOf(call, true) }
    const parent = await readMeta($, config.jobsDir, call.taskId)
    if (parent === null) return { result: answerOf(fail('task_not_found', `no task ${call.taskId}`), true) }
    const view = await jobView($, parent)
    if (view.status !== 'done' || view.question === null) {
      return { result: answerOf(fail('invalid_request', `task ${parent.id} has not stopped on a question (it is ${taskStatusOf(view)}), so there is nothing to answer`), true) }
    }
    const next = await readNext($, parent)
    if (next !== null) return { result: answerOf(alreadyAnswered(parent.id, next), true) }
    const planned = await continuationPlan($, config, parent, await sessionDir())
    if ('failure' in planned) return { result: answerOf(planned.failure, true) }
    const { plan } = planned
    const now = await $.clock.now()
    const { refusal } = resolveCeiling({ config: config.ceiling, session: sessionCeiling(call.sessionMode), isolation: plan.isolation, request: plan.modes })
    if (refusal !== null) {
      // As for a launch: above the ceiling, a client with forms asks the user, and any other is refused. An earlier approval counts
      // only when the server recorded it for this chain and the worker is the one it was given for.
      const earlier = await approvalOfChain(config, parent.id)
      if (earlier === null || !withinApproval(earlier, plan)) {
        const above = aboveCeilingNow(refusal, plan.modes)
        if (!client.tasks || !client.forms) return { result: answerOf(above, true) }
        const taskId = newJobId('mcp', now, await agentId())
        const approval: Approval = {
          target: plan.instance.id,
          model: plan.model,
          cwd: plan.requestCwd,
          isolation: plan.isolation,
          launch: plan.modes,
          config: configCeiling(config.ceiling, plan.isolation),
          session: sessionCeiling(call.sessionMode),
          refusal: above,
        }
        await writeRecord(config, {
          taskId,
          createdAt: iso(now),
          tool: 'answer',
          questions: 'parent',
          request: { taskId: parent.id, answer: call.answer },
          approval,
          ...(client.toolUseId !== undefined ? { toolUseId: client.toolUseId } : {}),
        })
        return { taskId }
      }
    }
    const launched = await launchContinuation($, config, plan, { answer: call.answer, via: 'answer', questions: 'parent', agentId: await agentId() })
    if ('failure' in launched) return { result: answerOf(launched.failure, true) }
    if ('refusal' in launched) return { result: await continuationRefusal($, launched.refusal) }
    const taskId = launched.job.id
    const running = { result: answerOf({ taskId, status: 'running' }, false) }
    if (!client.tasks) return running
    try {
      await writeRecord(config, {
        taskId,
        createdAt: iso(now),
        tool: 'answer',
        questions: 'parent',
        request: { taskId: parent.id },
        ...(client.toolUseId !== undefined ? { toolUseId: client.toolUseId } : {}),
      })
    } catch (err) {
      await $.ui.log(`orq: answer started ${taskId} but could not write its task record: ${String(err)}`)
      return running
    }
    return { taskId }
  }

  async function create(args: unknown, client: ClientInfo): Promise<Created> {
    const config = await getConfig()
    const call = parseDelegateInput(args)
    if (isFailure(call)) return { result: answerOf(call, true) }
    if (call.questions === 'human') return { result: answerOf(fail('invalid_request', HUMAN_REFUSAL), true) }
    const { header } = call
    const { effective, refusal } = resolveCeiling({
      config: config.ceiling,
      session: sessionCeiling(call.sessionMode),
      isolation: header.isolation,
      request: { runtimeMode: header.runtimeMode, interactionMode: header.interactionMode },
    })
    const session = await agentId()
    const now = await $.clock.now()
    const record = {
      createdAt: iso(now),
      tool: 'delegate',
      questions: call.questions,
      request: call.request,
      ...(client.toolUseId !== undefined ? { toolUseId: client.toolUseId } : {}),
    } as const
    if (refusal !== null) {
      if (!client.tasks || !client.forms) return { result: answerOf(refusal, true) }
      const grant = {
        runtimeMode: widest(header.runtimeMode, effective.runtimeMode, runtimeModeRank),
        interactionMode: widest(header.interactionMode, effective.interactionMode, interactionModeRank),
      }
      const planned = await planTaskLaunch($, config, { agentId: session, header, ceiling: grant, sessionDir: await sessionDir(), kind: 'mcp', questions: call.questions })
      if ('refusal' in planned) return { result: await launchRefusal($, planned.refusal) }
      const { spec } = planned
      const taskId = newJobId('mcp', now, session)
      const approval: Approval = {
        target: spec.instance.id,
        model: spec.model,
        cwd: spec.cwd,
        isolation: spec.isolation,
        launch: { runtimeMode: spec.runtimeMode, interactionMode: spec.interactionMode },
        config: configCeiling(config.ceiling, spec.isolation),
        session: sessionCeiling(call.sessionMode),
        refusal,
      }
      await writeRecord(config, { ...record, taskId, approval })
      return { taskId }
    }
    const launched = await launchTaskFromHeader($, config, {
      agentId: session,
      header,
      ceiling: effective,
      sessionDir: await sessionDir(),
      kind: 'mcp',
      questions: call.questions,
    })
    if (!('job' in launched)) return { result: await launchRefusal($, launched.refusal) }
    const taskId = launched.job.id
    const running = { result: answerOf({ taskId, status: 'running' }, false) }
    if (!client.tasks) return running
    try {
      await writeRecord(config, { ...record, taskId })
    } catch (err) {
      await $.ui.log(`orq: delegate started ${taskId} but could not write its task record: ${String(err)}`)
      return running
    }
    return { taskId }
  }

  /** The form of a continuation was accepted: the worker resumes under the id the task has, if it is still what the form showed. */
  async function launchApprovedAnswer(config: OrqConfig, loaded: Extract<Loaded, { kind: 'task' }>, approval: Approval): Promise<void> {
    const { record, dir } = loaded
    const refuse = (failure: Failure): Promise<void> => $.fs.write(`${dir}/refused`, JSON.stringify(failure))
    const parent = await readMeta($, config.jobsDir, record.request.taskId ?? '')
    if (parent === null) return refuse(fail('task_not_found', `no task ${record.request.taskId ?? ''}`))
    const planned = await continuationPlan($, config, parent, await sessionDir())
    if ('failure' in planned) return refuse(planned.failure)
    if (!withinApproval(approval, planned.plan)) return refuse(fail('invalid_request', CHANGED_SINCE_SHOWN))
    const launched = await launchContinuation($, config, planned.plan, {
      answer: record.request.answer ?? '',
      via: 'answer',
      questions: 'parent',
      agentId: await agentId(),
      reservedId: record.taskId,
    })
    if ('job' in launched) {
      if (await $.fs.exists(`${dir}/cancelled`)) await writeCancel($, launched.job, 'cancelled while it started')
      return
    }
    if ('failure' in launched) return refuse(launched.failure)
    await $.fs.write(`${dir}/refused`, textOf(await continuationRefusal($, launched.refusal)))
  }

  async function launchApproved(config: OrqConfig, loaded: Extract<Loaded, { kind: 'task' }>, approval: Approval): Promise<void> {
    const { record, dir } = loaded
    const refuse = (text: string): Promise<void> => $.fs.write(`${dir}/refused`, text)
    await $.fs.write(`${dir}/approved`, `${iso(await $.clock.now())}\n`)
    if (record.tool === 'answer') return launchApprovedAnswer(config, loaded, approval)
    const call = parseDelegateInput(record.request)
    if (isFailure(call)) return refuse(JSON.stringify(call))
    const effective = effectiveOf(approval)
    const planned = await planTaskLaunch($, config, {
      agentId: await agentId(),
      header: call.header,
      ceiling: {
        runtimeMode: widest(approval.launch.runtimeMode, effective.runtimeMode, runtimeModeRank),
        interactionMode: widest(approval.launch.interactionMode, effective.interactionMode, interactionModeRank),
      },
      sessionDir: await sessionDir(),
      kind: 'mcp',
      reservedId: record.taskId,
      questions: record.questions,
    })
    if ('refusal' in planned) return refuse(textOf(await launchRefusal($, planned.refusal)))
    if (!isWhatWasShown(planned.spec, approval)) return refuse(JSON.stringify(fail('invalid_request', CHANGED_SINCE_SHOWN)))
    const launched = await launchTaskJob($, config, planned.spec)
    if ('job' in launched) {
      if (await $.fs.exists(`${dir}/cancelled`)) await writeCancel($, launched.job, 'cancelled while it started')
      return
    }
    await refuse(textOf(await launchRefusal($, launched.refusal)))
  }

  async function answerForm(config: OrqConfig, loaded: Extract<Loaded, { kind: 'task' }>, answer: InputResponse): Promise<void> {
    const stage = await stageOf($, config, loaded)
    if (stage.kind !== 'form') return
    if (answer.action === 'accept' && answer.content?.[APPROVE] !== false) await launchApproved(config, loaded, stage.approval)
    else await $.fs.write(`${loaded.dir}/declined`, `${iso(await $.clock.now())}\n`)
  }

  return {
    async create(tool, args, client) {
      if (tool === 'answer') return answerCreate(args, client)
      if (tool !== 'delegate') throw new Error(`orq: no task tool named ${tool}`)
      return create(args, client)
    },

    async get(taskId) {
      const config = await getConfig()
      return render($, config, await load($, config, taskId))
    },

    async update(taskId, responses) {
      const config = await getConfig()
      const loaded = await load($, config, taskId)
      const answer = responses[APPROVE]
      if (loaded.kind !== 'task' || answer === undefined || answering.has(taskId)) return
      answering.add(taskId)
      try {
        await answerForm(config, loaded, answer)
      } finally {
        answering.delete(taskId)
      }
    },

    async cancel(taskId) {
      const config = await getConfig()
      const loaded = await load($, config, taskId)
      if (loaded.kind === 'corrupt') return
      const job = loaded.kind === 'job' ? loaded.job : await readMeta($, config.jobsDir, taskId)
      if (job !== null) {
        const status = taskStatusOf(await jobView($, job))
        if (status === 'running' || status === 'waiting') await writeCancel($, job)
        return
      }
      if (loaded.kind !== 'task') return
      const ended = ['cancelled', 'declined', 'refused'].some((name) => loaded.names.has(name))
      if (loaded.record.approval !== undefined && !ended) await $.fs.write(`${loaded.dir}/cancelled`, `${iso(await $.clock.now())}\n`)
    },
  }
}
