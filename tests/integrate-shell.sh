#!/bin/bash
# integrate against real git: a temporary checkout under .ref/tmp, worktrees cut from it by the real
# prepareWorktree, and the real integrate tool run over a process.run that calls git. Git reads no
# global or system config here, so the host's merge settings cannot change the result.
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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const [repo, home] = process.argv.slice(2)
const ROOT = process.env.ORQ_ROOT
const { prepareWorktree } = await import(pathToFileURL(`${ROOT}/hooks/engine.ts`).href)
const { registerIntegrate } = await import(pathToFileURL(`${ROOT}/hooks/integrate.ts`).href)
const jobsDir = `${home}/.cache/orq/jobs`

let handler = null
registerIntegrate((event, ...rest) => {
  if (event === 'tool.call') handler = rest[rest.length - 1]
})

const dollar = {
  process: {
    run: async (argv, init) => {
      if (argv[0] !== 'git') throw new Error(`the driver runs git only, got ${argv[0]}`)
      const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: init?.timeoutMs ?? 30000 })
      return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false }
    },
  },
  fs: {
    read: async (p) => readFileSync(p, 'utf8'),
    exists: async (p) => existsSync(p),
    list: async (dir) => readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file' })),
    write: async (p, text) => writeFileSync(p, text),
    stat: async (p) => ({ kind: 'file', size: 0, mtimeMs: statSync(p).mtimeMs, isLink: false }),
  },
  clock: { now: async () => Date.now() },
  env: { get: async (name) => process.env[name] },
  plugin: { root: ROOT },
  ui: { log: async () => {} },
}

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

// The answer of the tool for one task, as the model reads its structured content.
async function integrate(taskId, strategy) {
  const input = strategy === undefined ? { taskId } : { taskId, strategy }
  const r = await handler(dollar, { tool: 'mcp__orq__integrate', tool_use_id: `use-${taskId}`, ...input }, async () => {
    throw new Error('the integrate tool answers every call itself')
  })
  return JSON.parse(r.result)
}

// A task as the launch writes it: the worktree from prepareWorktree, and the meta.json beside it.
async function startTask(taskId) {
  const r = await prepareWorktree(dollar, repo, taskId)
  if ('failure' in r) throw new Error(`prepareWorktree refused ${taskId}: ${r.failure.code}`)
  writeMeta(taskId, { repo, baseSha: r.plan.baseSha, branch: r.plan.branch, worktree: r.plan.worktree, cwd: r.plan.worktree })
  return r.plan
}

function writeMeta(taskId, fields) {
  mkdirSync(`${jobsDir}/${taskId}`, { recursive: true })
  writeFileSync(`${jobsDir}/${taskId}/meta.json`, JSON.stringify({ id: taskId, kind: 'manual', agentId: 'manual', startedAt: Date.now(), ...fields }))
}

// A commit by a fake worker, or by someone working in the destination.
function commit(cwd, file, text, message) {
  writeFileSync(`${cwd}/${file}`, text)
  must(cwd, 'add', file)
  must(cwd, 'commit', '-q', '-m', message)
}

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

// A pre-merge-commit hook refuses the merge commit. git leaves the merge pending, so integrate must abort it.
const E = 'task-e'
const planE = await startTask(E)
commit(planE.worktree, 'e.txt', 'task e\n', 'task e work')
commit(repo, 'main.txt', 'main moves on\n', 'main moves on')
const headBeforeE = must(repo, 'rev-parse', 'HEAD')
const hook = `${repo}/.git/hooks/pre-merge-commit`
writeFileSync(hook, '#!/bin/sh\nexit 1\n')
chmodSync(hook, 0o755)
const refused = await integrate(E, 'merge')
check('a merge refused by pre-merge-commit is git_failed, with no MERGE_HEAD, a clean tree and HEAD unmoved', refused.error?.code === 'git_failed' && !existsSync(`${repo}/.git/MERGE_HEAD`) && must(repo, 'status', '--porcelain') === '' && must(repo, 'rev-parse', 'HEAD') === headBeforeE)
rmSync(hook)
check('the same task merges once the hook is gone, so the hook was the only cause', (await integrate(E, 'merge')).ok === true)

check('an unknown task is task_not_found', (await integrate('task-nope')).error?.code === 'task_not_found')
const plain = `${home}/plain`
mkdirSync(plain, { recursive: true })
writeMeta(D, { repo: plain, cwd: `${plain}-wt/${D}`, baseSha: 'abc123', branch: `orq/${D}`, worktree: `${plain}-wt/${D}` })
check('a destination outside any checkout is not_a_repository', (await integrate(D)).error?.code === 'not_a_repository')

console.log(`pass=${passed} fail=${failed}`)
process.exit(failed === 0 ? 0 : 1)
JS

ORQ_ROOT="$ROOT" node "$T/driver.mjs" "$REPO" "$T/home"

[ -z "$(git -C "$REPO" status --porcelain)" ] || { echo "FAIL: checkout is not clean after the run"; exit 1; }
git -C "$REPO" merge-base --is-ancestor "orq/task-a" HEAD || { echo "FAIL: task-a is not in the checkout"; exit 1; }
echo "integrate-shell: scratch cleaned"
