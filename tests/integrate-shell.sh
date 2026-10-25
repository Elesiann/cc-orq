#!/bin/bash
# integrate against real git: a temporary checkout under .ref/tmp, worktrees cut from it by the real
# prepareWorktree, and the real integrate function, the one the MCP server serves. The engines are the ones the
# server builds: the node engine with git hooks off, which integrate uses by default, and the one that keeps the
# checkout's hooks on, which it uses once the config says `integrate.gitHooks: run`. Git reads no global or system
# config here, so the host's merge settings cannot change the result. A merge that has to outlive git's timeout gets a
# short one through the engine the driver hands to integrate, which clamps the timeout of the merge call alone.
# Usage: bash tests/integrate-shell.sh
set -e -o pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T="$ROOT/.ref/tmp/integrate-shell-$(date +%s)-$$"
mkdir -p "$T/home"
trap 'rm -rf "$T"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CEILING_DIRECTORIES="$T" HOME="$T/home"
export GIT_AUTHOR_NAME=orq-test GIT_AUTHOR_EMAIL=orq-test@example.invalid
export GIT_COMMITTER_NAME=orq-test GIT_COMMITTER_EMAIL=orq-test@example.invalid

REPO="$T/repo"
git init -q -b main "$REPO"
printf 'base\n' > "$REPO/shared.txt"
git -C "$REPO" add shared.txt
git -C "$REPO" commit -q -m base

cat > "$T/driver.mjs" <<'JS'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const [repo, home] = process.argv.slice(2)
const ROOT = process.env.ORQ_ROOT
const { prepareWorktree } = await import(pathToFileURL(`${ROOT}/hooks/engine.ts`).href)
const { integrate: integrateTask, integratePayload, parseIntegrateInput } = await import(pathToFileURL(`${ROOT}/hooks/integrate.ts`).href)
const { nodeEngine } = await import(pathToFileURL(`${ROOT}/server/node-engine.ts`).href)
const jobsDir = `${home}/.cache/orq/jobs`

const launching = nodeEngine({ pluginRoot: ROOT })
const keepingHooks = nodeEngine({ pluginRoot: ROOT, gitHooks: 'repository' })
const gitCalls = []
let mergeTimeoutMs = null
const spy = (engine) => ({
  ...engine,
  process: {
    run: (argv, init) => {
      if (argv[0] === 'git') gitCalls.push(argv)
      const merging = mergeTimeoutMs !== null && argv[0] === 'git' && argv[3] === 'merge' && argv[4] !== '--abort'
      return engine.process.run(argv, merging ? { ...init, timeoutMs: mergeTimeoutMs } : init)
    },
  },
})

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return { status: r.status, out: (r.stdout ?? '').trim() }
}
const must = (cwd, ...args) => {
  const r = git(cwd, ...args)
  if (r.status !== 0) throw new Error(`git -C ${cwd} ${args.join(' ')} exited ${r.status}`)
  return r.out
}

let passed = 0
let failed = 0
const check = (label, ok) => {
  if (ok) {
    passed += 1
    console.log(`ok: ${label}`)
  } else {
    failed += 1
    console.log(`FAIL: ${label}`)
  }
}

// The answer of the tool for one task, as the server sends it to the model: the payload of the outcome as JSON. `hooks`
// is what the config says, and the server picks the engine that keeps the checkout's hooks only for `run`.
async function integrate(taskId, strategy, hooks = 'off') {
  const parsed = parseIntegrateInput(strategy === undefined ? { taskId } : { taskId, strategy })
  const engine = spy(hooks === 'run' ? keepingHooks : launching)
  const outcome = 'failure' in parsed ? parsed : await integrateTask(engine, jobsDir, parsed.input, hooks)
  return JSON.parse(JSON.stringify(integratePayload(outcome)))
}

// A task as the launch writes it: the worktree from prepareWorktree, and the meta.json beside it.
async function startTask(taskId) {
  const r = await prepareWorktree(launching, repo, taskId)
  if ('failure' in r) throw new Error(`prepareWorktree refused ${taskId}: ${r.failure.code}`)
  writeMeta(taskId, { repo, baseSha: r.plan.baseSha, branch: r.plan.branch, worktree: r.plan.worktree, cwd: r.plan.worktree })
  return r.plan
}

