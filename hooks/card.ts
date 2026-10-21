import type { On, PluginOptions, RenderElement, RenderInput, SessionEndInput, Timer } from 'claude-code'

import { loadConfig } from './config.ts'
import { listJobs, type Engine } from './engine.ts'
import { cachedJobView, renderTail, tailEvents } from './panel.ts'
import { formatDuration, type JobRecord, type JobStatus } from './types.ts'

export const REFRESH_MS = 2000
const ENDED_SHOWN_MS = 60000
const STUCK_REFRESH_MS = 60000

export type CardMode = 'band' | 'status' | 'off'

export type CardRow = { id: string; instance: string; model: string; status: JobStatus; lastAction: string; durationMs: number }

let mode: CardMode = 'band'
let rowsNewestFirst: CardRow[] = []
let endedRowsById = new Map<string, CardRow>()
let timer: Timer | null = null
/** The refresh now running, and the clock time it began; null when none runs. */
let refreshing: { startedAt: number } | null = null
let statusShown = false
/** True until the status line is cleared: a hot reload starts this module while the host may still show an old line. */
let staleStatus = true

export function displayMode(value: unknown): CardMode {
  return value === 'status' || value === 'off' ? value : 'band'
}

export function cardLine(row: CardRow): string {
  return `${row.instance} · ${row.model} · ${row.status} · ${row.lastAction} · ${formatDuration(row.durationMs)}`
}

async function debugLog($: Engine, what: string, err: unknown): Promise<void> {
  try {
    await $.ui.log(`orq-card: ${what}: ${String(err)}`, { to: 'debug' })
  } catch {}
}

async function exitFileMtimeMs($: Engine, job: JobRecord): Promise<number | null> {
  try {
    return (await $.fs.stat(`${job.dir}/exit`)).mtimeMs
  } catch {
    return null
  }
}

async function rowOf($: Engine, job: JobRecord, fallbackEndAt: number): Promise<CardRow> {
  const view = await cachedJobView($, job)
  const [lastAction] = renderTail(await tailEvents($, job.dir), 1)
  return {
    id: job.id,
    instance: job.instanceId ?? job.runner ?? job.kind,
    model: job.model ?? '?',
    status: view.status,
    lastAction: lastAction ?? '—',
    durationMs: (view.endedAt ?? fallbackEndAt) - job.startedAt,
  }
}

async function refresh($: Engine): Promise<void> {
  let run: { startedAt: number } | null = null
  try {
    const now = await $.clock.now()
    // A refresh still running after STUCK_REFRESH_MS is taken as stuck, so this tick starts another one.
    if (refreshing && now - refreshing.startedAt < STUCK_REFRESH_MS) return
    run = { startedAt: now }
    refreshing = run
    const { config } = await loadConfig($)
    const nextRows: CardRow[] = []
    const nextEnded = new Map<string, CardRow>()
    for (const job of await listJobs($, config.jobsDir)) {
      const exitAt = await exitFileMtimeMs($, job)
      if (exitAt === null) {
        nextRows.push(await rowOf($, job, now))
      } else if (now - exitAt < ENDED_SHOWN_MS) {
        const row = endedRowsById.get(job.id) ?? (await rowOf($, job, exitAt))
        nextEnded.set(job.id, row)
        nextRows.push(row)
      }
    }
    const hadRows = rowsNewestFirst.length > 0
    rowsNewestFirst = nextRows
    endedRowsById = nextEnded
    show($, hadRows)
  } catch (err) {
    await debugLog($, 'refresh failed', err)
  } finally {
    // A stuck refresh that a newer one has replaced must not clear the newer one's mark.
    if (run && refreshing === run) refreshing = null
  }
}

/** Clear the status line. A failure goes to the debug log. */
function clearStatus($: Engine): void {
  try {
    $.ui.status(undefined)
  } catch (err) {
    void debugLog($, 'clearing the status line failed', err)
  }
}

function show($: Engine, hadRows: boolean): void {
  try {
    if (mode === 'band') {
      // An empty band before and after has nothing to redraw.
      if (hadRows || rowsNewestFirst.length > 0) $.ui.invalidate('ui.render')
      return
    }
    if (mode !== 'status') return
    const [newest] = rowsNewestFirst
    if (newest) {
      const more = rowsNewestFirst.length > 1 ? ` (+${rowsNewestFirst.length - 1} more)` : ''
      $.ui.status(`${cardLine(newest)}${more}`)
      statusShown = true
      staleStatus = false
    } else if (statusShown || staleStatus) {
      clearStatus($)
      statusShown = false
      staleStatus = false
    }
  } catch (err) {
    void debugLog($, 'redraw failed', err)
  }
}

function shouldDraw(e: RenderInput<'AbovePrompt'>): boolean {
  if (mode !== 'band' || rowsNewestFirst.length === 0) return false
  if (e.props.hasSurvey || e.props.maxRows < 1) return false
  return e.surface === 'terminal' || e.surface === 'desktop'
}

function drawBand($: Engine, e: RenderInput<'AbovePrompt'>, rest: RenderElement): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const max = e.props.maxRows
  const shown = rowsNewestFirst.length <= max ? rowsNewestFirst : rowsNewestFirst.slice(0, max - 1)
  const children: RenderElement[] = shown.map((row) =>
    Box({ key: row.id, children: [Text({ children: cardLine(row), wrap: 'truncate-end' })] }),
  )
  if (shown.length < rowsNewestFirst.length) {
    children.push(
      Box({ key: 'card:more', children: [Text({ dimColor: true, children: `+${rowsNewestFirst.length - shown.length} more` })] }),
    )
  }
  return Box({ flexDirection: 'column', children: [...children, rest] })
}

export function startCard($: Engine): void {
  if (mode === 'off' || timer) return
  timer = $.clock.every(REFRESH_MS, () => {
    void refresh($)
  })
}

/** A /clear or a resume keeps the card: the engine sends no session.start after either. */
export function stopCard($: Engine, e: Pick<SessionEndInput, 'reason'>): void {
  if (e.reason === 'clear' || e.reason === 'resume') return
  timer?.cancel()
  timer = null
  rowsNewestFirst = []
  endedRowsById = new Map()
  if (statusShown) clearStatus($)
  statusShown = false
}

export function registerCard(on: On, options: PluginOptions): void {
  mode = displayMode(options.cardDisplay)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!shouldDraw(e)) return next(e)
    return drawBand($, e, await next(e))
  })
}

export function clearCardState(): void {
  timer?.cancel()
  timer = null
  rowsNewestFirst = []
  endedRowsById = new Map()
  refreshing = null
  statusShown = false
  staleStatus = true
}
