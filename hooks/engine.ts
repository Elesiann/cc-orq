import type { EngineInterface } from 'claude-code'

import type { DriverKind, InstanceConfig, OrqConfig } from './config.ts'
import { EFFORT_OPTION, fail, isFailure, type Failure, type GitFailure, type InteractionMode, type RuntimeMode, type TaskIsolation, type TaskStatus, type TaskStatusResult, type WorkState } from './contract.ts'
import { appliedEffort, effortFlag, hasControlCharacters, plainArgument, resolveTarget, runnerPolicy, taskPrompt } from './target.ts'
import { QUESTION_FILE } from './question.ts'
import { LAUNCH_GRACE_MS, claimCheckout, rearmLock, releaseLock, type Checkout, type HeldLock, type OwnerProbe } from './lock.ts'
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
  gitArgv,
  gitDetail,
  NO_HOOKS,
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

/** Who answers a question the worker asks: the parent session, or the human through a form. */
export type QuestionMode = 'parent' | 'human'

export type LaunchSpec = {
  kind: string
  reservedId?: string
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
  /** Recorded in meta.json for a job the server launches. */
  questions?: QuestionMode
  /** `worktree` runs the task in its own git worktree on a new branch; absent runs in `cwd` as it is. */
  isolation?: 'worktree'
  /** When set, the checkout that holds `cwd` must lie inside one of these resolved roots to get a worktree. */
  worktreeScope?: string[]
  /** Set for a job that resumes the worker of another: `cwd` is that job's, and no worktree is made or removed for it. */
  continuation?: Continuation
}

/** What a job that answers a question takes over from the job that asked it. */
export type Continuation = {
  parent: string
  /** The session id of the worker, which the supervisor resumes. */
  session: string
  /** The worktree of the task, which the job keeps working in; absent for a task that ran in the checkout itself. */
  worktree?: Pick<WorktreePlan, 'repo' | 'baseSha' | 'branch' | 'worktree'>
}

export type TaskLaunchSpec = {
  /** The job kind: `task` for the cc-orq:task agent, which is the default, and `mcp` for the server's delegate. */
  kind?: string
  reservedId?: string
  questions?: QuestionMode
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
 * Stands in for `setsid` where the binary is missing, as on macOS. Python starts with SIGPIPE and SIGXFSZ
 * ignored, and an exec keeps an ignored signal ignored, so both go back to their defaults before the exec.
 */
const PYTHON_SETSID =
  'import os, signal, sys; signal.signal(signal.SIGPIPE, signal.SIG_DFL); signal.signal(signal.SIGXFSZ, signal.SIG_DFL); os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])'

/**
 * Start script for one job. The instance env is passed as --setenv for the
 * systemd unit and as `env K=V` for the setsid launchers, so both reach the CLI.
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
  const scope = shellWord(`${args.dir}/scope`)
  // A job in the caller's cgroup dies with the terminal or session that launched it; a transient user
  // unit gets its own, and stopping it also reaps children that escaped the process group. setsid is
  // the fallback when no user manager is reachable.
  return (
    `# orq:start\n` +
    `if systemd-run --user --quiet --collect --unit=${shellWord(`orq-${args.id}`)} --setenv=PATH="$PATH" --setenv=HOME="$HOME" ${setenv} ` +
    `bash -c ${shellWord(`exec ${supervisorCmd}`)} 2>/dev/null; then echo systemd > ${scope}\n` +
    `elif command -v setsid >/dev/null 2>&1; then echo setsid > ${scope}; setsid env ${envAssign} ${supervisorCmd} &\n` +
    `else echo python-setsid > ${scope}; python3 -I -c ${shellWord(PYTHON_SETSID)} env ${envAssign} ${supervisorCmd} &\n` +
    `fi\n` +
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
 * The id of a live job that runs inside `checkout` or is a worktree of it, or null. A job is live while its
 * supervisor runs. The lock covers the jobs that claimed one; this covers the rest, the jobs 0.1 launched and
 * the worktree jobs, and it reads the job directory rather than memory, so it holds across sessions. A job
 * stores the path its launch was given, so `spelling`, the path of this launch, finds a job stored under a
 * symlink that leads to the checkout, as 0.1 did. `rearm` runs before each job is read, so a scan of a large
 * jobs directory can keep the launch's lock young.
 */
export async function checkoutBusy(
  $: CoreEngine,
  jobsDir: string,
  checkout: Checkout,
  launch: { spelling?: string; rearm?: () => Promise<unknown> } = {},
): Promise<string | null> {
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(jobsDir)
  } catch {
    return null
  }
  const roots = launch.spelling === undefined ? [checkout.key] : [checkout.key, launch.spelling]
  // Outside a repository the directory itself is the checkout, so only a job in that very directory counts.
  const holds = (path: string, root: string): boolean => (checkout.repository ? isWithin(path, root) : path === root)
  const inside = (path: string | undefined): boolean => path !== undefined && roots.some((root) => holds(path, root))
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    await launch.rearm?.()
    const job = await readMeta($, jobsDir, entry.name)
    if (job === null || !(inside(job.cwd) || inside(job.repo))) continue
    if ((await jobLiveness($, job)) === 'running') return job.id
  }
  return null
}

