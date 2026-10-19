import type { EngineInterface } from 'claude-code'

import type { DriverKind, OrqConfig } from './config.ts'
import {
  buildFooter,
  failureSnippet,
  isRecord,
  isSafeJobId,
  parseJobMeta,
  parseRolloutModelEffort,
  rand36,
  shellWord,
  type JobRecord,
  type JobStatus,
  type Runner,
} from './types.ts'

export type Engine = Pick<EngineInterface, 'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>

export const LIST_LIMIT = 50
const PROCESS_TIMEOUT_MS = 30000

export type LaunchSpec = {
  kind: string
  agentId: string
  runner: Runner
  model: string
  cwd: string
  prompt: string
  env: Record<string, string>
  instanceId: string
  driver: DriverKind
}

export type LaunchResult = { job: JobRecord } | { refusal: string }

async function readText($: Engine, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function exists($: Engine, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

/** Cancel-file body; the supervisor only checks that the file exists. */
export function cancelText(reason?: string): string {
  const why = reason?.trim()
  return `cancelled at ${new Date().toISOString()}${why ? ` why=${JSON.stringify(why)}` : ''}\n`
}

export async function writeCancel($: Engine, job: JobRecord, reason?: string): Promise<void> {
  await $.fs.write(`${job.dir}/cancel`, cancelText(reason))
}

/** Read one job's meta.json. Unsafe ids and unreadable or incomplete metadata give null. */
export async function readMeta($: Engine, jobsDir: string, id: string): Promise<JobRecord | null> {
  if (!isSafeJobId(id)) return null
  const raw = await readText($, `${jobsDir}/${id}/meta.json`)
  if (raw === null) return null
  try {
    return parseJobMeta(JSON.parse(raw), jobsDir, id)
  } catch {
    return null
  }
}

/** The jobs in the directory, newest first, at most LIST_LIMIT. */
export async function listJobs($: Engine, jobsDir: string): Promise<JobRecord[]> {
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(jobsDir)
  } catch {
    return []
  }
  const metas = await Promise.all(
    entries.filter((entry) => entry.kind === 'dir').map((entry) => readMeta($, jobsDir, entry.name)),
  )
  return metas
    .filter((job): job is JobRecord => job !== null)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, LIST_LIMIT)
}

export type JobView = { status: JobStatus; endedAt: number | null }

async function mtimeMs($: Engine, path: string): Promise<number | null> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return null
  }
}

export async function jobView($: Engine, job: JobRecord): Promise<JobView> {
  const exit = await readText($, `${job.dir}/exit`)
  if (exit !== null) return viewOfExit($, job, exit)
  const liveness = await jobLiveness($, job)
  if (liveness === 'gone') return { status: 'interrupted', endedAt: null }
  if (liveness === 'running') {
    return { status: (await exists($, `${job.dir}/cancel`)) ? 'cancelling' : 'running', endedAt: null }
  }
  const exitAfterLiveness = await readText($, `${job.dir}/exit`)
  return exitAfterLiveness === null ? { status: 'failed', endedAt: null } : viewOfExit($, job, exitAfterLiveness)
}

async function viewOfExit($: Engine, job: JobRecord, exit: string): Promise<JobView> {
  const endedAt = await mtimeMs($, `${job.dir}/exit`)
  const code = Number(exit.trim())
  if (code === 124) return { status: 'cancelled', endedAt }
  if (code === 0 && (await exists($, `${job.dir}/last.txt`))) return { status: 'done', endedAt }
  return { status: 'failed', endedAt }
}

function mkdirScript(jobsDir: string, dir: string): string {
  return `# orq:mkdir\nmkdir -p ${shellWord(jobsDir)} || exit 8\nmkdir ${shellWord(dir)} || exit 7`
}

/**
 * Start script for one job. The instance env is passed as --setenv for the
 * systemd unit and as `env K=V` for the setsid fallback, so both reach the CLI.
 */
export function startScript(args: {
  id: string
  dir: string
  supervise: string
  runner: Runner
  cwd: string
  model: string
  env: Record<string, string>
}): string {
  const supervisorArgs = [args.supervise, args.dir, args.runner, args.cwd, args.model]
  const supervisorCmd = `bash ${supervisorArgs.map(shellWord).join(' ')} </dev/null >${shellWord(`${args.dir}/child.log`)} 2>&1`
  const pairs = Object.entries(args.env).map(([k, v]) => shellWord(`${k}=${v}`))
  const setenv = pairs.map((pair) => `--setenv=${pair}`).join(' ')
  const envAssign = pairs.join(' ')
  // A job in the caller's cgroup dies with the terminal or session that launched it; a transient user
  // unit gets its own, and stopping it also reaps children that escaped the process group. setsid is
  // the fallback when no user manager is reachable.
  return (
    `# orq:start\n` +
    `if systemd-run --user --quiet --collect --unit=${shellWord(`orq-${args.id}`)} --setenv=PATH="$PATH" --setenv=HOME="$HOME" ${setenv} ` +
    `bash -c ${shellWord(`exec ${supervisorCmd}`)} 2>/dev/null; then echo systemd > ${shellWord(`${args.dir}/scope`)}; ` +
    `else echo setsid > ${shellWord(`${args.dir}/scope`)}; setsid env ${envAssign} ${supervisorCmd} & fi\n` +
    `for i in $(seq 1 10); do [ -s ${shellWord(`${args.dir}/pgid`)} ] && exit 0; sleep 0.5; done\n` +
    `exit 11`
  )
}

