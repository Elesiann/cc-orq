import type { CommandRunInput, EngineInterface, On, RenderElement, RenderInput, Timer, UiOpenResult } from 'claude-code'

import { loadConfig } from './config.ts'
import { jobView, listJobs, readMeta, writeCancel, type Engine } from './engine.ts'
import { formatDuration, isRecord, isSafeJobId, shellWord, type JobRecord, type JobStatus } from './types.ts'

export const PANEL_ID = 'orq-panel'
export const PANEL_COMMAND = 'orq-panel'
export const PANEL_TITLE = 'orq'

const TAIL_BYTES = 32768
const TAIL_LINES = 30
const REFRESH_MS = 2000
const PROCESS_TIMEOUT_MS = 15000
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

function shortText(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function clockOf(o: Record<string, unknown>): string {
  const ts = o.timestamp
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const ms = ts < 1e12 ? ts * 1000 : ts
    return new Date(ms).toISOString().slice(11, 19)
  }
  return ''
}

/** `tokens N in / M out` from a usage record, or null when it reports neither count. */
function usageText(usage: unknown): string | null {
  if (!isRecord(usage)) return null
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : null
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : null
  if (input === null && output === null) return null
  return `tokens ${input ?? '?'} in / ${output ?? '?'} out`
}

/** The last item of a Claude assistant row's message content, or null. */
function lastContentItem(o: Record<string, unknown>): Record<string, unknown> | null {
  const content: unknown[] = isRecord(o.message) && Array.isArray(o.message.content) ? o.message.content : []
  const last: unknown = content[content.length - 1]
  return isRecord(last) ? last : null
}

/** One compact line per event JSONL row: `HH:MM:SS kind text`. Null when the row carries nothing to show. */
export function renderEventLine(raw: string): string | null {
  const t = raw.trim()
  if (!t || !t.startsWith('{')) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(t) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const clock = clockOf(o)
  const pre = clock ? `${clock} ` : ''

  // Codex `codex exec --json` rows.
  if (typeof o.type === 'string') {
    if (o.type === 'thread.started' && typeof o.thread_id === 'string') {
      return `${pre}start thread ${o.thread_id.slice(0, 8)}`
    }
    if (o.type === 'item.completed') {
      const item = o.item as Record<string, unknown> | undefined
      const kind = item && typeof item.type === 'string' ? item.type : 'item'
      if (item && item.type === 'agent_message' && typeof item.text === 'string') {
        return `${pre}msg ${shortText(item.text, 160)}`
      }
      if (item && item.type === 'error' && typeof item.message === 'string') {
        return `${pre}error ${shortText(item.message, 160)}`
      }
      return `${pre}${shortText(kind, 24)}`
    }
    if (o.type === 'turn.completed') {
      const usage = o.usage as Record<string, unknown> | undefined
      const input = usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : null
      const output = usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : null
      if (input !== null || output !== null) {
        return `${pre}tokens ${input ?? '?'} in / ${output ?? '?'} out`
      }
      return `${pre}turn done`
    }
  }

  // Claude `claude -p --output-format stream-json` rows.
  if (o.type === 'system' && o.subtype === 'init') return `${pre}start`
  if (o.type === 'assistant') {
    const item = lastContentItem(o)
    if (item?.type === 'text' && typeof item.text === 'string') return `${pre}msg ${shortText(item.text, 160)}`
    if (item?.type === 'tool_use') return `${pre}tool ${shortText(typeof item.name === 'string' ? item.name : 'tool', 60)}`
    return null
  }
  if (o.type === 'result') return `${pre}${usageText(o.usage) ?? 'result'}`
  if (o.type === 'user') return null

  // OpenCode `opencode run --format json` rows.
  const part = o.part as Record<string, unknown> | undefined
  if (part && typeof part === 'object') {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      return `${pre}msg ${shortText(part.text, 160)}`
    }
    if (part.type === 'tool') {
      const name =
        typeof part.name === 'string'
          ? part.name
          : typeof part.title === 'string'
            ? part.title
            : typeof part.tool === 'string'
              ? part.tool
              : 'tool'
      return `${pre}tool ${shortText(name, 60)}`
    }
    if (part.type === 'step-finish') {
      const tokens = part.tokens as Record<string, unknown> | undefined
      const input = tokens && typeof tokens.input === 'number' ? tokens.input : null
      const output = tokens && typeof tokens.output === 'number' ? tokens.output : null
      if (input !== null || output !== null) {
        return `${pre}tokens ${input ?? '?'} in / ${output ?? '?'} out`
      }
      return `${pre}step done`
    }
  }

  // Antigravity (`agy`) stream rows.
  if (o.event === 'init') return `${pre}start`
  if (o.event === 'step_update') {
    const update = isRecord(o.step_update) ? o.step_update : null
    if (update && typeof update.step_type === 'string') return `${pre}step ${shortText(update.step_type, 24)}`
    return null
  }
  if (o.event === 'result') return `${pre}${usageText(isRecord(o.result) ? o.result.usage : undefined) ?? 'result'}`
  return null
}

/** The rendered lines of a tail: the last `maxLines` of the rows that render. */
export function renderTail(text: string, maxLines = TAIL_LINES): string[] {
  const lines = text
    .split('\n')
    .map((raw) => renderEventLine(raw))
    .filter((line): line is string => line !== null)
  return lines.slice(-maxLines)
}

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
async function tailEvents($: Engine, dir: string): Promise<string> {
  const script = `# orq-panel:tail\ntail -c ${TAIL_BYTES} ${shellWord(`${dir}/events.jsonl`)} 2>/dev/null; exit 0`
  try {
    const r = await $.process.run(['bash', '-c', script], { timeoutMs: PROCESS_TIMEOUT_MS })
    return r.stdout
  } catch (err) {
    await debugLog($, 'tail failed', err)
    return ''
  }
}

/** Cancel one job, the way mcp__orq__cancel does: only a running or waiting job gets a cancel file. */
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

/** The panel's state: the newest jobs with their status and elapsed time, and the selected job's tail. */
export async function collectSnapshot($: Engine): Promise<PanelSnapshot> {
  const now = await $.clock.now()
  const { config } = await loadConfig($)
  const jobs = await Promise.all(
    (await listJobs($, config.jobsDir)).map(async (job) => {
      const view = await jobView($, job)
      return { ...job, status: view.status, elapsedMs: Math.max(0, (view.endedAt ?? now) - job.startedAt) }
    }),
  )
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
            void $.ui.close({ id: PANEL_ID }).catch((err: unknown) => debugLog($, 'close failed', err))
          },
        }),
      ],
    }),
  )
  return Box({ flexDirection: 'column', children: rows })
}

/** Redraw the pane every REFRESH_MS. Started once, when the pane opens. */
function ensureRefresh($: Engine): void {
  if (refreshTimer) return
  try {
    refreshTimer = $.clock.every(REFRESH_MS, () => {
      void redraw($)
    })
  } catch (err) {
    void debugLog($, 'refresh timer failed', err)
  }
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

/** Test seam: drop the selected job and the refresh timer between isolated runs. */
export function clearPanelSelection(): void {
  selectedId = null
  refreshTimer = null
}

/** The panel's own hooks. The command itself is declared from session.start, through registerPanelCommand. */
export function registerPanel(on: On): void {
  on('command.run', { command: PANEL_COMMAND }, onPanelCommand)
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANEL_ID) return next(e)
    return onPaneRender($, e)
  })
}