/** Where the job that owns a lock stands: no exit file and no pgid yet is a launch that has not started its supervisor. */
function ownerStateProbe($: CoreEngine, jobsDir: string): OwnerProbe {
  return async (id) => {
    const dir = `${jobsDir}/${id}`
    if (await exists($, `${dir}/exit`)) return 'finished'
    const pgid = ((await readText($, `${dir}/pgid`)) ?? '').trim()
    return /^\d+$/.test(pgid) ? jobLiveness($, { dir }) : 'unstarted'
  }
}

function busyRefusal(kind: string, cwd: string, owner: string | null): string {
  return `orq: ${kind} refused: worktree_busy: ${cwd} is in use by ${owner === null ? 'a launch in progress' : `job ${owner}`}`
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

export function newJobId(kind: string, now: number, agentId: string): string {
  return `${kind}-${now}-${agentId.slice(-8)}-${rand36()}`
}

/** Create a job directory, write meta.json and prompt.txt, and start the supervisor detached. */
export async function launchJob($: CoreEngine, config: OrqConfig, spec: LaunchSpec): Promise<LaunchResult> {
  const resumed = spec.continuation
  const now = await $.clock.now()
  const supervise = `${$.plugin.root}/scripts/supervise.sh`
  const ownerOf = ownerStateProbe($, config.jobsDir)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = spec.reservedId ?? newJobId(spec.kind, now, spec.agentId)
    const dir = `${config.jobsDir}/${id}`
    let mkdirCode: number
    try {
      const r = await $.process.run(['bash', '-c', mkdirScript(config.jobsDir, dir)], { timeoutMs: PROCESS_TIMEOUT_MS })
      mkdirCode = r.exitCode
    } catch (err) {
      return { refusal: `orq: ${spec.kind} could not create its job directory: ${String(err)}` }
    }
    if (mkdirCode === 7 && attempt === 0 && spec.reservedId === undefined) continue
    if (mkdirCode !== 0) {
      return { refusal: `orq: ${spec.kind} could not create its job directory (exit ${mkdirCode})` }
    }
    // The id is claimed by the mkdir, so the worktree path can name it. Nothing is created before the claim.
    let cwd = spec.cwd
    let plan: WorktreePlan | null = null
    let held: HeldLock | null = null
    const abandon = async (refusal: string): Promise<LaunchResult> => {
      await markLaunchFailed($, dir)
      if (plan) await unwindWorktree($, plan)
      if (held) await releaseLock($, held, ownerOf)
      return { refusal }
    }
    if (resumed?.worktree !== undefined) {
      // The worktree is the task's, and no other job runs in it, so there is nothing to create, lock or undo.
    } else if (spec.isolation === 'worktree') {
      const prepared = await prepareWorktree($, spec.cwd, id, spec.worktreeScope)
      if ('failure' in prepared) {
        return abandon(`orq: ${spec.kind} refused: ${prepared.failure.code}: ${prepared.failure.message}`)
      }
      plan = prepared.plan
      cwd = plan.workdir
    } else {
      // The scan after the claim sees what holds no lock: jobs 0.1 launched, and worktree jobs.
      const claim = await claimCheckout($, config.jobsDir, id, spec.cwd, ownerOf)
      if (claim.kind === 'failed') return abandon(`orq: ${spec.kind} could not lock its checkout (${claim.detail})`)
      if (claim.kind === 'busy') return abandon(busyRefusal(spec.kind, spec.cwd, claim.owner))
      const lock = claim.held
      held = lock
      const busy = await checkoutBusy($, config.jobsDir, claim.checkout, { spelling: spec.cwd, rearm: () => rearmLock($, lock) })
      if (busy !== null) return abandon(busyRefusal(spec.kind, spec.cwd, busy))
      // A scan that outlasted the grace may have let another launcher break this lock and start its job.
      if (!(await rearmLock($, lock, { force: true }))) return abandon(busyRefusal(spec.kind, spec.cwd, null))
    }
    const worktreeFields = plan
      ? { repo: plan.repo, baseSha: plan.baseSha, branch: plan.branch, worktree: plan.worktree }
      : (resumed?.worktree ?? {})
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
      ...(spec.questions !== undefined ? { questions: spec.questions } : {}),
      ...(resumed !== undefined ? { parent: resumed.parent } : {}),
      ...worktreeFields,
    }
    try {
      await $.fs.write(`${dir}/meta.json`, JSON.stringify(meta))
      await $.fs.write(`${dir}/prompt.txt`, spec.prompt)
      if (spec.flags !== undefined && spec.flags.length > 0) {
        await $.fs.write(`${dir}/flags`, spec.flags.map((flag) => `${flag}\n`).join(''))
      }
      if (resumed !== undefined) await $.fs.write(`${dir}/resume`, `${resumed.session}\n`)
    } catch (err) {
      return abandon(`orq: ${spec.kind} could not write its job directory: ${String(err)}`)
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
    // The job files above may have taken longer than the grace, so another launcher may have broken this lock since the last touch.
    if (held && !(await rearmLock($, held, { force: true }))) return abandon(busyRefusal(spec.kind, spec.cwd, null))
    let startCode: number
    try {
      const r = await $.process.run(['bash', '-c', script], { timeoutMs: PROCESS_TIMEOUT_MS })
      startCode = r.exitCode
    } catch (err) {
      return abandon(`orq: ${spec.kind} could not start its job: ${String(err)}`)
    }
    if (startCode !== 0) {
      return abandon(
        startCode === 11
          ? `orq: ${spec.kind} failed to start (supervisor did not report within 5 s)`
          : `orq: ${spec.kind} failed to start (exit ${startCode})`,
      )
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
      ...(resumed !== undefined ? { parent: resumed.parent } : {}),
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
  const kind = spec.kind ?? 'task'
  const launched = await launchJob($, config, {
    kind,
    ...(spec.reservedId !== undefined ? { reservedId: spec.reservedId } : {}),
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
    ...(spec.questions !== undefined ? { questions: spec.questions } : {}),
    ...(spec.isolation === 'worktree' ? { isolation: 'worktree' as const, worktreeScope: spec.scopeRoots } : {}),
  })
  if (!('refusal' in launched)) return launched
  // launchJob words its refusals for any kind; a task's are answered as task refusals.
  const own = `orq: ${kind} `
  const refusal = launched.refusal.startsWith(own)
    ? `${TASK_REFUSAL}: ${launched.refusal.slice(own.length).replace(/^refused: /, '')}`
    : launched.refusal
  const hint = spec.isolation === 'worktree' && refusal.includes('not_a_repository')
    ? '. Pass `isolation: shared` to run the task in this directory as it is.'
    : ''
  return { refusal: refusal + hint }
}

export type TaskLaunchArgs = {
  agentId: string
  header: TaskHeader
  ceiling: { runtimeMode: RuntimeMode; interactionMode: InteractionMode }
  sessionDir: string
  kind?: string
  reservedId?: string
  questions?: QuestionMode
}

/** A refused header comes back as `{ refusal }`, not as a throw. */
export async function planTaskLaunch($: CoreEngine, config: OrqConfig, args: TaskLaunchArgs): Promise<{ spec: TaskLaunchSpec } | { refusal: string }> {
  const { agentId, header, ceiling, sessionDir, kind, reservedId, questions } = args
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
  return {
    spec: {
      ...(kind !== undefined ? { kind } : {}),
      ...(reservedId !== undefined ? { reservedId } : {}),
      ...(questions !== undefined ? { questions } : {}),
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
    },
  }
}

export async function launchTaskFromHeader($: CoreEngine, config: OrqConfig, args: TaskLaunchArgs): Promise<LaunchResult> {
  const planned = await planTaskLaunch($, config, args)
  return 'refusal' in planned ? planned : launchTaskJob($, config, planned.spec)
}

/** finished | running | gone: the exit file, else the supervisor's process group. Rejects when the probe cannot run. */
async function probeLiveness($: CoreEngine, job: Pick<JobRecord, 'dir'>): Promise<'finished' | 'running' | 'gone'> {
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
export async function jobLiveness($: CoreEngine, job: Pick<JobRecord, 'dir'>): Promise<'finished' | 'running' | 'gone'> {
  try {
    return await probeLiveness($, job)
  } catch {
    return 'running'
  }
}

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

/**
 * The answer for a job that stopped on a question. The parent answers it with the answer tool, which resumes the same worker
 * in a new job, so this job's text stays as it is. A job that recorded no session cannot be resumed, and the old way, a new
 * task with the brief and the answer, is the one left.
 */
export function blockedText(id: string, question: string, state: { next: Next | null; form: boolean; resumable: boolean }): string {
  const head = `BLOCKED on a question (taskId ${id}): ${question}`
  if (state.next !== null) {
    return `${head}\n\nThe question was answered: its worker continues in taskId ${state.next.jobId}. Read it with status; if it failed, delegate anew.`
  }
  if (state.form) {
    return `${head}\n\nThe user is answering it in a form; the answer tool takes over once the form is declined, cancelled or 24 hours old.`
  }
  const way = state.resumable
    ? 'Answer it with the answer tool; the same worker resumes its session.'
    : 'This worker cannot be resumed (it recorded no session), so answer it in a new delegate with the original brief plus the answer.'
  return `${head}\n\n${way}`
}

/** A form left open for this long ends the task with the BLOCKED text. */
const FORM_WINDOW_MS = 24 * 60 * 60 * 1000

/** The worker's question stays a form until it is declined, the task is cancelled, 24 hours pass, or it has no session to resume. */
export async function formIsOpen($: CoreEngine, job: JobRecord, view: { endedAt: number | null }): Promise<boolean> {
  if ((await readSession($, job)) === null || (await $.fs.exists(`${job.dir}/declined`))) return false
  return (await $.clock.now()) - (view.endedAt ?? 0) < FORM_WINDOW_MS
}

/** The BLOCKED text as the answer tool will treat this question now: answered, open in a form, resumable, or not. */
async function blockedAnswer($: CoreEngine, job: JobRecord, question: string, view: { endedAt: number | null }): Promise<string> {
  return blockedText(job.id, question, {
    next: await readNext($, job),
    form: job.questions === 'human' && (await formIsOpen($, job, view)),
    resumable: (await readSession($, job)) !== null,
  })
}

export async function composeAnswer($: CoreEngine, config: OrqConfig, job: JobRecord, knownView?: JobView): Promise<string> {
  const view = knownView ?? (await jobView($, job))
  if (!('exitCode' in view)) return notEndedText(job.id, view.status)
  if (view.status === 'cancelled') return `orq: ${job.id} was cancelled (exit 124)`
  if (view.question !== null) return blockedAnswer($, job, view.question, view)
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
  const next = await readNext($, job)
  const answer: TaskStatusResult = {
    taskId: job.id,
    status,
    workState: workStateOf(status),
    kind: job.kind,
    startedAtIso: job.startedAtIso,
    ...(job.instanceId ? { instanceId: job.instanceId } : {}),
    ...(job.model ? { model: job.model } : {}),
    ...(view.endedAt !== null ? { finishedAtIso: new Date(view.endedAt).toISOString() } : {}),
    ...(job.parent !== undefined ? { parent: job.parent } : {}),
    ...(next !== null ? { next: next.jobId } : {}),
  }
  if (view.status === 'done') {
    return { ...answer, result: view.question !== null ? await blockedAnswer($, job, view.question, view) : view.lastText }
  }
  if (view.status === 'failed') {
    const snippet = await stderrSnippet($, job)
    return { ...answer, error: `failed (exit ${view.exitCode})` + (snippet ? `\n${snippet}` : '') }
  }
  if (view.status === 'interrupted') return { ...answer, error: INTERRUPTED_ERROR }
  return answer
}

// ---------------------------------------------------------------------------------------------------------------------
// Answering a question: the same worker resumes its session in a new job, on the same branch.

export type NextVia = 'form' | 'answer'

/** `next` in a job directory: the job that took over the question of this one, and how it was answered. */
export type Next = { jobId: string; via: NextVia }

const NEXT_FILE = 'next'
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** The continuation that claimed this job's question; null when none did, or when the file cannot be read as one. */
export async function readNext($: CoreEngine, job: Pick<JobRecord, 'dir'>): Promise<Next | null> {
  const raw = await readText($, `${job.dir}/${NEXT_FILE}`)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed.jobId !== 'string' || !isSafeJobId(parsed.jobId)) return null
    const via = parsed.via === 'form' || parsed.via === 'answer' ? parsed.via : null
    return via === null ? null : { jobId: parsed.jobId, via }
  } catch {
    return null
  }
}

/** The session id the supervisor recorded for the worker of this job; null when it recorded none. */
export async function readSession($: CoreEngine, job: Pick<JobRecord, 'dir'>): Promise<string | null> {
  const text = ((await readText($, `${job.dir}/session`)) ?? '').trim()
  return SESSION_ID.test(text) ? text : null
}

export type Claim = { claimed: true } | { claimed: false; existing: Next | null }

/**
 * The one answer that may continue a job. `fs.write` cannot create a file only when it is absent, so the claim is a hard
 * link: the content is written whole to a temporary file, and `ln` fails when `next` exists, so a reader never sees half of
 * it and two answers at once cannot both win.
 */
export async function claimNext($: CoreEngine, job: Pick<JobRecord, 'dir'>, next: Next): Promise<Claim> {
  const script =
    `# orq:claim\ntmp=$(mktemp "$1/.next.XXXXXX") || exit 12\n` +
    `printf '%s' "$2" > "$tmp" || { rm -f "$tmp"; exit 12; }\n` +
    `if ln "$tmp" "$1/${NEXT_FILE}" 2>/dev/null; then rm -f "$tmp"; exit 0; fi\n` +
    `rm -f "$tmp"\n[ -e "$1/${NEXT_FILE}" ] && exit 9\nexit 12`
  const r = await $.process.run(['bash', '-c', script, 'orq-claim', job.dir, JSON.stringify(next)], { timeoutMs: PROCESS_TIMEOUT_MS })
  if (r.exitCode === 0) return { claimed: true }
  if (r.exitCode === 9) return { claimed: false, existing: await readNext($, job) }
  throw new Error(`could not claim the question of ${job.dir} (exit ${r.exitCode})`)
}

/** Gives the claim back after a launch that did not start, so the question can be answered again. */
async function releaseNext($: CoreEngine, job: Pick<JobRecord, 'dir'>): Promise<void> {
  try {
    await $.process.run(['rm', '-f', `${job.dir}/${NEXT_FILE}`], { timeoutMs: PROCESS_TIMEOUT_MS })
  } catch {
    /* a claim that stays reads as answered; the refusal that follows names the launch's own failure */
  }
}

export function alreadyAnswered(jobId: string, existing: Next | null): Failure {
  return fail(
    'already_answered',
    existing === null
      ? `the question of ${jobId} was answered a moment ago by another call`
      : `the question of ${jobId} was already answered: its worker continues in taskId ${existing.jobId}. Read it with status; if it failed, delegate anew.`,
  )
}

/** What a continuation needs of the job it resumes, checked against the config as it is now. */
export type ContinuationPlan = {
  parent: JobRecord
  session: string
  instance: InstanceConfig
  model: string
  modes: { runtimeMode: RuntimeMode; interactionMode: InteractionMode }
  flags: string[]
  /** `worktree` only for a worktree that git lists for the task; anything else runs, and is locked, as a shared task. */
  isolation: TaskIsolation
  /** The directory the task was asked to work in, resolved: the checkout of a worktree task, the directory itself of a shared one. */
  requestCwd: string
  /** Where the worker resumes: the resolved, checked directory, never the one meta.json names. */
  cwd: string
  worktree?: NonNullable<Continuation['worktree']>
}

/** The real path of a path that exists, with every link followed; null when it does not exist. No realpath command: macOS has none with -e. */
async function realPath($: CoreEngine, path: string): Promise<string | null> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath ?? null
  } catch {
    return null
  }
}

