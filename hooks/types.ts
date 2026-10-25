import type { DriverKind } from './config.ts'
import { INTERACTION_MODES, RUNTIME_MODES, type Failure, type InteractionMode, type RuntimeMode } from './contract.ts'

/** The CLI that runs a job; each provider driver maps to exactly one. */
export type Runner = 'codex' | 'opencode' | 'agy' | 'claude'

export const DRIVER_RUNNER: Record<DriverKind, Runner> = {
  codex: 'codex',
  opencode: 'opencode',
  antigravity: 'agy',
  claudeAgent: 'claude',
}

const RUNNERS: readonly Runner[] = ['codex', 'opencode', 'agy', 'claude']
const DRIVERS: readonly DriverKind[] = ['codex', 'opencode', 'antigravity', 'claudeAgent']

export type JobStatus = 'running' | 'cancelling' | 'waiting' | 'interrupted' | 'done' | 'failed' | 'cancelled'

/** A job as its meta.json describes it. Optional fields are absent in older jobs. */
export type JobRecord = {
  id: string
  kind: string
  agentId: string
  dir: string
  cwd: string
  startedAt: number
  startedAtIso: string
  pgid?: string
  runner?: Runner
  model?: string
  instanceId?: string
  driver?: DriverKind
  /** The CODEX_HOME the job launched with, when its instance set one; the only env value meta.json keeps. */
  codexHome?: string
  /** The runtime and interaction modes a cc-orq:task job was resolved to; absent on older and manual jobs. */
  runtimeMode?: RuntimeMode
  interactionMode?: InteractionMode
  /** The reasoning effort the job's CLI was given; absent when it got none, as for an OpenCode job. */
  effort?: string
  /** The checkout the task was launched from. Set only for a worktree task, where cwd is the worktree. */
  repo?: string
  /** The commit the task branch was cut from. */
  baseSha?: string
  /** The task branch, orq/TASK_ID. */
  branch?: string
  /** The task's worktree path: cwd, or the directory above cwd when the task ran in a subdirectory. */
  worktree?: string
}

/** True when path is root or lies under it. Both are resolved paths. */
export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build a JobRecord from parsed meta.json, or null when the required fields are missing. */
export function parseJobMeta(raw: unknown, jobsDir: string, id: string): JobRecord | null {
  if (!isRecord(raw) || raw.id !== id) return null
  if (typeof raw.kind !== 'string' || typeof raw.agentId !== 'string') return null
  if (typeof raw.cwd !== 'string' || typeof raw.startedAt !== 'number') return null
  const job: JobRecord = {
    id,
    kind: raw.kind,
    agentId: raw.agentId,
    dir: `${jobsDir}/${id}`,
    cwd: raw.cwd,
    startedAt: raw.startedAt,
    startedAtIso: typeof raw.startedAtIso === 'string' ? raw.startedAtIso : new Date(raw.startedAt).toISOString(),
  }
  if (typeof raw.pgid === 'string' && raw.pgid !== '') job.pgid = raw.pgid
  if (typeof raw.model === 'string') job.model = raw.model
  if (typeof raw.instanceId === 'string') job.instanceId = raw.instanceId
  const runner = RUNNERS.find((r) => r === raw.runner)
  const driver = DRIVERS.find((d) => d === raw.driver)
  if (driver) job.driver = driver
  if (runner) job.runner = runner
  else if (driver) job.runner = DRIVER_RUNNER[driver]
  if (typeof raw.codexHome === 'string' && raw.codexHome !== '') job.codexHome = raw.codexHome
  const runtimeMode = RUNTIME_MODES.find((mode) => mode === raw.runtimeMode)
  if (runtimeMode) job.runtimeMode = runtimeMode
  const interactionMode = INTERACTION_MODES.find((mode) => mode === raw.interactionMode)
  if (interactionMode) job.interactionMode = interactionMode
  if (typeof raw.effort === 'string' && raw.effort !== '') job.effort = raw.effort
  // Worktree fields are optional and tolerated: a value of the wrong type is ignored, never a reason to drop the job.
  if (typeof raw.repo === 'string' && raw.repo !== '') job.repo = raw.repo
  if (typeof raw.baseSha === 'string' && raw.baseSha !== '') job.baseSha = raw.baseSha
  if (typeof raw.branch === 'string' && raw.branch !== '') job.branch = raw.branch
  if (typeof raw.worktree === 'string' && raw.worktree !== '') job.worktree = raw.worktree
  return job
}

