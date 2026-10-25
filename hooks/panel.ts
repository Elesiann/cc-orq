import type {
  CommandRunInput,
  EngineInterface,
  On,
  RenderElement,
  RenderInput,
  SessionEndInput,
  Timer,
  UiOpenResult,
} from 'claude-code'

import { loadConfig } from './config.ts'
import { jobView, listJobs, readMeta, writeCancel, type Engine, type JobView } from './engine.ts'
import { renderTail } from './event-line.ts'
import { formatDuration, isSafeJobId, shellWord, type JobRecord, type JobStatus } from './types.ts'

export const PANEL_ID = 'orq-panel'
export const PANEL_COMMAND = 'orq-panel'
export const PANEL_TITLE = 'orq'

const TAIL_BYTES = 32768
const REFRESH_MS = 2000
const PROCESS_TIMEOUT_MS = 15000
const FINAL_VIEWS_MAX = 200
const USAGE = 'orq-panel: usage: /orq-panel [show <id> | cancel <id>]'

/** A job row: its meta.json, the status jobView reads for it, and how long it has run or ran until it ended. */
export type PanelJob = JobRecord & { status: JobStatus; elapsedMs: number }

export type PanelSnapshot = {
  jobs: PanelJob[]
  selectedId: string | null
  tail: string[]
  now: number
  jobsDir: string
  note: string
}

let selectedId: string | null = null
let refreshTimer: Timer | null = null
/** The views of ended jobs, by job id. See cachedJobView. */
const finalViews = new Map<string, JobView>()

function statusMark(status: JobStatus): string {
  switch (status) {
    case 'running':
      return '●'
    case 'cancelling':
      return '◌'
    case 'waiting':
      return '◐'
    case 'done':
      return '✓'
    case 'cancelled':
      return '✕'
    case 'failed':
      return '!'
    case 'interrupted':
      return '?'
  }
}

/** Log a failed panel call at debug level. The pane never throws into the host. */
async function debugLog($: Engine, what: string, err: unknown): Promise<void> {
  try {
    await $.ui.log(`orq-panel: ${what}: ${String(err)}`, { to: 'debug' })
  } catch {
    /* nothing left to report to */
  }
}

/** Ask the host to redraw the pane. */
async function redraw($: Engine): Promise<void> {
  try {
    $.ui.invalidate('ui.render')
  } catch (err) {
    await debugLog($, 'redraw failed', err)
  }
}

/** The last TAIL_BYTES of a job's events file. A full read would be too big on a long run. */
export async function tailEvents($: Engine, dir: string): Promise<string> {
  const script = `# orq-panel:tail\ntail -c ${TAIL_BYTES} ${shellWord(`${dir}/events.jsonl`)} 2>/dev/null; exit 0`
  try {
    const r = await $.process.run(['bash', '-c', script], { timeoutMs: PROCESS_TIMEOUT_MS })
    return r.stdout
  } catch (err) {
    await debugLog($, 'tail failed', err)
    return ''
  }
}

/** Cancel one job, the way mcp__plugin_cc-orq_orq__cancel does: only a running or waiting job gets a cancel file. */
export async function cancelJob($: Engine, id: string): Promise<string> {
  const { config } = await loadConfig($)
  const job = await readMeta($, config.jobsDir, id)
  if (!job) return `orq-panel: unknown job ${id || '(missing)'}`
  const { status } = await jobView($, job)
  if (status === 'running' || status === 'waiting') {
    await writeCancel($, job)
    return `orq-panel: cancel requested for ${job.id}`
  }
  if (status === 'done' || status === 'failed' || status === 'cancelled') {
    return `orq-panel: ${job.id} already finished; nothing to cancel`
  }
  return `orq-panel: ${job.id} is ${status}; nothing to cancel`
}

/**
 * jobView, with the view of an ended job kept. An exit file never changes, so an ended job is read once, and a
 * finished job costs one extract.py run, not one per render. Running and interrupted jobs are read every time.
 */
export async function cachedJobView($: Engine, job: JobRecord): Promise<JobView> {
  const known = finalViews.get(job.id)
  if (known) return known
  const view = await jobView($, job)
  if (view.endedAt !== null) {
    // The cap is well above the listing, so the map stays small and a job still listed is never dropped.
    if (finalViews.size >= FINAL_VIEWS_MAX) {
      const oldest = finalViews.keys().next().value
      if (oldest !== undefined) finalViews.delete(oldest)
    }
    finalViews.set(job.id, view)
  }
  return view
}

