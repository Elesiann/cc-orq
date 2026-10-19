import type { EngineInterface, On } from 'claude-code'

import { loadConfig } from './config.ts'
import type { OrqConfig } from './config.ts'
import { jobStatus, launchJob, listJobs, parseLaunch, readMeta, writeCancel, type Engine } from './engine.ts'
import { DRIVER_RUNNER, formatDuration, renderTable, type TableRow } from './types.ts'

const USAGE = 'orq: usage: /orq list | /orq cancel JOB_ID | /orq launch INSTANCE MODEL -- PROMPT'

/** Declare /orq in the typeahead. Called from session.start. */
export async function registerOrqCommand($: Pick<EngineInterface, 'command'>): Promise<void> {
  await $.command.register({
    name: 'orq',
    description: 'List, launch or cancel detached jobs',
    argumentHint: 'list | cancel JOB_ID | launch INSTANCE MODEL -- PROMPT',
  })
}

async function listText($: Engine, config: OrqConfig): Promise<string> {
  const jobs = await listJobs($, config.jobsDir)
  if (jobs.length === 0) return 'orq: no jobs yet'
  const now = await $.clock.now()
  const rows: TableRow[] = await Promise.all(
    jobs.map(async (job) => ({
      id: job.id,
      kind: job.kind,
      status: await jobStatus($, job),
      elapsed: formatDuration(now - job.startedAt),
      cwd: job.cwd,
    })),
  )
  return renderTable(rows)
}

async function cancelText($: Engine, config: OrqConfig, id: string): Promise<string> {
  const job = await readMeta($, config.jobsDir, id)
  if (!job) return `orq: unknown job ${id || '(missing)'}`
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
    prompt: parsed.prompt,
    env: instance.env ?? {},
    instanceId: instance.id,
    driver: instance.driver,
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
