import type { EngineInterface } from 'claude-code'

import type { DriverKind, InstanceConfig, OrqConfig } from './config.ts'
import { isFailure, type GitFailure, type InteractionMode, type RuntimeMode, type TaskIsolation, type TaskStatus, type TaskStatusResult, type WorkState } from './contract.ts'
import { appliedEffort, effortFlag, hasControlCharacters, plainArgument, resolveTarget, runnerPolicy, taskPrompt } from './target.ts'
import { QUESTION_FILE } from './question.ts'
import { scopedCwd } from './scope.ts'
import type { TaskHeader } from './task-header.ts'
import {
  DRIVER_RUNNER,
  buildFooter,
  failureSnippet,
  isRecord,
  isWithin,
  isSafeJobId,
  parseJobMeta,
  parseRolloutModelEffort,
  refusalText,
  TASK_REFUSAL,
  rand36,
  shellWord,
  type JobRecord,
  type Runner,
} from './types.ts'
import {
  GIT_TIMEOUT_MS,
  branchDeleteArgv,
  branchFor,
  busyJob,
  gitDetail,
  type JobPlace,
  revParseHeadArgv,
  revParseToplevelArgv,
  WORKTREE_INCLUDE_DEADLINE_S,
  WORKTREE_INCLUDE_TIMEOUT_MS,
  worktreeAddArgv,
  worktreePathFor,
  worktreeRemoveArgv,
} from './worktree.ts'

export type Engine = Pick<EngineInterface, 'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>

/** The part of `$` the job core calls: the mod passes its `$`, and the MCP server passes `server/node-engine.ts`. */
export type CoreEngine = {
  clock: Pick<EngineInterface['clock'], 'now'>
  env: Pick<EngineInterface['env'], 'get'>
  fs: Pick<EngineInterface['fs'], 'write' | 'list' | 'exists' | 'stat'> & { read: (path: string) => Promise<string> }
  plugin: Pick<EngineInterface['plugin'], 'root'>
  process: Pick<EngineInterface['process'], 'run'>
  ui: Pick<EngineInterface['ui'], 'log'>
}

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
  /** Extra runner arguments, one argv item each, written to the job's flags file. */
  flags?: string[]
  runtimeMode?: RuntimeMode
  interactionMode?: InteractionMode
  /** The reasoning effort `flags` give the CLI, recorded for the answer's footer. */
  effort?: string
  /** `worktree` runs the task in its own git worktree on a new branch; absent runs in `cwd` as it is. */
  isolation?: 'worktree'
  /** When set, the checkout that holds `cwd` must lie inside one of these resolved roots to get a worktree. */
  worktreeScope?: string[]
}

export type TaskLaunchSpec = {
  agentId: string
  instance: InstanceConfig
  model: string
  cwd: string
  prompt: string
  flags: string[]
  runtimeMode: RuntimeMode
  interactionMode: InteractionMode
  effort?: string
  isolation: TaskIsolation
  /** The session directory and the allowed roots that scoped `cwd`. */
  scopeRoots: string[]
}

export type LaunchResult = { job: JobRecord } | { refusal: string }

/** `workdir` is where the job runs: the worktree, or the same subdirectory of it that `repo` is of `toplevel`. */
export type WorktreePlan = { repo: string; toplevel: string; baseSha: string; branch: string; worktree: string; workdir: string }

export type WorktreeResult = { plan: WorktreePlan } | { failure: GitFailure }

async function readText($: CoreEngine, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function isDirectory($: CoreEngine, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'dir'
  } catch {
    return false
  }
}

/** The question a job wrote to question.txt, trimmed; null when the file is missing or blank. */
export async function readQuestion($: CoreEngine, job: JobRecord): Promise<string | null> {
  const text = ((await readText($, `${job.dir}/${QUESTION_FILE}`)) ?? '').trim()
  return text === '' ? null : text
}