async function markLaunchFailed($: Engine, dir: string): Promise<void> {
  try {
    await $.fs.write(`${dir}/exit`, '125')
  } catch {
    /* the refusal the caller returns is the signal */
  }
}

/** Create a job directory, write meta.json and prompt.txt, and start the supervisor detached. */
export async function launchJob($: Engine, config: OrqConfig, spec: LaunchSpec): Promise<LaunchResult> {
  const now = await $.clock.now()
  const supervise = `${$.plugin.root}/scripts/supervise.sh`
  const agentSuffix = spec.agentId.slice(-8)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = `${spec.kind}-${now}-${agentSuffix}-${rand36()}`
    const dir = `${config.jobsDir}/${id}`
    let mkdirCode: number
    try {
      const r = await $.process.run(['bash', '-c', mkdirScript(config.jobsDir, dir)], { timeoutMs: PROCESS_TIMEOUT_MS })
      mkdirCode = r.exitCode
    } catch (err) {
      return { refusal: `orq: ${spec.kind} could not create its job directory: ${String(err)}` }
    }
    if (mkdirCode === 7 && attempt === 0) continue
    if (mkdirCode !== 0) {
      return { refusal: `orq: ${spec.kind} could not create its job directory (exit ${mkdirCode})` }
    }
    const startedAtIso = new Date(now).toISOString()
    const meta = {
      id,
      kind: spec.kind,
      agentId: spec.agentId,
      cwd: spec.cwd,
      startedAt: now,
      startedAtIso,
      runner: spec.runner,
      model: spec.model,
      instanceId: spec.instanceId,
      driver: spec.driver,
    }
    try {
      await $.fs.write(`${dir}/meta.json`, JSON.stringify(meta))
      await $.fs.write(`${dir}/prompt.txt`, spec.prompt)
    } catch (err) {
      return { refusal: `orq: ${spec.kind} could not write its job directory: ${String(err)}` }
    }
    const script = startScript({
      id,
      dir,
      supervise,
      runner: spec.runner,
      cwd: spec.cwd,
      model: spec.model,
      env: spec.env,
    })
    let startCode: number
    try {
      const r = await $.process.run(['bash', '-c', script], { timeoutMs: PROCESS_TIMEOUT_MS })
      startCode = r.exitCode
    } catch (err) {
      await markLaunchFailed($, dir)
      return { refusal: `orq: ${spec.kind} could not start its job: ${String(err)}` }
    }
    if (startCode !== 0) {
      await markLaunchFailed($, dir)
      return {
        refusal:
          startCode === 11
            ? `orq: ${spec.kind} failed to start (supervisor did not report within 5 s)`
            : `orq: ${spec.kind} failed to start (exit ${startCode})`,
      }
    }
    const pgid = ((await readText($, `${dir}/pgid`)) ?? '').trim()
    const job: JobRecord = {
      id,
      kind: spec.kind,
      agentId: spec.agentId,
      dir,
      cwd: spec.cwd,
      startedAt: now,
      startedAtIso,
      runner: spec.runner,
      model: spec.model,
      instanceId: spec.instanceId,
      driver: spec.driver,
    }
    if (pgid) job.pgid = pgid
    return { job }
  }
  return { refusal: `orq: ${spec.kind} could not pick a job id without collision` }
}

/** finished | running | gone: the exit file, else the supervisor's process group. */
export async function jobLiveness($: Engine, job: JobRecord): Promise<'finished' | 'running' | 'gone'> {
  if (await exists($, `${job.dir}/exit`)) return 'finished'
  const script =
    `# orq:liveness\npgid=$(cat ${shellWord(`${job.dir}/pgid`)} 2>/dev/null | tr -d ' \\t\\n')\n` +
    `case "$pgid" in ''|*[!0-9]*) exit 12 ;; esac\n` +
    `kill -0 -"$pgid" 2>/dev/null && exit 11\n` +
    `[ -e ${shellWord(`${job.dir}/exit`)} ] && exit 0 || exit 12`
  try {
    const r = await $.process.run(['bash', '-c', script], { timeoutMs: 15000 })
    if (r.exitCode === 0) return 'finished'
    if (r.exitCode === 11) return 'running'
    return 'gone'
  } catch {
    return 'running'
  }
}

export type StreamSummary = { tid: string; in: number | null; out: number | null; error: boolean; model?: string }

function parseSummary(raw: unknown): StreamSummary | null {
  if (!isRecord(raw)) return null
  return {
    tid: typeof raw.tid === 'string' ? raw.tid : '',
    in: typeof raw.in === 'number' ? raw.in : null,
    out: typeof raw.out === 'number' ? raw.out : null,
    error: raw.error === true,
    ...(typeof raw.model === 'string' && raw.model !== '' ? { model: raw.model } : {}),
  }
}