/**
 * The panel's state: the newest jobs with their status and elapsed time, and the selected job's tail. A job whose
 * view throws is logged at debug level with its id and left out; the other jobs are still listed.
 */
export async function collectSnapshot($: Engine): Promise<PanelSnapshot> {
  const now = await $.clock.now()
  const { config } = await loadConfig($)
  const listed = await Promise.all(
    (await listJobs($, config.jobsDir)).map(async (job): Promise<PanelJob | null> => {
      try {
        const view = await cachedJobView($, job)
        return { ...job, status: view.status, elapsedMs: Math.max(0, (view.endedAt ?? now) - job.startedAt) }
      } catch (err) {
        await debugLog($, `job ${job.id} could not be read`, err)
        return null
      }
    }),
  )
  const jobs = listed.filter((job): job is PanelJob => job !== null)
  const selected = jobs.find((job) => job.id === selectedId)
  let tail: string[] = []
  let note = ''
  if (selected) {
    tail = renderTail(await tailEvents($, selected.dir))
  } else if (selectedId) {
    note = `selected job ${selectedId} is gone`
  }
  return { jobs, selectedId: selected?.id ?? null, tail, now, jobsDir: config.jobsDir, note }
}

function jobLine(job: PanelJob, active: boolean): string {
  const model = job.model ? ` · ${job.model}` : ''
  return `${statusMark(job.status)} ${job.status} ${formatDuration(job.elapsedMs)} ${job.kind}${model}${active ? ' ←' : ''}`
}

async function cancelAndRedraw($: Engine, id: string): Promise<void> {
  try {
    await cancelJob($, id)
  } catch (err) {
    await debugLog($, 'cancel failed', err)
  }
  await redraw($)
}

function drawSnapshot($: Engine, e: RenderInput<'Pane'>, snap: PanelSnapshot): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(e)
  const count = `${snap.jobs.length} job${snap.jobs.length === 1 ? '' : 's'}`
  const rows: RenderElement[] = [Text({ dimColor: true, children: `orq · ${count} · ${snap.jobsDir}` })]
  if (snap.jobs.length === 0) rows.push(Text({ children: 'no jobs yet' }))
  for (const job of snap.jobs) {
    const active = job.id === snap.selectedId
    rows.push(
      Box({
        key: `job:${job.id}`,
        flexDirection: 'row',
        children: [
          Button({
            key: `sel:${job.id}`,
            plain: true,
            label: jobLine(job, active),
            onPress: () => {
              selectedId = job.id
              void redraw($)
            },
          }),
          job.status === 'running' || job.status === 'waiting'
            ? Button({
                key: `cancel:${job.id}`,
                label: 'cancel',
                onPress: () => {
                  void cancelAndRedraw($, job.id)
                },
              })
            : Text({ dimColor: true, children: ` ${job.id.slice(-6)}` }),
        ],
      }),
    )
  }
  if (snap.selectedId) {
    rows.push(Text({ bold: true, children: `— ${snap.selectedId}` }))
    if (snap.tail.length === 0) rows.push(Text({ dimColor: true, children: '(no events yet)' }))
    for (const [i, line] of snap.tail.entries()) {
      rows.push(
        Box({
          key: `tail:${i}`,
          children: [Text({ children: line, wrap: 'truncate-end' })],
        }),
      )
    }
  } else {
    rows.push(Text({ dimColor: true, children: 'select a job to watch its live events' }))
  }
  if (snap.note) rows.push(Text({ dimColor: true, children: snap.note }))
  rows.push(
    Box({
      flexDirection: 'row',
      children: [
        Button({
          key: 'panel:refresh',
          label: 'refresh',
          onPress: () => {
            void redraw($)
          },
        }),
        Button({
          key: 'panel:close',
          label: 'close',
          onPress: () => {
            // Once the close settles, one tick finds the pane gone and stops the timer. A close a hook
            // answered without next leaves the pane up, and the same tick keeps the timer.
            void $.ui.close({ id: PANEL_ID }).then(
              () => refreshTick($),
              (err: unknown) => debugLog($, 'close failed', err),
            )
          },
        }),
      ],
    }),
  )
  return Box({ flexDirection: 'column', children: rows })
}