/** Whether the `next` claims of the server lead from job `from` to job `to`: the chain of answers that a task is. */
async function chainReaches($: CoreEngine, jobsDir: string, from: string, to: string): Promise<boolean> {
  let id = from
  for (let hops = 0; hops < 64; hops += 1) {
    if (id === to) return true
    const next = await readNext($, { dir: `${jobsDir}/${id}` })
    if (next === null) return false
    id = next.jobId
  }
  return false
}

/** Whether a live job other than `except` works on this branch, as far as its meta.json says. */
async function branchHeldByAnother($: CoreEngine, jobsDir: string, branch: string, except: string): Promise<boolean> {
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(jobsDir)
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name === except) continue
    const other = await readMeta($, jobsDir, entry.name)
    if (other?.branch === branch && (await jobIsLive($, other))) return true
  }
  return false
}

type OwnWorktree = { fields: NonNullable<Continuation['worktree']>; cwd: string }

/**
 * The worktree of a job, when it is the one the server made for the task, and the directory to resume in. meta.json is the
 * job's own file, and a worker that can write outside its directory can change it, so nothing in it is taken as it stands: the
 * branch must be `orq/ID` of a job that does not run and whose `next` claims lead to this job (or of this job itself), the
 * checkout git reports must lie in scope as a launch requires, the worktree must be the path that a launch computes for that
 * ID, git must list it on that branch, and the directory must resolve, links followed, to where a launch from the recorded
 * directory would have put it, inside the worktree. Anything else is not the task's own worktree, and the job runs, is scoped
 * and is locked as a shared one.
 */