/** Run scripts/extract.py over the job's events; null when extraction fails. */
export async function summarizeEvents($: Engine, job: JobRecord, runner: Runner): Promise<StreamSummary | null> {
  try {
    const r = await $.process.run(
      ['python3', `${$.plugin.root}/scripts/extract.py`, `${job.dir}/events.jsonl`, runner],
      { timeoutMs: PROCESS_TIMEOUT_MS },
    )
    if (r.exitCode !== 0) return null
    const line = r.stdout.trim().split('\n').pop() ?? ''
    return parseSummary(JSON.parse(line))
  } catch {
    return null
  }
}

/** The last 20 stderr lines of a job, redacted; empty when none can be read. */
export async function stderrSnippet($: Engine, job: JobRecord): Promise<string> {
  try {
    const script = `# orq:stderr\ntail -n 20 ${shellWord(`${job.dir}/stderr.txt`)} 2>/dev/null; exit 0`
    const r = await $.process.run(['bash', '-c', script], { timeoutMs: 15000 })
    const text = r.stdout.trim()
    return text ? failureSnippet(text) : ''
  } catch {
    return ''
  }
}

/** Model and effort of a Codex job, read from its rollout under the instance's CODEX_HOME. */
async function codexModelEffort(
  $: Engine,
  config: OrqConfig,
  job: JobRecord,
  threadId: string,
): Promise<{ model: string; effort: string }> {
  const fallback = { model: job.model ?? '', effort: '' }
  if (!threadId) return fallback
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const instance = config.instances.find((i) => i.id === job.instanceId)
    const codexHome = instance?.env?.CODEX_HOME ?? (home ? `${home}/.codex` : '')
    if (!codexHome) return fallback
    const probe =
      `# orq:rollout\nfind -L ${shellWord(`${codexHome}/sessions`)} -name ${shellWord(`rollout-*-${threadId}.jsonl`)} ` +
      `2>/dev/null | sort | tail -n 1`
    const r = await $.process.run(['bash', '-c', probe], { timeoutMs: PROCESS_TIMEOUT_MS })
    const path = r.stdout.trim()
    if (!path) return fallback
    const parsed = parseRolloutModelEffort(await $.fs.read(path))
    return { model: parsed.model || fallback.model, effort: parsed.effort }
  } catch {
    return fallback
  }
}

export async function composeAnswer($: Engine, config: OrqConfig, job: JobRecord): Promise<string> {
  const view = await jobView($, job)
  if (view.status === 'running') return `orq: ${job.id} is still running`
  if (view.status === 'cancelling') return `orq: ${job.id} is still cancelling`
  if (view.status === 'interrupted') return `orq: ${job.id} was interrupted: its supervisor is gone and it left no exit file`
  if (view.status === 'cancelled') return `orq: ${job.id} was cancelled (exit 124)`
  const now = await $.clock.now()
  const durationMs = Math.max(0, (view.endedAt ?? now) - job.startedAt)
  const exitText = await readText($, `${job.dir}/exit`)
  const parsedExit = Number.parseInt((exitText ?? '').trim(), 10)
  const exitCode = Number.isFinite(parsedExit) ? parsedExit : -1
  const lastText = (await readText($, `${job.dir}/last.txt`)) ?? ''
  const runner = job.runner
  const summary = runner ? await summarizeEvents($, job, runner) : null
  if (exitCode !== 0 || !lastText || summary?.error) {
    const snippet = await stderrSnippet($, job)
    return `orq: ${job.id} failed (exit ${exitCode})` + (snippet ? `\n${snippet}` : '')
  }
  let model = summary?.model || job.model || 'n/a'
  let effort = 'n/a'
  if (runner === 'codex') {
    const rollout = await codexModelEffort($, config, job, summary?.tid ?? '')
    model = rollout.model || 'n/a'
    effort = rollout.effort || 'n/a'
  }
  const footer = buildFooter({
    kind: job.kind,
    model,
    effort,
    durationMs,
    inTokens: summary?.in ?? null,
    outTokens: summary?.out ?? null,
    session: summary?.tid || job.id,
  })
  return `${lastText}\n\n${footer}`
}

/** Parse `launch INSTANCE MODEL -- PROMPT`; the prompt is everything after the first ` -- `. */
export function parseLaunch(rest: string): { instance: string; model: string; prompt: string } | { error: string } {
  const m = /^(\S+)\s+(\S+)\s+--(?:\s+([\s\S]*))?$/.exec(rest.trim())
  if (!m) return { error: 'usage: /orq launch INSTANCE MODEL -- PROMPT' }
  const instance = m[1] ?? ''
  const model = m[2] ?? ''
  const prompt = (m[3] ?? '').trim()
  if (model.startsWith('-')) return { error: 'the model must not start with "-"' }
  if (prompt === '') return { error: 'the prompt after -- is empty' }
  return { instance, model, prompt }
}