async function exists($: CoreEngine, path: string): Promise<boolean> {
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

export async function writeCancel($: CoreEngine, job: JobRecord, reason?: string): Promise<void> {
  await $.fs.write(`${job.dir}/cancel`, cancelText(reason))
}

/** Read one job's meta.json. Unsafe ids and unreadable or incomplete metadata give null. */
export async function readMeta($: CoreEngine, jobsDir: string, id: string): Promise<JobRecord | null> {
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
export async function listJobs($: CoreEngine, jobsDir: string): Promise<JobRecord[]> {
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

async function mtimeMs($: CoreEngine, path: string): Promise<number | null> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return null
  }
}

/** The exit file holds one whole number. Anything else, an empty file included, is -1, which counts as failed. */
export function parseExit(text: string | null): number {
  return text !== null && /^\s*\d+\s*$/.test(text) ? Number.parseInt(text, 10) : -1
}

export type Finished = {
  status: 'done' | 'failed' | 'cancelled'
  exitCode: number
  endedAt: number | null
  lastText: string
  summary: StreamSummary | null
  /** The question a job left in question.txt when it exited 0 and stopped there; null otherwise. */
  question: string | null
}

/**
 * The one rule for a job that has ended, shared by /orq list and /orq result. Exit 124 is cancelled.
 * A clean exit 0 that left a question is done, and its answer is the question. Otherwise the job is
 * done only when the exit is 0, last.txt holds a non-empty message, and the extractor reports no
 * error; anything else is failed.
 */
export async function finishedOutcome($: CoreEngine, job: JobRecord, exitText: string | null): Promise<Finished> {
  const exitCode = parseExit(exitText)
  const endedAt = await mtimeMs($, `${job.dir}/exit`)
  if (exitCode === 124) return { status: 'cancelled', exitCode, endedAt, lastText: '', summary: null, question: null }
  const question = await readQuestion($, job)
  if (exitCode === 0 && question !== null) {
    return { status: 'done', exitCode, endedAt, lastText: '', summary: null, question }
  }
  const lastText = (await readText($, `${job.dir}/last.txt`)) ?? ''
  if (exitCode !== 0 || lastText.trim() === '') {
    return { status: 'failed', exitCode, endedAt, lastText, summary: null, question: null }
  }
  const summary = job.runner ? await summarizeEvents($, job, job.runner) : null
  const status = summary?.error ? 'failed' : 'done'
  return { status, exitCode, endedAt, lastText, summary, question: null }
}

export type JobView =
  | { status: 'running' | 'cancelling' | 'interrupted' | 'waiting'; endedAt: null }
  | Finished

export async function jobView($: CoreEngine, job: JobRecord): Promise<JobView> {
  const exit = await readText($, `${job.dir}/exit`)
  if (exit !== null) return finishedOutcome($, job, exit)
  const liveness = await jobLiveness($, job)
  if (liveness === 'gone') return { status: 'interrupted', endedAt: null }
  if (liveness === 'running') {
    if ((await readQuestion($, job)) !== null) return { status: 'waiting', endedAt: null }
    return { status: (await exists($, `${job.dir}/cancel`)) ? 'cancelling' : 'running', endedAt: null }
  }
  return finishedOutcome($, job, await readText($, `${job.dir}/exit`))
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
  const env = { ...args.env, ORQ_JOB_DIR: args.dir }
  const pairs = Object.entries(env).map(([k, v]) => shellWord(`${k}=${v}`))
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

async function markLaunchFailed($: CoreEngine, dir: string): Promise<void> {
  try {
    await $.fs.write(`${dir}/exit`, '125')
  } catch {
    /* the refusal the caller returns is the signal */
  }
}

async function debugLog($: CoreEngine, text: string): Promise<void> {
  try {
    await $.ui.log(text, { to: 'debug' })
  } catch {
    /* the refusal the caller returns is the signal */
  }
}

/**
 * Best effort after a launch failed once its worktree existed: remove the worktree, then its branch.
 * A failed undo goes to the debug log, and the refusal still names the launch's own failure.
 */
async function unwindWorktree($: CoreEngine, plan: WorktreePlan): Promise<void> {
  const undo: [string, string[]][] = [
    ['remove the worktree', worktreeRemoveArgv(plan.repo, plan.worktree)],
    ['delete the branch', branchDeleteArgv(plan.repo, plan.branch)],
  ]
  for (const [what, argv] of undo) {
    try {
      // A worktree can hold a copied node_modules, so its removal gets the copy's time.
      const r = await $.process.run(argv, { timeoutMs: WORKTREE_INCLUDE_TIMEOUT_MS })
      if (r.exitCode !== 0) await debugLog($, `orq: could not ${what} after a failed launch${gitDetail(r.stderr)}`)
    } catch (err) {
      await debugLog($, `orq: could not ${what} after a failed launch: ${String(err)}`)
    }
  }
}

/**
 * The id of a live job that runs in `path` or is a worktree of the checkout `path`, or null. A job is live
 * while its supervisor runs. Only the jobs that hold the path are asked, so a launch does not check every job
 * in the directory. It reads the job directory rather than memory, so it holds across sessions.
 */
export async function checkoutBusy($: CoreEngine, jobsDir: string, path: string): Promise<string | null> {
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(jobsDir)
  } catch {
    return null
  }
  const places: JobPlace[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const job = await readMeta($, jobsDir, entry.name)
    if (job === null || (job.cwd !== path && job.repo !== path)) continue
    places.push({
      id: job.id,
      cwd: job.cwd,
      ...(job.repo !== undefined ? { repo: job.repo } : {}),
      live: (await jobLiveness($, job)) === 'running',
    })
  }
  return busyJob(places, path)
}

/**
 * Best effort: the script stages the copy beside the worktree and renames it in only when it is complete, so a
 * copy that fails leaves the worktree as git made it, which is what a checkout without .worktreeinclude gets.
 */
async function copyWorktreeIncludes($: CoreEngine, toplevel: string, worktree: string): Promise<void> {
  const script = `${$.plugin.root}/scripts/worktree-include.py`
  try {
    const argv = ['python3', script, toplevel, worktree, String(WORKTREE_INCLUDE_DEADLINE_S)]
    const r = await $.process.run(argv, { timeoutMs: WORKTREE_INCLUDE_TIMEOUT_MS })
    if (r.exitCode === 1) {
      await debugLog($, `orq: .worktreeinclude copy into ${worktree} failed and was undone${gitDetail(r.stderr)}`)
      return
    }
    if (r.exitCode === 3) {
      await debugLog($, `orq: .worktreeinclude copy into ${worktree} failed and part of it is still there${gitDetail(r.stderr)}`)
      return
    }
    if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`)
    const counts = JSON.parse(r.stdout) as { copied?: unknown; skipped?: unknown }
    if (typeof counts.copied === 'number' && typeof counts.skipped === 'number' && counts.copied + counts.skipped > 0) {
      await debugLog($, `orq: .worktreeinclude copied ${counts.copied} and skipped ${counts.skipped} file(s) into ${worktree}`)
    }
  } catch (err) {
    // A killed copy can leave its staging directory beside the worktree, never a partial tree inside it.
    await debugLog($, `orq: .worktreeinclude copy into ${worktree} did not finish: ${String(err)}`)
    try {
      await $.process.run(['python3', script, '--discard', worktree], { timeoutMs: WORKTREE_INCLUDE_TIMEOUT_MS })
    } catch {
      /* the staging directory stays beside the worktree, outside it */
    }
  }
}

/**
 * Plan and create the worktree of task TASK_ID: REPO_PARENT/REPO_NAME-wt/TASK_ID on a new branch
 * orq/TASK_ID, cut from the checkout's HEAD. Refuses, and creates nothing, when cwd is not a git
 * checkout. The path names the id the launch has just claimed, so no other job can hold it.
 */
export async function prepareWorktree($: CoreEngine, cwd: string, taskId: string, scope?: string[]): Promise<WorktreeResult> {
  try {
    const top = await $.process.run(revParseToplevelArgv(cwd), { timeoutMs: GIT_TIMEOUT_MS })
    if (top.exitCode !== 0) {
      return { failure: { code: 'not_a_repository', message: `${cwd} is not inside a git checkout${gitDetail(top.stderr)}` } }
    }
    const toplevel = top.stdout.trim()
    // The worktree copies the whole checkout, so a checkout that reaches above the scope is refused.
    if (scope !== undefined && !scope.some((root) => isWithin(toplevel, root))) {
      return {
        failure: {
          code: 'cwd_out_of_scope',
          message: `the git checkout ${toplevel} that holds ${cwd} is outside the session directory and the allowed roots`,
        },
      }
    }
    const head = await $.process.run(revParseHeadArgv(cwd), { timeoutMs: GIT_TIMEOUT_MS })
    const baseSha = head.stdout.trim()
    if (head.exitCode !== 0 || baseSha === '') {
      return { failure: { code: 'git_failed', message: `${cwd} has no HEAD commit to start a worktree from${gitDetail(head.stderr)}` } }
    }
    const worktree = worktreePathFor(toplevel, taskId)
    const branch = branchFor(taskId)
    const subdir = cwd !== toplevel && isWithin(cwd, toplevel) ? cwd.slice(toplevel.length) : ''
    const plan: WorktreePlan = { repo: cwd, toplevel, baseSha, branch, worktree, workdir: `${worktree}${subdir}` }
    try {
      const add = await $.process.run(worktreeAddArgv(cwd, worktree, branch, baseSha), { timeoutMs: GIT_TIMEOUT_MS })
      if (add.exitCode !== 0) {
        return { failure: { code: 'git_failed', message: `git worktree add ${worktree} failed${gitDetail(add.stderr)}` } }
      }
    } catch (err) {
      // A timeout or a kill can leave a half-made worktree and its branch behind.
      await unwindWorktree($, plan)
      return { failure: { code: 'git_failed', message: `git worktree add ${worktree} did not finish: ${String(err)}` } }
    }
    // The worktree holds HEAD only, so an untracked or new cwd has no counterpart there.
    if (!(await isDirectory($, plan.workdir))) {
      await unwindWorktree($, plan)
      return {
        failure: {
          code: 'invalid_request',
          message: `${cwd} is not in HEAD of its checkout, so the worktree has no such directory; commit it, or use isolation: shared`,
        },
      }
    }
    await copyWorktreeIncludes($, toplevel, worktree)
    return { plan }
  } catch (err) {
    return { failure: { code: 'git_failed', message: `git could not run: ${String(err)}` } }
  }
}

/** Create a job directory, write meta.json and prompt.txt, and start the supervisor detached. */
export async function launchJob($: CoreEngine, config: OrqConfig, spec: LaunchSpec): Promise<LaunchResult> {
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
    // The id is claimed by the mkdir, so the worktree path can name it. Nothing is created before the claim.
    let cwd = spec.cwd
    let plan: WorktreePlan | null = null
    if (spec.isolation === 'worktree') {
      const prepared = await prepareWorktree($, spec.cwd, id, spec.worktreeScope)
      if ('failure' in prepared) {
        await markLaunchFailed($, dir)
        return { refusal: `orq: ${spec.kind} refused: ${prepared.failure.code}: ${prepared.failure.message}` }
      }
      plan = prepared.plan
      cwd = plan.workdir
    } else {
      // A shared launch writes into its checkout, so a live job there, or in a worktree of it, refuses it.
      const busy = await checkoutBusy($, config.jobsDir, spec.cwd)
      if (busy !== null) {
        await markLaunchFailed($, dir)
        return { refusal: `orq: ${spec.kind} refused: worktree_busy: ${spec.cwd} is in use by job ${busy}` }
      }
    }
    const worktreeFields = plan
      ? { repo: plan.repo, baseSha: plan.baseSha, branch: plan.branch, worktree: plan.worktree }
      : {}
    const startedAtIso = new Date(now).toISOString()
    const meta = {
      id,
      kind: spec.kind,
      agentId: spec.agentId,
      cwd,
      startedAt: now,
      startedAtIso,
      runner: spec.runner,
      model: spec.model,
      instanceId: spec.instanceId,
      driver: spec.driver,
      ...(spec.env.CODEX_HOME !== undefined ? { codexHome: spec.env.CODEX_HOME } : {}),
      ...(spec.runtimeMode !== undefined ? { runtimeMode: spec.runtimeMode } : {}),
      ...(spec.interactionMode !== undefined ? { interactionMode: spec.interactionMode } : {}),
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      ...worktreeFields,
    }
    try {
      await $.fs.write(`${dir}/meta.json`, JSON.stringify(meta))
      await $.fs.write(`${dir}/prompt.txt`, spec.prompt)
      if (spec.flags !== undefined && spec.flags.length > 0) {
        await $.fs.write(`${dir}/flags`, spec.flags.map((flag) => `${flag}\n`).join(''))
      }
    } catch (err) {
      await markLaunchFailed($, dir)
      if (plan) await unwindWorktree($, plan)
      return { refusal: `orq: ${spec.kind} could not write its job directory: ${String(err)}` }
    }
    const script = startScript({
      id,
      dir,
      supervise,
      runner: spec.runner,
      cwd,
      model: spec.model,
      env: spec.env,
    })
    let startCode: number
    try {
      const r = await $.process.run(['bash', '-c', script], { timeoutMs: PROCESS_TIMEOUT_MS })
      startCode = r.exitCode
    } catch (err) {
      await markLaunchFailed($, dir)
      if (plan) await unwindWorktree($, plan)
      return { refusal: `orq: ${spec.kind} could not start its job: ${String(err)}` }
    }
    if (startCode !== 0) {
      await markLaunchFailed($, dir)
      if (plan) await unwindWorktree($, plan)
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
      cwd,
      startedAt: now,
      startedAtIso,
      runner: spec.runner,
      model: spec.model,
      instanceId: spec.instanceId,
      driver: spec.driver,
      ...(spec.env.CODEX_HOME !== undefined ? { codexHome: spec.env.CODEX_HOME } : {}),
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      ...worktreeFields,
    }
    if (pgid) job.pgid = pgid
    return { job }
  }
  return { refusal: `orq: ${spec.kind} could not pick a job id without collision` }
}

/**
 * Launch one cc-orq:task job. The model and each runner flag reach the CLI as one argv item, so a value
 * that could read as an option or span lines is refused before anything is written.
 */
export async function launchTaskJob($: CoreEngine, config: OrqConfig, spec: TaskLaunchSpec): Promise<LaunchResult> {
  if (!plainArgument(spec.model)) {
    return { refusal: `${TASK_REFUSAL}: the model must be one word that does not start with "-" and has no control characters.` }
  }
  if (spec.flags.some((flag) => flag === '' || hasControlCharacters(flag))) {
    return { refusal: `${TASK_REFUSAL}: a runner flag is empty or contains a control character.` }
  }
  const launched = await launchJob($, config, {
    kind: 'task',
    agentId: spec.agentId,
    runner: DRIVER_RUNNER[spec.instance.driver],
    model: spec.model,
    cwd: spec.cwd,
    prompt: spec.prompt,
    env: spec.instance.env ?? {},
    instanceId: spec.instance.id,
    driver: spec.instance.driver,
    flags: spec.flags,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    ...(spec.isolation === 'worktree' ? { isolation: 'worktree' as const, worktreeScope: spec.scopeRoots } : {}),
  })
  if (!('refusal' in launched)) return launched
  // launchJob words its refusals for any kind; a task's are answered as task refusals.
  const refusal = launched.refusal.replace(/^orq: task (refused: )?/, `${TASK_REFUSAL}: `)
  const hint = spec.isolation === 'worktree' && refusal.includes('not_a_repository')
    ? '. Pass `isolation: shared` to run the task in this directory as it is.'
    : ''
  return { refusal: refusal + hint }
}

/** A refused header comes back as `{ refusal }`, not as a throw. */
export async function launchTaskFromHeader(
  $: CoreEngine,
  config: OrqConfig,
  args: {
    agentId: string
    header: TaskHeader
    ceiling: { runtimeMode: RuntimeMode; interactionMode: InteractionMode }
    sessionDir: string
  },
): Promise<LaunchResult> {
  const { agentId, header, ceiling, sessionDir } = args
  const resolved = resolveTarget({
    target: header.target,
    instances: config.instances,
    parentRuntimeMode: ceiling.runtimeMode,
    parentInteractionMode: ceiling.interactionMode,
    runtimeMode: header.runtimeMode ?? 'inherit',
    interactionMode: header.interactionMode ?? 'inherit',
  })
  if (isFailure(resolved)) return { refusal: refusalText(resolved) }
  const policy = runnerPolicy(resolved.instance.driver, resolved.runtimeMode, resolved.interactionMode)
  if (isFailure(policy)) return { refusal: refusalText(policy) }
  const scoped = await scopedCwd($, config, sessionDir, header.cwd)
  if ('refusal' in scoped) return scoped
  const effort = appliedEffort(resolved.instance.driver, resolved.options)
  return launchTaskJob($, config, {
    agentId,
    instance: resolved.instance,
    model: resolved.model,
    cwd: scoped.cwd,
    prompt: taskPrompt(header.prompt, header.role),
    flags: [...policy.flags, ...effortFlag(resolved.instance.driver, resolved.options)],
    runtimeMode: resolved.runtimeMode,
    interactionMode: resolved.interactionMode,
    ...(effort !== undefined ? { effort } : {}),
    isolation: header.isolation,
    scopeRoots: scoped.roots,
  })
}

/** finished | running | gone: the exit file, else the supervisor's process group. Rejects when the probe cannot run. */
async function probeLiveness($: CoreEngine, job: JobRecord): Promise<'finished' | 'running' | 'gone'> {
  if (await exists($, `${job.dir}/exit`)) return 'finished'
  const script =
    `# orq:liveness\npgid=$(cat ${shellWord(`${job.dir}/pgid`)} 2>/dev/null | tr -d ' \\t\\n')\n` +
    `case "$pgid" in ''|*[!0-9]*) exit 12 ;; esac\n` +
    `kill -0 -"$pgid" 2>/dev/null && exit 11\n` +
    `[ -e ${shellWord(`${job.dir}/exit`)} ] && exit 0 || exit 12`
  const r = await $.process.run(['bash', '-c', script], { timeoutMs: 15000 })
  if (r.exitCode === 0) return 'finished'
  if (r.exitCode === 11) return 'running'
  return 'gone'
}

/** finished | running | gone: the exit file, else the supervisor's process group. A probe that cannot run counts as running. */
export async function jobLiveness($: CoreEngine, job: JobRecord): Promise<'finished' | 'running' | 'gone'> {
  try {
    return await probeLiveness($, job)
  } catch {
    return 'running'
  }
}

/** The supervisor takes up to 5 s to write its pgid, so a job that began less than this ago may still be starting. */
export const LAUNCH_GRACE_MS = 10_000

/**
 * Whether a job may still be working, for a caller that must not act under a live job. jobLiveness reads a job
 * with no pgid yet as gone, though its supervisor is about to write one, and a probe that cannot run as running
 * for good. Here a job younger than LAUNCH_GRACE_MS counts as running in both states, and an older one as gone.
 */
export async function jobIsLive($: CoreEngine, job: JobRecord): Promise<boolean> {
  if (await exists($, `${job.dir}/exit`)) return false
  const starting = (await $.clock.now()) - job.startedAt < LAUNCH_GRACE_MS
  const pgid = ((await readText($, `${job.dir}/pgid`)) ?? '').trim()
  if (!/^\d+$/.test(pgid)) return starting
  try {
    return (await probeLiveness($, job)) === 'running'
  } catch {
    return starting
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
export async function summarizeEvents($: CoreEngine, job: JobRecord, runner: Runner): Promise<StreamSummary | null> {
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
export async function stderrSnippet($: CoreEngine, job: JobRecord): Promise<string> {
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
  $: CoreEngine,
  config: OrqConfig,
  job: JobRecord,
  threadId: string,
): Promise<{ model: string; effort: string }> {
  const fallback = { model: job.model ?? '', effort: '' }
  if (!threadId) return fallback
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const instance = config.instances.find((i) => i.id === job.instanceId)
    const codexHome = job.codexHome ?? instance?.env?.CODEX_HOME ?? (home ? `${home}/.codex` : '')
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

/** The one-line answer for a job that has not ended, or was interrupted. */
export function notEndedText(id: string, status: 'running' | 'cancelling' | 'interrupted' | 'waiting'): string {
  if (status === 'running') return `orq: ${id} is still running`
  if (status === 'cancelling') return `orq: ${id} is still cancelling`
  if (status === 'waiting') return `orq: ${id} is waiting for an answer to its question`
  return `orq: ${id} was interrupted: its supervisor is gone and it left no exit file`
}

/** The answer for a job that stopped on a question. The parent answers it in a new task, not in this one. */
export function blockedText(id: string, question: string): string {
  return `BLOCKED on a question (taskId ${id}): ${question}\n\nAnswer it in a new cc-orq:task with the original brief plus the answer.`
}

export async function composeAnswer($: CoreEngine, config: OrqConfig, job: JobRecord): Promise<string> {
  const view = await jobView($, job)
  if (!('exitCode' in view)) return notEndedText(job.id, view.status)
  if (view.status === 'cancelled') return `orq: ${job.id} was cancelled (exit 124)`
  if (view.question !== null) return blockedText(job.id, view.question)
  if (view.status === 'failed') {
    const snippet = await stderrSnippet($, job)
    return `orq: ${job.id} failed (exit ${view.exitCode})` + (snippet ? `\n${snippet}` : '')
  }
  const summary = view.summary
  const now = await $.clock.now()
  const durationMs = Math.max(0, (view.endedAt ?? now) - job.startedAt)
  const runner = job.runner
  let model = summary?.model || job.model || 'n/a'
  let effort = job.effort || 'n/a'
  if (runner === 'codex') {
    const rollout = await codexModelEffort($, config, job, summary?.tid ?? '')
    model = rollout.model || 'n/a'
    effort = rollout.effort || effort
  }
  const footer = buildFooter({
    kind: job.kind,
    model,
    effort,
    durationMs,
    inTokens: summary?.in ?? null,
    outTokens: summary?.out ?? null,
    taskId: job.id,
    session: summary?.tid || job.id,
  })
  return `${view.lastText}\n\n${footer}`
}

/**
 * Parse `[--worktree] INSTANCE MODEL -- PROMPT`; the prompt is everything after the first ` -- `.
 * The flag sits before the instance and is reported as `worktree: true` only when given.
 */
export function parseLaunch(
  rest: string,
): { instance: string; model: string; prompt: string; worktree?: true } | { error: string } {
  const trimmed = rest.trim()
  const flag = /^--worktree(?:\s+|$)/.exec(trimmed)
  const m = /^(\S+)\s+(\S+)\s+--(?:\s+([\s\S]*))?$/.exec(flag ? trimmed.slice(flag[0].length) : trimmed)
  if (!m) return { error: 'usage: /orq launch [--worktree] INSTANCE MODEL -- PROMPT' }
  const instance = m[1] ?? ''
  const model = m[2] ?? ''
  const prompt = (m[3] ?? '').trim()
  if (model.startsWith('-')) return { error: 'the model must not start with "-"' }
  if (prompt === '') return { error: 'the prompt after -- is empty' }
  return flag ? { instance, model, prompt, worktree: true } : { instance, model, prompt }
}

/** The task status a job view answers with. A cancel marker on a live job still reads as running. */
export function taskStatusOf(view: JobView): TaskStatus {
  switch (view.status) {
    case 'running':
    case 'cancelling':
      return 'running'
    case 'done':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'interrupted':
      return 'interrupted'
    case 'waiting':
      return 'waiting'
  }
}

/** A task that has ended has a final result or error for its parent to read: result_available. */
function workStateOf(status: TaskStatus): WorkState {
  if (status === 'running' || status === 'queued') return 'working'
  // A waiting task waits on its parent's answer, not on children of its own.
  if (status === 'waiting') return 'working'
  return 'result_available'
}

const INTERRUPTED_ERROR = 'its supervisor is gone and it left no exit file'

/** One job as the task tools answer it, read from its directory alone. Null for an unknown or unsafe id. */
export async function readJobStatus($: CoreEngine, config: OrqConfig, jobId: string): Promise<TaskStatusResult | null> {
  const job = await readMeta($, config.jobsDir, jobId)
  if (!job) return null
  const view = await jobView($, job)
  const status = taskStatusOf(view)
  const answer: TaskStatusResult = {
    taskId: job.id,
    status,
    workState: workStateOf(status),
    kind: job.kind,
    startedAtIso: job.startedAtIso,
    ...(job.instanceId ? { instanceId: job.instanceId } : {}),
    ...(job.model ? { model: job.model } : {}),
    ...(view.endedAt !== null ? { finishedAtIso: new Date(view.endedAt).toISOString() } : {}),
  }
  if (view.status === 'done') return { ...answer, result: view.question !== null ? blockedText(job.id, view.question) : view.lastText }
  if (view.status === 'failed') {
    const snippet = await stderrSnippet($, job)
    return { ...answer, error: `failed (exit ${view.exitCode})` + (snippet ? `\n${snippet}` : '') }
  }
  if (view.status === 'interrupted') return { ...answer, error: INTERRUPTED_ERROR }
  return answer
}
