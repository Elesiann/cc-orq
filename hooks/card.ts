import type { EngineInterface, On, PluginOptions, RenderElement, RenderInput, SessionEndInput, Timer } from 'claude-code'

import { loadConfig } from './config.ts'
import { listJobs, type Engine } from './engine.ts'
import { cachedJobView, renderTail, tailEvents } from './panel.ts'
import type { OrqCardRow } from '../types/index'
import { formatDuration, type JobRecord } from './types.ts'

export const REFRESH_MS = 2000
const ENDED_SHOWN_MS = 60000
const STUCK_REFRESH_MS = 60000

export type CardMode = 'band' | 'status' | 'off'

export type CardRow = OrqCardRow

type CardEngine = Engine & Pick<EngineInterface, 'state'>

/** The rows, newest first. Session state survives a hot reload, and a render that reads it is drawn again when it changes. */
const CARD = { plugin: 'orq', key: 'card' } as const

let mode: CardMode = 'band'
/** Rows of jobs that ended, kept so an ended job is read once rather than on every tick. */
let endedRowsById = new Map<string, CardRow>()
let timer: Timer | null = null
/** The refresh now running, and the clock time it began; null when none runs. */
let refreshing: { startedAt: number } | null = null
let statusShown = false
/** True until the status line is cleared: a hot reload starts this module while the host may still show an old line. */
let staleStatus = true
/** Bumped when the card stops, so a refresh that began before the stop writes nothing. */
let generation = 0

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

async function refresh($: CardEngine): Promise<void> {
  let run: { startedAt: number } | null = null
  try {
    const now = await $.clock.now()
    // A refresh still running after STUCK_REFRESH_MS is taken as stuck, so this tick starts another one.
    if (refreshing && now - refreshing.startedAt < STUCK_REFRESH_MS) return
    run = { startedAt: now }
    refreshing = run
    const started = generation
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
    if (started !== generation) return
    endedRowsById = nextEnded
    await show($, nextRows)
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

async function show($: CardEngine, rows: CardRow[]): Promise<void> {
  try {
    if (mode === 'band') {
      // An empty band before and after has nothing to write.
      if (rows.length === 0 && ((await $.state.get(CARD)).value ?? []).length === 0) return
      await $.state.set(CARD, rows)
      return
    }
    if (mode !== 'status') return
    const [newest] = rows
    if (newest) {
      const more = rows.length > 1 ? ` (+${rows.length - 1} more)` : ''
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
  if (mode !== 'band') return false
  if (e.props.hasSurvey || e.props.maxRows < 1) return false
  return e.surface === 'terminal' || e.surface === 'desktop'
}

/** The band's lines for `max` rows. With one row the count leads, since truncate-end cuts a long line at its end. */
function bandLines(rows: CardRow[], max: number): { key: string; text: string; dim?: boolean }[] {
  if (rows.length <= max) return rows.map((row) => ({ key: row.id, text: cardLine(row) }))
  const [newest] = rows
  if (max === 1 && newest) return [{ key: newest.id, text: `(+${rows.length - 1} more) ${cardLine(newest)}` }]
  const shown = rows.slice(0, max - 1)
  return [
    ...shown.map((row) => ({ key: row.id, text: cardLine(row) })),
    { key: 'card:more', text: `+${rows.length - shown.length} more`, dim: true },
  ]
}

function drawBand($: Engine, e: RenderInput<'AbovePrompt'>, rows: CardRow[], rest: RenderElement): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const children: RenderElement[] = bandLines(rows, e.props.maxRows).map((line) =>
    Box({ key: line.key, children: [Text({ children: line.text, wrap: 'truncate-end', dimColor: line.dim })] }),
  )
  return Box({ flexDirection: 'column', children: [...children, rest] })
}

/** Empty the band's rows, which a session that drew the band may have left in state. */
async function emptyBand($: CardEngine): Promise<void> {
  try {
    if (((await $.state.get(CARD)).value ?? []).length > 0) await $.state.set(CARD, [])
  } catch (err) {
    await debugLog($, 'clearing the card failed', err)
  }
}

export function startCard($: CardEngine): void {
  if (mode !== 'band') void emptyBand($)
  if (mode === 'off' || timer) return
  timer = $.clock.every(REFRESH_MS, () => {
    void refresh($)
  })
}

/** A /clear or a resume keeps the card: the engine sends no session.start after either. */
export async function stopCard($: CardEngine, e: Pick<SessionEndInput, 'reason'>): Promise<void> {
  if (e.reason === 'clear' || e.reason === 'resume') return
  timer?.cancel()
  timer = null
  generation += 1
  endedRowsById = new Map()
  if (statusShown) clearStatus($)
  statusShown = false
  if (mode === 'band') await emptyBand($)
}

export function registerCard(on: On, options: PluginOptions): void {
  mode = displayMode(options.cardDisplay)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!shouldDraw(e)) return next(e)
    let rows: CardRow[]
    try {
      rows = (await $.state.get(CARD)).value ?? []
    } catch {
      return next(e)
    }
    if (rows.length === 0) return next(e)
    return drawBand($, e, rows, await next(e))
  })
}

export function clearCardState(): void {
  timer?.cancel()
  timer = null
  endedRowsById = new Map()
  refreshing = null
  statusShown = false
  staleStatus = true
}