function writeMeta(taskId, fields) {
  mkdirSync(`${jobsDir}/${taskId}`, { recursive: true })
  writeFileSync(`${jobsDir}/${taskId}/meta.json`, JSON.stringify({ id: taskId, kind: 'manual', agentId: 'manual', startedAt: Date.now(), ...fields }))
}

function installHook(name, body) {
  const path = `${repo}/.git/hooks/${name}`
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

// A commit by a fake worker, or by someone working in the destination.
function commit(cwd, file, text, message) {
  writeFileSync(`${cwd}/${file}`, text)
  must(cwd, 'add', file)
  must(cwd, 'commit', '-q', '-m', message)
}

const finish = (taskId) => writeFileSync(`${jobsDir}/${taskId}/exit`, '0')

// Puts the checkout and its hooks back after a case that may have failed, so the next case starts from a clean one.
function scrub() {
  git(repo, 'merge', '--abort')
  git(repo, 'reset', '--hard', '-q')
  git(repo, 'clean', '-fdq')
  for (const name of ['pre-merge-commit', 'commit-msg', 'post-merge', 'reference-transaction']) rmSync(`${repo}/.git/hooks/${name}`, { force: true })
}

// A detached child leads its own process group, so its pid is the pgid that the job records.
const groups = []
const alive = (pid) => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}
function startLive(taskId) {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  child.unref()
  groups.push(child.pid)
  writeFileSync(`${jobsDir}/${taskId}/pgid`, `${child.pid}\n`)
  return child.pid
}
async function stopLive(pid) {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group is already gone.
  }
  for (let wait = 0; wait < 250 && alive(pid); wait += 1) await new Promise((done) => setTimeout(done, 20))
}
// A hook that outlives the timeout writes its own pid first, so the case can see that the kill reached it.
const hookGone = async (pidFile) => {
  const pid = Number(readFileSync(pidFile, 'utf8'))
  const exists = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let wait = 0; wait < 100 && exists(); wait += 1) await new Promise((done) => setTimeout(done, 20))
  return !exists()
}
process.on('exit', () => {
  for (const pid of groups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // The group is already gone.
    }
  }
})

const A = 'task-a'
const B = 'task-b'
const C = 'task-c'
const D = 'task-d'
const planA = await startTask(A)
const planB = await startTask(B)
const planC = await startTask(C)
check('three worktrees sit beside the checkout on their own branches', [planA, planB, planC].every((p, i) => p.worktree === `${repo}-wt/${[A, B, C][i]}` && p.branch === `orq/${[A, B, C][i]}`))
commit(planA.worktree, 'a.txt', 'task a\n', 'task a work')
commit(planB.worktree, 'shared.txt', 'task b\n', 'task b work')
commit(planC.worktree, 'c.txt', 'task c\n', 'task c work')
for (const id of [A, B, C]) finish(id)

const first = await integrate(A)
const headAfterA = must(repo, 'rev-parse', 'HEAD')
check('ff-only moves the checkout to the task commit and names it', first.ok === true && first.mergedSha === headAfterA && headAfterA === must(planA.worktree, 'rev-parse', 'HEAD'))
check('the answer keeps the worktree and names the branch', first.branch === `orq/${A}` && first.worktree === planA.worktree)
check('a second integrate of the same task is already_integrated', (await integrate(A)).error?.code === 'already_integrated')

writeFileSync(`${repo}/notes.txt`, 'untracked\n')
check('an untracked file in the checkout is dirty_worktree', (await integrate(C)).error?.code === 'dirty_worktree')
rmSync(`${repo}/notes.txt`)

commit(repo, 'shared.txt', 'main change\n', 'main change')
const ffAfterMove = await integrate(B)
check('ff-only cannot follow once the checkout moved: not_fast_forward', ffAfterMove.error?.code === 'not_fast_forward')
const conflict = await integrate(B, 'merge')
check('a conflicting merge lists the file', conflict.error?.code === 'merge_conflict' && JSON.stringify(conflict.error.files) === '["shared.txt"]')
check('the conflict is aborted: no merge in progress, tree clean', !existsSync(`${repo}/.git/MERGE_HEAD`) && must(repo, 'status', '--porcelain') === '')
check('the checkout still points at the main change after the abort', must(repo, 'rev-parse', 'HEAD') === must(repo, 'rev-parse', 'main') && must(repo, 'show', 'HEAD:shared.txt') === 'main change')