function cancelRefresh(): void {
  refreshTimer?.cancel()
  refreshTimer = null
}

/** One tick of the refresh timer: redraw while the host lists the pane, and stop the timer once it does not. */
async function refreshTick($: Engine): Promise<void> {
  try {
    const open = (await $.ui.panes()).some((pane) => pane.id === PANEL_ID)
    if (!open) {
      cancelRefresh()
      return
    }
  } catch (err) {
    await debugLog($, 'pane check failed', err)
  }
  await redraw($)
}

/** Redraw the pane every REFRESH_MS while it is open. Started once, when the pane opens. */
function ensureRefresh($: Engine): void {
  if (refreshTimer) return
  try {
    refreshTimer = $.clock.every(REFRESH_MS, () => {
      void refreshTick($)
    })
  } catch (err) {
    void debugLog($, 'refresh timer failed', err)
  }
}

/** Stop the refresh timer when the session ends. A /clear or a resume keeps it, as it keeps the card. */
export function stopPanel(e: Pick<SessionEndInput, 'reason'>): void {
  if (e.reason === 'clear' || e.reason === 'resume') return
  cancelRefresh()
}

async function openPane($: Engine): Promise<{ text: string }> {
  let opened: UiOpenResult
  try {
    opened = await $.ui.open({ id: PANEL_ID, title: PANEL_TITLE, focus: true })
  } catch (err) {
    return { text: `orq-panel: could not open the pane: ${String(err)}` }
  }
  ensureRefresh($)
  if (!opened.isPlaced) return { text: `orq-panel: pane waits undrawn (${opened.reason})` }
  return { text: 'orq-panel: pane opened' }
}

/** The text after /orq-panel: nothing opens the pane, `show <id>` selects a job, `cancel <id>` cancels one. */
export async function runPanelCommand($: Engine, args: string): Promise<{ text: string }> {
  const m = /^(\S*)\s*([\s\S]*)$/.exec(args.trim())
  const sub = m?.[1] ?? ''
  const rest = (m?.[2] ?? '').trim()
  if (sub === 'cancel') return { text: await cancelJob($, rest) }
  if (sub === 'show') {
    if (!isSafeJobId(rest)) return { text: `orq-panel: unknown job ${rest || '(missing)'}` }
    selectedId = rest
  } else if (sub !== '') {
    return { text: USAGE }
  }
  return openPane($)
}

/** Declare /orq-panel in the typeahead. Called from session.start, which owns the one unmatched hook. */
export async function registerPanelCommand($: Pick<EngineInterface, 'command'>): Promise<void> {
  await $.command.register({
    name: PANEL_COMMAND,
    description: 'Watch orq background jobs live: list, tail one job, cancel it.',
    argumentHint: '[show <id> | cancel <id>]',
  })
}

/** The command.run hook for /orq-panel. A failure becomes the command's text. */
export async function onPanelCommand($: Engine, e: CommandRunInput): Promise<{ text: string }> {
  try {
    return await runPanelCommand($, e.args)
  } catch (err) {
    await debugLog($, 'command failed', err)
    return { text: `orq-panel: ${String(err)}` }
  }
}

/** Draw the panel's pane: the jobs, the selected job's tail, and the refresh and close buttons. */
export async function onPaneRender($: Engine, e: RenderInput<'Pane'>): Promise<RenderElement> {
  try {
    return drawSnapshot($, e, await collectSnapshot($))
  } catch (err) {
    const { Box, Text } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [Text({ children: `orq-panel: could not read jobs: ${String(err)}` })],
    })
  }
}

/** Test seam: drop the selected job, the refresh timer and the ended jobs' views between isolated runs. */
export function clearPanelSelection(): void {
  cancelRefresh()
  selectedId = null
  finalViews.clear()
}

/** The panel's own hooks. The command itself is declared from session.start, through registerPanelCommand. */
export function registerPanel(on: On): void {
  on('command.run', { command: PANEL_COMMAND }, onPanelCommand)
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANEL_ID) return next(e)
    return onPaneRender($, e)
  })
}
