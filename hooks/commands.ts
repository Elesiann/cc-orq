import type { EngineInterface, On } from 'claude-code'

import { loadConfig } from './config.ts'
import type { OrqConfig } from './config.ts'
import {
  composeAnswer,
  jobView,
  launchJob,
  listJobs,
  parseLaunch,
  readMeta,
  writeCancel,
  type Engine,
  type JobView,
} from './engine.ts'
import { QUESTION_PROTOCOL } from './question.ts'
import { DRIVER_RUNNER, formatDuration, renderTable, type JobRecord, type TableRow } from './types.ts'

const USAGE = 'orq: usage: /orq list | /orq result JOB_ID | /orq cancel JOB_ID | /orq launch [--worktree] INSTANCE MODEL -- PROMPT'

/** Declare /orq in the typeahead. Called from session.start. */
export async function registerOrqCommand($: Pick<EngineInterface, 'command'>): Promise<void> {
  await $.command.register({
    name: 'orq',
    description: 'List, show, cancel or launch detached jobs',
    argumentHint: 'list | result JOB_ID | cancel JOB_ID | launch [--worktree] INSTANCE MODEL -- PROMPT',
  })
}

async function resultText($: Engine, config: OrqConfig, id: string): Promise<string> {
  const job = await readMeta($, config.jobsDir, id)
  if (!job) return `orq: unknown job ${id || '(missing)'}`
  return composeAnswer($, config, job)
}

function elapsedText(job: JobRecord, view: JobView, now: number): string {
  if (view.endedAt !== null) return formatDuration(view.endedAt - job.startedAt)
  if (view.status === 'running' || view.status === 'cancelling' || view.status === 'waiting') {
    return formatDuration(now - job.startedAt)
  }
  return '—'
}

function originText(job: JobRecord): string {
  if (job.parent !== undefined) return `↳ ${job.parent}`
  switch (job.kind) {
    case 'mcp':
      return 'delegate'
    case 'task':
      return 'agent'
    default:
      return 'manual'
  }
}

async function listText($: Engine, config: OrqConfig): Promise<string> {
  const jobs = await listJobs($, config.jobsDir)
  if (jobs.length === 0) return 'orq: no jobs yet'
  const now = await $.clock.now()
  const rows: TableRow[] = await Promise.all(
    jobs.map(async (job) => {
      const view = await jobView($, job)
      return {
        id: job.id,
        kind: job.kind,
        status: view.status,
        elapsed: elapsedText(job, view, now),
        origin: originText(job),
        cwd: job.cwd,
      }
    }),
  )
  return renderTable(rows)
}

async function cancelText($: Engine, config: OrqConfig, id: string): Promise<string> {
  const job = await readMeta($, config.jobsDir, id)
  if (!job) return `orq: unknown job ${id || '(missing)'}`
  const { status } = await jobView($, job)
  if (status === 'interrupted') return `orq: ${job.id} has no live supervisor; nothing to cancel`
  if (status === 'done' || status === 'failed' || status === 'cancelled') {
    return `orq: ${job.id} already finished (${status})`
  }
  await writeCancel($, job)
  return `orq: cancel requested for ${job.id}`
}

async function launchText($: Engine, config: OrqConfig, rest: string): Promise<string> {
  const parsed = parseLaunch(rest)
  if ('error' in parsed) return `orq: ${parsed.error}`
  const instance = config.instances.find((i) => i.id === parsed.instance)
  if (!instance) {
    const known = config.instances.map((i) => i.id).join(', ')
    return `orq: unknown instance ${parsed.instance} (configured: ${known})`
  }
  const result = await launchJob($, config, {
    kind: 'manual',
    agentId: 'manual',
    runner: DRIVER_RUNNER[instance.driver],
    model: parsed.model,
    cwd: await $.session.cwd(),
    prompt: `${parsed.prompt}\n\n${QUESTION_PROTOCOL}`,
    env: instance.env ?? {},
    instanceId: instance.id,
    driver: instance.driver,
    ...(parsed.worktree ? { isolation: 'worktree' as const } : {}),
  })
  return 'refusal' in result ? result.refusal : `orq: launched ${result.job.id}`
}

/** Dispatch the text after `/orq`. Every answer is one line or a table. */
export async function runOrq($: Engine, config: OrqConfig, args: string): Promise<string> {
  const m = /^(\S*)\s*([\s\S]*)$/.exec(args.trim())
  const sub = m?.[1] ?? ''
  const rest = m?.[2] ?? ''
  switch (sub) {
    case 'list':
      return listText($, config)
    case 'result':
      return resultText($, config, rest.trim())
    case 'cancel':
      return cancelText($, config, rest.trim())
    case 'launch':
      return launchText($, config, rest)
    default:
      return USAGE
  }
}

export function registerEngine(on: On): void {
  on('command.run', { command: 'orq' }, async ($, e) => {
    try {
      const { config, warning } = await loadConfig($)
      if (warning) await $.ui.log(`orq: ${warning}`, { to: 'debug' })
      return { text: await runOrq($, config, e.args) }
    } catch (err) {
      await $.ui.log(`orq: /orq failed: ${String(err)}`, { to: 'debug' })
      return { text: `orq: /orq failed: ${String(err)}` }
    }
  })
}
