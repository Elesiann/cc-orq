#!/bin/bash
# .worktreeinclude against real git: a temporary checkout under .ref/tmp with ignored files, and task
# worktrees cut from it by the real prepareWorktree over a process.run that runs git and bash. Git reads
# no global or system config here, so the host's ignore settings cannot change the result.
# Usage: bash tests/worktree-include-shell.sh
set -e -o pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T="$ROOT/.ref/tmp/worktree-include-shell-$(date +%s)-$$"
mkdir -p "$T/home"
trap 'rm -rf "$T"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CEILING_DIRECTORIES="$T" HOME="$T/home"
export GIT_AUTHOR_NAME=orq-test GIT_AUTHOR_EMAIL=orq-test@example.invalid
export GIT_COMMITTER_NAME=orq-test GIT_COMMITTER_EMAIL=orq-test@example.invalid

REPO="$T/repo"
git init -q -b main "$REPO"
printf 'node_modules/\n.local.cfg\nbuild/\n' > "$REPO/.gitignore"
printf 'tracked\n' > "$REPO/tracked.txt"
git -C "$REPO" add .gitignore tracked.txt
git -C "$REPO" commit -q -m base
mkdir -p "$REPO/node_modules/pkg/.bin" "$REPO/build"
printf 'module\n' > "$REPO/node_modules/pkg/index.js"
printf 'spaced\n' > "$REPO/node_modules/pkg/with space.js"
ln -s ../index.js "$REPO/node_modules/pkg/.bin/pkg"
printf 'local\n' > "$REPO/.local.cfg"
printf 'out\n' > "$REPO/build/out.txt"
printf 'notes\n' > "$REPO/notes.txt"

cat > "$T/driver.mjs" <<'JS'
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const [repo] = process.argv.slice(2)
const ROOT = process.env.ORQ_ROOT
const { prepareWorktree } = await import(pathToFileURL(`${ROOT}/hooks/engine.ts`).href)

const logs = []
const dollar = {
  process: {
    run: async (argv, init) => {
      if (argv[0] !== 'git' && argv[0] !== 'bash') throw new Error(`the driver runs git and bash only, got ${argv[0]}`)
      const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: init?.timeoutMs ?? 30000 })
      return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false }
    },
  },
  fs: {
    read: async (p) => readFileSync(p, 'utf8'),
    exists: async (p) => existsSync(p),
    stat: async (p) => { const st = statSync(p); return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs, isLink: false } },
  },
  clock: { now: async () => Date.now() },
  env: { get: async (name) => process.env[name] },
  plugin: { root: ROOT },
  ui: { log: async (text) => { logs.push(text) } },
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

async function worktree(taskId) {
  const r = await prepareWorktree(dollar, repo, taskId)
  if ('failure' in r) throw new Error(`prepareWorktree refused ${taskId}: ${r.failure.code}`)
  return r.plan.worktree
}

const bare = await worktree('task-none')
check('without .worktreeinclude the worktree holds the tracked files only', existsSync(`${bare}/tracked.txt`) && !existsSync(`${bare}/node_modules`) && !existsSync(`${bare}/.local.cfg`))
check('without .worktreeinclude nothing is logged', logs.length === 0)

writeFileSync(`${repo}/.worktreeinclude`, 'node_modules/\n.local.cfg\nnotes.txt\ntracked.txt\n')
const wt = await worktree('task-include')
check('an ignored directory named in .worktreeinclude is copied', readFileSync(`${wt}/node_modules/pkg/index.js`, 'utf8') === 'module\n')
check('a path with a space is copied', readFileSync(`${wt}/node_modules/pkg/with space.js`, 'utf8') === 'spaced\n')
check('a symlink is copied as a symlink', lstatSync(`${wt}/node_modules/pkg/.bin/pkg`).isSymbolicLink() && readlinkSync(`${wt}/node_modules/pkg/.bin/pkg`) === '../index.js')
check('an ignored file named in .worktreeinclude is copied', readFileSync(`${wt}/.local.cfg`, 'utf8') === 'local\n')
check('an untracked file that is not ignored is not copied', !existsSync(`${wt}/notes.txt`))
check('an ignored directory not named in .worktreeinclude is not copied', !existsSync(`${wt}/build`))
check('a tracked file comes from git, not from the copy', readFileSync(`${wt}/tracked.txt`, 'utf8') === 'tracked\n')
check('the copy is logged with its file count', logs.some((l) => l.includes('copied 4 file(s)')))

rmSync(`${repo}/node_modules/pkg/index.js`)
writeFileSync(`${repo}/.worktreeinclude`, 'node_modules/\n')
spawnSync('chmod', ['000', `${repo}/node_modules/pkg/with space.js`])
const broken = await prepareWorktree(dollar, repo, 'task-broken')
spawnSync('chmod', ['644', `${repo}/node_modules/pkg/with space.js`])
check('a copy that fails still gives the task its worktree', !('failure' in broken) && existsSync(`${broken.plan.worktree}/tracked.txt`))
check('a copy that fails is logged', logs.some((l) => l.includes('.worktreeinclude copy into') && l.includes('failed')))

console.log(`pass=${passed} fail=${failed}`)
process.exit(failed === 0 ? 0 : 1)
JS

ORQ_ROOT="$ROOT" node "$T/driver.mjs" "$REPO"