async function ownWorktree($: CoreEngine, config: OrqConfig, sessionDir: string, job: JobRecord): Promise<OwnWorktree | null> {
  const { repo, baseSha, branch } = job
  if (repo === undefined || baseSha === undefined || branch === undefined || job.worktree === undefined) return null
  const rootId = branch.startsWith('orq/') ? branch.slice('orq/'.length) : ''
  if (!isSafeJobId(rootId) || branchFor(rootId) !== branch) return null
  try {
    const top = await $.process.run(gitArgv(repo, ...NO_HOOKS, 'rev-parse', '--show-toplevel'), { timeoutMs: GIT_TIMEOUT_MS })
    if (top.exitCode !== 0) return null
    const toplevel = await realPath($, top.stdout.trim())
    const worktree = await realPath($, worktreePathFor(top.stdout.trim(), rootId))
    if (toplevel === null || worktree === null || (await realPath($, job.worktree)) !== worktree) return null
    if ('refusal' in (await scopedCwd($, config, sessionDir, toplevel))) return null
    const listed = await $.process.run(gitArgv(repo, ...NO_HOOKS, 'worktree', 'list', '--porcelain'), { timeoutMs: GIT_TIMEOUT_MS })
    if (listed.exitCode !== 0) return null
    let registered = false
    for (const block of listed.stdout.split('\n\n')) {
      const lines = block.split('\n')
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
      if (path !== undefined && lines.includes(`branch refs/heads/${branch}`) && (await realPath($, path)) === worktree) registered = true
    }
    if (!registered) return null
    const asked = await realPath($, repo)
    if (asked === null) return null
    const subdir = asked !== toplevel && isWithin(asked, toplevel) ? asked.slice(toplevel.length) : ''
    const cwd = await realPath($, `${worktree}${subdir}`)
    if (cwd === null || !isWithin(cwd, worktree) || (await realPath($, job.cwd)) !== cwd) return null
    if (rootId !== job.id && !(await chainReaches($, config.jobsDir, rootId, job.id))) return null
    if (await branchHeldByAnother($, config.jobsDir, branch, job.id)) return null
    return { fields: { repo, baseSha, branch, worktree }, cwd }
  } catch {
    return null
  }
}