/** Quote a word for bash only when it contains anything beyond a plain token. */
export function shellWord(text: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Format milliseconds as 45s, 6m, 12m05s. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m === 0) return `${s}s`
  if (rest === 0) return `${m}m`
  return `${m}m${String(rest).padStart(2, '0')}s`
}

/** Starts every refusal a task step answers. "taskId none" tells the parent there is no job to query. */
export const TASK_REFUSAL = 'orq: task refused (taskId none)'

export function refusalText(failure: Failure): string {
  return `${TASK_REFUSAL}: ${failure.error.code}: ${failure.error.message}`
}

/**
 * The one footer line of every answer. The taskId is the job id a parent passes to the job tools. Null token
 * counts, when the extractor found none, render as `tokens n/a`.
 */
export function buildFooter(args: {
  kind: string
  model: string
  effort: string
  durationMs: number
  inTokens: number | null
  outTokens: number | null
  taskId: string
  session: string
}): string {
  const tokens = args.inTokens === null || args.outTokens === null ? 'tokens n/a' : `${args.inTokens}/${args.outTokens} tokens`
  return `— orq · ${args.kind} · ${args.model} · effort ${args.effort} · ${formatDuration(args.durationMs)} · ${tokens} · taskId ${args.taskId} · session ${args.session}`
}

/** Read model and effort from the last turn_context of a Codex rollout file. */
export function parseRolloutModelEffort(text: string): { model: string; effort: string } {
  let model = ''
  let effort = ''
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || !t.includes('turn_context')) continue
    let o: unknown
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    if (!isRecord(o) || o.type !== 'turn_context' || !isRecord(o.payload)) continue
    if (typeof o.payload.model === 'string') model = o.payload.model
    if (typeof o.payload.effort === 'string') effort = o.payload.effort
  }
  return { model, effort }
}

const REDACTED = '[REDACTED]'

/** Replace anything token-like with [REDACTED]. Order matters: specific shapes first. */
export function redactSecrets(text: string): string {
  let out = text
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
  out = out.replace(/\bBasic\s+[A-Za-z0-9._~+/=]+/gi, REDACTED)
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED)
  out = out.replace(/\bghp_[A-Za-z0-9]{8,}/g, REDACTED)
  out = out.replace(/\bgho_[A-Za-z0-9]{8,}/g, REDACTED)
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, REDACTED)
  out = out.replace(/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, REDACTED)
  out = out.replace(/\bAKIA[0-9A-Z]{12,}/g, REDACTED)
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED)
  out = out.replace(
    /((?:token|secret|password|passwd|api[_-]?key|authorization|cookie)\s*[:=]\s*)([^\s,;"']+)/gi,
    `$1${REDACTED}`,
  )
  out = out.replace(/\b[A-Za-z0-9+/=_.-]{32,}/g, REDACTED)
  return out
}

/** Failure log snippet: at most the last 20 lines, each cut to 300 chars, secrets redacted. */
export function failureSnippet(stderrText: string): string {
  const lines = stderrText.split('\n').slice(-20)
  return lines
    .map((l) => redactSecrets(l.length > 300 ? l.slice(0, 300) : l))
    .join('\n')
    .trim()
}

/** Random base36 part for job ids. */
export function rand36(n = 6): string {
  let s = ''
  while (s.length < n) s += Math.random().toString(36).slice(2)
  return s.slice(0, n)
}

/** Job ids reach the filesystem, so only this shape is accepted. */
export function isSafeJobId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,128}$/.test(id) && !id.includes('..')
}

export type TableRow = { id: string; kind: string; status: string; elapsed: string; cwd: string }

/** Render the /orq list text table. */
export function renderTable(rows: TableRow[]): string {
  const head = ['id', 'kind', 'status', 'elapsed', 'cwd']
  const all = [head, ...rows.map((r) => [r.id, r.kind, r.status, r.elapsed, r.cwd])]
  const widths = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)))
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ')
  return all.map(fmt).join('\n')
}