const headBeforeC = must(repo, 'rev-parse', 'HEAD')
const merged = await integrate(C, 'merge')
check('strategy merge makes a merge commit with both parents', merged.ok === true && must(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length === 3 && merged.mergedSha !== headBeforeC)
check('the merged checkout holds both sides', must(repo, 'show', 'HEAD:a.txt') === 'task a' && must(repo, 'show', 'HEAD:c.txt') === 'task c')

// The checkout has a pre-merge-commit hook that refuses the merge while the flag file exists, and a post-merge hook
// that writes a marker. git leaves the merge pending when pre-merge-commit refuses the merge commit, so integrate must abort it.
const flag = `${home}/refuse-merges`
const marker = `${home}/post-merge-ran`
installHook('pre-merge-commit', `if [ -e "${flag}" ]; then echo "lint: the merge is refused" >&2; exit 1; fi`)
installHook('post-merge', `echo "squash=$1" > "${marker}"`)
writeFileSync(flag, '')

const E = 'task-e'
const planE = await startTask(E)
commit(planE.worktree, 'e.txt', 'task e\n', 'task e work')
finish(E)
commit(repo, 'main.txt', 'main moves on\n', 'main moves on')
const byDefault = await integrate(E, 'merge')
check('by default integrate runs no hook of the checkout: the refusing pre-merge-commit hook does not stop the merge', byDefault.ok === true)
check('by default the post-merge hook of the checkout does not run either', !existsSync(marker))

const F = 'task-f'
const planF = await startTask(F)
commit(planF.worktree, 'f.txt', 'task f\n', 'task f work')
finish(F)
commit(repo, 'main2.txt', 'main moves on again\n', 'main moves on again')
const headBeforeF = must(repo, 'rev-parse', 'HEAD')
const refused = await integrate(F, 'merge', 'run')
check('with the opt-in, a merge refused by pre-merge-commit is hook_failed and carries the output of the checkout hook', refused.ok === false && refused.error?.code === 'hook_failed' && refused.error.message.includes('lint: the merge is refused') && refused.error.message.includes("the checkout's hook"))
check('the refused merge leaves no MERGE_HEAD, a clean tree and HEAD unmoved', !existsSync(`${repo}/.git/MERGE_HEAD`) && must(repo, 'status', '--porcelain') === '' && must(repo, 'rev-parse', 'HEAD') === headBeforeF)
check('a merge that a hook refused ran no post-merge hook', !existsSync(marker))
rmSync(flag)
check('the same task merges once the hook lets go, so the hook was the only cause', (await integrate(F, 'merge', 'run')).ok === true)
check('with the opt-in, the post-merge hook of the checkout wrote its marker after the merge', existsSync(marker) && readFileSync(marker, 'utf8') === 'squash=0\n')

// A post-merge hook runs after either strategy and cannot fail the merge.
const G = 'task-g'
const planG = await startTask(G)
commit(planG.worktree, 'g.txt', 'task g\n', 'task g work')
finish(G)
rmSync(marker, { force: true })
const viaHook = await integrate(G, undefined, 'run')
check('with the opt-in, ff-only merges and the post-merge hook runs', viaHook.ok === true && viaHook.mergedSha === must(repo, 'rev-parse', 'HEAD') && existsSync(marker))

// A reference-transaction hook that refuses the ref update leaves no merge pending, and git's fatal line names the hook.
const R = 'task-r'
const guard = `${home}/ref-guard-on`
installHook('reference-transaction', `if [ "$1" = prepared ] && [ -e "${guard}" ]; then echo "ref guard: no updates" >&2; exit 1; fi`)
const planR = await startTask(R)
commit(planR.worktree, 'r.txt', 'task r\n', 'task r work')
finish(R)
const headBeforeR = must(repo, 'rev-parse', 'HEAD')
writeFileSync(guard, '')
const guarded = await integrate(R, undefined, 'run')
check('with the opt-in, a fast-forward refused by a reference-transaction hook is hook_failed with the hook output', guarded.ok === false && guarded.error?.code === 'hook_failed' && guarded.error.message.includes('ref guard: no updates'))
check('the refused fast-forward leaves a clean tree and HEAD unmoved', must(repo, 'status', '--porcelain') === '' && must(repo, 'rev-parse', 'HEAD') === headBeforeR)
check('by default the same refusing hook is not run, and the task fast-forwards', (await integrate(R)).ok === true)
rmSync(guard)

const L = 'task-l'
const L2 = 'task-l2'
const planL = await startTask(L)
commit(planL.worktree, 'l.txt', 'task l\n', 'task l work')
const ownGroup = startLive(L)
const headBeforeL = must(repo, 'rev-parse', 'HEAD')
const callsBeforeL = gitCalls.length
const running = await integrate(L)
check('a live job on the branch is task_running, and the answer names it', running.ok === false && running.error?.code === 'task_running' && running.error.message.includes(L))
check('task_running touches nothing: no git call, HEAD unmoved, a clean tree, no merge pending', gitCalls.length === callsBeforeL && must(repo, 'rev-parse', 'HEAD') === headBeforeL && must(repo, 'status', '--porcelain') === '' && !existsSync(`${repo}/.git/MERGE_HEAD`))
check('with the opt-in, a live job on the branch is task_running as well', (await integrate(L, undefined, 'run')).error?.code === 'task_running')
await stopLive(ownGroup)
finish(L)
writeMeta(L2, { repo, baseSha: planL.baseSha, branch: planL.branch, worktree: planL.worktree, cwd: planL.worktree })
const nextGroup = startLive(L2)
const taken = await integrate(L)
check('a live job that took over the branch is task_running with its own id', taken.ok === false && taken.error?.code === 'task_running' && taken.error.message.includes(L2))
await stopLive(nextGroup)
check('the task integrates once no job is live on its branch', (await integrate(L)).ok === true)

const V = 'task-v'
const planV = await startTask(V)
commit(planV.worktree, 'v.txt', 'task v\n', 'task v work')
finish(V)
const headBeforeV = must(repo, 'rev-parse', 'HEAD')
const callsBeforeV = gitCalls.length
writeMeta('shared-job', { cwd: `${planV.worktree}/sub` })
const sharedGroup = startLive('shared-job')
const inside = await integrate(V)
check('a live shared job inside the task worktree, which recorded no branch, is task_running and the answer names it', inside.ok === false && inside.error?.code === 'task_running' && inside.error.message.includes('shared-job'))
await stopLive(sharedGroup)
writeMeta('spelled-job', { branch: `refs/heads/${planV.branch}`, cwd: `${home}/elsewhere` })
const spelledGroup = startLive('spelled-job')
const spelled = await integrate(V)
check('a live job on the task branch spelled refs/heads/... is task_running', spelled.ok === false && spelled.error?.code === 'task_running' && spelled.error.message.includes('spelled-job'))
await stopLive(spelledGroup)
writeMeta('fresh-job', { cwd: planV.worktree })
const fresh = await integrate(V)
check('a job that began a moment ago and has no pgid yet is task_running', fresh.ok === false && fresh.error?.code === 'task_running' && fresh.error.message.includes('fresh-job'))
check('those refusals ran no git call, left HEAD unmoved and the tree clean', gitCalls.length === callsBeforeV && must(repo, 'rev-parse', 'HEAD') === headBeforeV && must(repo, 'status', '--porcelain') === '')
writeMeta('fresh-job', { cwd: planV.worktree, startedAt: Date.now() - 60000 })
check('the same job a minute later, still with no pgid, counts as gone, and the task integrates', (await integrate(V, 'merge')).ok === true)

// git writes MERGE_HEAD after the pre-merge-commit hook and before commit-msg, so a merge killed in the first leaves its
// half-made index with no merge pending, and one killed in the second leaves a merge pending. integrate resets nothing
// in the first case, because it cannot tell the merge's staged changes from the user's own.
const pidFile = `${home}/hook-pid`
const hookMade = `${repo}/hook-made.txt`
const T = 'task-t'
const planT = await startTask(T)
commit(planT.worktree, 't.txt', 'task t\n', 'task t work')
finish(T)
installHook('pre-merge-commit', `echo $$ > "${pidFile}"; echo made > "${hookMade}"; sleep 30`)
const headBeforeT = must(repo, 'rev-parse', 'HEAD')
mergeTimeoutMs = 1500
const hung = await integrate(T, 'merge', 'run')
mergeTimeoutMs = null
check('with the opt-in, a pre-merge-commit hook that outlives the timeout answers git_failed and names the timeout', hung.ok === false && hung.error?.code === 'git_failed' && /did not finish within 1500 ms/.test(hung.error.message))
check('nothing is reset: no merge pending, HEAD unmoved, the index still holds the killed merge, and the hook file stays', !existsSync(`${repo}/.git/MERGE_HEAD`) && must(repo, 'rev-parse', 'HEAD') === headBeforeT && must(repo, 'status', '--porcelain') === 'A  t.txt\n?? hook-made.txt')
check('the answer says nothing was reset, lists both paths and names git reset --merge for the user to run', hung.error?.message.includes('nothing was reset') === true && hung.error.message.includes('t.txt') && hung.error.message.includes('hook-made.txt') && hung.error.message.includes('git reset --merge'))
check('integrate ran no git reset', gitCalls.every((argv) => argv[3] !== 'reset'))
check('the hook that outlived the timeout is gone', await hookGone(pidFile))
rmSync(hookMade, { force: true })
rmSync(`${repo}/.git/hooks/pre-merge-commit`, { force: true })
must(repo, 'reset', '--merge')
check('after the command the answer names, and without the hook, the same task merges', (await integrate(T, 'merge', 'run')).ok === true)
scrub()

// A change that the user stages while the hook runs cannot be told from the merge's, so a killed merge keeps it.
const X = 'task-x'
const planX = await startTask(X)
commit(planX.worktree, 'x.txt', 'task x\n', 'task x work')
finish(X)
rmSync(pidFile, { force: true })
installHook('pre-merge-commit', `echo $$ > "${pidFile}"; sleep 30`)
mergeTimeoutMs = 2500
const merging = integrate(X, 'merge', 'run')
for (let wait = 0; wait < 250 && !existsSync(pidFile); wait += 1) await new Promise((done) => setTimeout(done, 20))
writeFileSync(`${repo}/shared.txt`, 'a change of the user\n')
must(repo, 'add', 'shared.txt')
const withUser = await merging
mergeTimeoutMs = null
check('a change staged by the user while the hook ran: the answer is git_failed, names the timeout and says nothing was reset', withUser.ok === false && withUser.error?.code === 'git_failed' && /did not finish within 2500 ms/.test(withUser.error.message) && withUser.error.message.includes('nothing was reset'))
check('the change the user staged is still staged, with the user text', must(repo, 'diff', '--cached', '--name-only').split('\n').includes('shared.txt') && readFileSync(`${repo}/shared.txt`, 'utf8') === 'a change of the user\n')
check('the answer lists the path of the user and the path of the killed merge', withUser.error?.message.includes('shared.txt') === true && withUser.error.message.includes('x.txt'))
check('integrate ran no git reset for it either', gitCalls.every((argv) => argv[3] !== 'reset'))
check('the hook that the user waited on is gone', await hookGone(pidFile))
scrub()

const U = 'task-u'
const planU = await startTask(U)
commit(planU.worktree, 'u.txt', 'task u\n', 'task u work')
finish(U)
installHook('commit-msg', `echo $$ > "${pidFile}"; sleep 30`)
const headBeforeU = must(repo, 'rev-parse', 'HEAD')
mergeTimeoutMs = 1500
const hungLate = await integrate(U, 'merge', 'run')
mergeTimeoutMs = null
check('with the opt-in, a commit-msg hook that outlives the timeout answers git_failed, and the pending merge was aborted', hungLate.ok === false && hungLate.error?.code === 'git_failed' && /did not finish within 1500 ms/.test(hungLate.error.message) && hungLate.error.message.includes('the merge was aborted'))
check('the aborted merge leaves no MERGE_HEAD, a clean tree and HEAD unmoved', !existsSync(`${repo}/.git/MERGE_HEAD`) && must(repo, 'status', '--porcelain') === '' && must(repo, 'rev-parse', 'HEAD') === headBeforeU)
check('the commit-msg hook that outlived the timeout is gone', await hookGone(pidFile))
scrub()

const W = 'task-w'
const planW = await startTask(W)
commit(planW.worktree, 'w.txt', 'task w\n', 'task w work')
finish(W)
installHook('post-merge', `echo $$ > "${pidFile}"; sleep 30`)
mergeTimeoutMs = 1500
const hungAfter = await integrate(W, undefined, 'run')
mergeTimeoutMs = null
check('with the opt-in, a post-merge hook that outlives the timeout answers git_failed and says the branch is already part of HEAD', hungAfter.ok === false && hungAfter.error?.code === 'git_failed' && hungAfter.error.message.includes(`${planW.branch} is already part of HEAD`))
check('the merge itself landed: HEAD is the task tip, the tree is clean', must(repo, 'rev-parse', 'HEAD') === must(planW.worktree, 'rev-parse', 'HEAD') && must(repo, 'status', '--porcelain') === '')
check('the post-merge hook that outlived the timeout is gone', await hookGone(pidFile))
scrub()

// git merge --abort does not remove a file that a hook made.
const K = 'task-k'
const planK = await startTask(K)
commit(planK.worktree, 'k.txt', 'task k\n', 'task k work')
finish(K)
const headBeforeK = must(repo, 'rev-parse', 'HEAD')
installHook('pre-merge-commit', `echo made > "${repo}/leftover.txt"; echo "lint: refused" >&2; exit 1`)
const leftover = await integrate(K, 'merge', 'run')
check('with the opt-in, a hook that leaves a file and refuses the merge is hook_failed, and the answer says the checkout keeps changes the hook made', leftover.ok === false && leftover.error?.code === 'hook_failed' && leftover.error.message.includes('keeps changes the hook made') && leftover.error.message.includes('leftover.txt') && leftover.error.message.includes('lint: refused'))
check('only the file the hook made stays: no MERGE_HEAD, HEAD unmoved', !existsSync(`${repo}/.git/MERGE_HEAD`) && must(repo, 'status', '--porcelain') === '?? leftover.txt' && must(repo, 'rev-parse', 'HEAD') === headBeforeK)
rmSync(`${repo}/leftover.txt`, { force: true })
installHook('pre-merge-commit', 'echo "plain-stdout-words"; exit 1')
const printed = await integrate(K, 'merge', 'run')
check('a hook that prints on stdout has its text in hook_failed, which git sends to stderr', printed.ok === false && printed.error?.code === 'hook_failed' && printed.error.message.includes('plain-stdout-words'))
rmSync(`${repo}/.git/hooks/pre-merge-commit`, { force: true })
check('the same task merges once the hook lets go', (await integrate(K, 'merge', 'run')).ok === true)
scrub()

// A reference-transaction hook refuses the ref update, so no merge is pending, and it leaves a file all the same.
const Y = 'task-y'
const planY = await startTask(Y)
commit(planY.worktree, 'y.txt', 'task y\n', 'task y work')
finish(Y)
const headBeforeY = must(repo, 'rev-parse', 'HEAD')
installHook('reference-transaction', `if [ "$1" = prepared ]; then echo made > "${repo}/ref-leftover.txt"; echo "ref guard: no updates" >&2; exit 1; fi`)
const refLeft = await integrate(Y, undefined, 'run')
check('with the opt-in, a reference-transaction hook that leaves a file and refuses the fast-forward is hook_failed, and the answer names the file', refLeft.ok === false && refLeft.error?.code === 'hook_failed' && refLeft.error.message.includes('keeps changes the hook made') && refLeft.error.message.includes('ref-leftover.txt') && refLeft.error.message.includes('ref guard: no updates'))
check('no merge was pending, so none was aborted, and only the file the hook made stays', !existsSync(`${repo}/.git/MERGE_HEAD`) && !refLeft.error.message.includes('the merge was aborted') && must(repo, 'status', '--porcelain') === '?? ref-leftover.txt' && must(repo, 'rev-parse', 'HEAD') === headBeforeY)
rmSync(`${repo}/ref-leftover.txt`, { force: true })
rmSync(`${repo}/.git/hooks/reference-transaction`, { force: true })
check('the same task fast-forwards once the hook lets go', (await integrate(Y, undefined, 'run')).ok === true)
scrub()

check('an unknown task is task_not_found', (await integrate('task-nope')).error?.code === 'task_not_found')
const plain = `${home}/plain`
mkdirSync(plain, { recursive: true })
writeMeta(D, { repo: plain, cwd: `${plain}-wt/${D}`, baseSha: 'abc123', branch: `orq/${D}`, worktree: `${plain}-wt/${D}` })
finish(D)
check('a destination outside any checkout is not_a_repository', (await integrate(D)).error?.code === 'not_a_repository')

console.log(`pass=${passed} fail=${failed}`)
process.exit(failed === 0 ? 0 : 1)
JS

ORQ_ROOT="$ROOT" node "$T/driver.mjs" "$REPO" "$T/home"

[ -z "$(git -C "$REPO" status --porcelain)" ] || { echo "FAIL: checkout is not clean after the run"; exit 1; }
git -C "$REPO" merge-base --is-ancestor "orq/task-a" HEAD || { echo "FAIL: task-a is not in the checkout"; exit 1; }
echo "integrate-shell: scratch cleaned"