/**
 * Whether the worker of a job that stopped on a question can be resumed, and with what. The job must have recorded its
 * session, its worker and its modes, its instance must still be the one it ran on (the session lives in that instance's
 * CODEX_HOME), and its directory must still be there. The flags are the ones a launch at the same modes would write.
 */
export async function continuationPlan(
  $: CoreEngine,
  config: OrqConfig,
  parent: JobRecord,
  sessionDir: string,
): Promise<{ plan: ContinuationPlan } | { failure: Failure }> {
  const unavailable = (why: string): { failure: Failure } => ({
    failure: fail('resume_unavailable', `${parent.id} cannot be resumed: ${why}. Delegate a new task that carries the brief and the answer instead.`),
  })
  const session = await readSession($, parent)
  if (session === null) return unavailable('its worker left no session id')
  const { driver, model, runtimeMode, interactionMode } = parent
  if (driver === undefined || model === undefined || runtimeMode === undefined || interactionMode === undefined) {
    return unavailable('the job did not record its worker or its permission modes')
  }
  const instance = config.instances.find((candidate) => candidate.id === parent.instanceId)
  if (instance === undefined || instance.driver !== driver) return unavailable(`the instance ${parent.instanceId ?? 'it ran on'} is no longer configured as it was`)
  if (instance.env?.CODEX_HOME !== parent.codexHome) return unavailable('the CODEX_HOME of its instance changed, so its session is not where the worker left it')
  if (!plainArgument(model)) return unavailable('its model is not one word')
  if (!(await isDirectory($, parent.cwd))) return unavailable(`its directory ${parent.cwd} is gone`)
  const own = await ownWorktree($, config, sessionDir, parent)
  // The scope is judged as a launch judges it: on the directory the task was asked to work in.
  const scoped = await scopedCwd($, config, sessionDir, own === null ? parent.cwd : own.fields.repo)
  if ('refusal' in scoped) {
    const body = scoped.refusal.slice(`${TASK_REFUSAL}: `.length)
    const outside = /^cwd_out_of_scope: ([\s\S]*)$/.exec(body)
    return outside?.[1] !== undefined ? { failure: fail('cwd_out_of_scope', outside[1]) } : unavailable(body)
  }
  const policy = runnerPolicy(driver, runtimeMode, interactionMode)
  if (isFailure(policy)) return unavailable(policy.error.message)
  const effort = parent.effort === undefined ? [] : effortFlag(driver, [{ id: EFFORT_OPTION, value: parent.effort }])
  return {
    plan: {
      parent,
      session,
      instance,
      model,
      modes: { runtimeMode, interactionMode },
      flags: [...policy.flags, ...effort],
      isolation: own === null ? 'shared' : 'worktree',
      requestCwd: scoped.cwd,
      cwd: own === null ? scoped.cwd : own.cwd,
      ...(own !== null ? { worktree: own.fields } : {}),
    },
  }
}

export type ContinuationInput = { answer: string; via: NextVia; questions: QuestionMode; agentId: string; reservedId?: string }

/**
 * Claims the question and starts the continuation under the id the claim names: the worker resumes its session on the same
 * branch, in the same directory, with the answer as its next message. A launch that does not start gives the claim back.
 */
export async function launchContinuation(
  $: CoreEngine,
  config: OrqConfig,
  plan: ContinuationPlan,
  input: ContinuationInput,
): Promise<{ job: JobRecord } | { refusal: string } | { failure: Failure }> {
  const { parent, session, instance, model, modes, flags, worktree } = plan
  const id = input.reservedId ?? newJobId('mcp', await $.clock.now(), input.agentId)
  const claim = await claimNext($, parent, { jobId: id, via: input.via })
  if (!claim.claimed) return { failure: alreadyAnswered(parent.id, claim.existing) }
  const launched = await launchJob($, config, {
    kind: 'mcp',
    reservedId: id,
    agentId: input.agentId,
    runner: DRIVER_RUNNER[instance.driver],
    model,
    cwd: plan.cwd,
    prompt: taskPrompt(input.answer, undefined),
    env: instance.env ?? {},
    instanceId: instance.id,
    driver: instance.driver,
    flags,
    runtimeMode: modes.runtimeMode,
    interactionMode: modes.interactionMode,
    ...(parent.effort !== undefined ? { effort: parent.effort } : {}),
    questions: input.questions,
    continuation: { parent: parent.id, session, ...(worktree !== undefined ? { worktree } : {}) },
  })
  if (!('job' in launched)) await releaseNext($, parent)
  return launched
}
