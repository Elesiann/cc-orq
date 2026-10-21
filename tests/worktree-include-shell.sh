#!/bin/bash
# .worktreeinclude against real git: a temporary checkout under .ref/tmp with ignored files, and task
# worktrees cut from it by the real prepareWorktree over a process.run that runs git and python3. Git reads
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
OUTSIDE="$T/outside"
mkdir -p "$OUTSIDE"
printf 'node_modules/\n.local.cfg\nbuild/\nlink/\n:memory:\n-dash.cfg\nnested/\n' > "$REPO/.gitignore"
printf 'tracked\n' > "$REPO/tracked.txt"
ln -s "$OUTSIDE" "$REPO/link"
git -C "$REPO" add .gitignore tracked.txt
git -C "$REPO" add -f link
git -C "$REPO" commit -q -m base
rm "$REPO/link"
mkdir -p "$REPO/link"
printf 'escape\n' > "$REPO/link/b.txt"
printf 'secret.local\n' >> "$REPO/.gitignore"
printf 'secret\n' > "$REPO/secret.local"
printf 'memory\n' > "$REPO/:memory:"
printf 'dash\n' > "$REPO/-dash.cfg"
git init -q "$REPO/nested"
printf 'nested\n' > "$REPO/nested/n.txt"
mkdir -p "$REPO/node_modules/pkg/.bin" "$REPO/build"
printf 'module\n' > "$REPO/node_modules/pkg/index.js"
printf 'spaced\n' > "$REPO/node_modules/pkg/with space.js"
ln -s ../index.js "$REPO/node_modules/pkg/.bin/pkg"
printf 'local\n' > "$REPO/.local.cfg"
printf 'out\n' > "$REPO/build/out.txt"
printf 'notes\n' > "$REPO/notes.txt"

cat > "$T/driver.mjs" <<'JS'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const [repo, outside] = process.argv.slice(2)
const ROOT = process.env.ORQ_ROOT
const { prepareWorktree } = await import(pathToFileURL(`${ROOT}/hooks/engine.ts`).href)

const logs = []
const dollar = {
  process: {
    run: async (argv, init) => {
      if (argv[0] !== 'git' && argv[0] !== 'python3') throw new Error(`the driver runs git and python3 only, got ${argv[0]}`)
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

writeFileSync(`${repo}/.worktreeinclude`, 'node_modules/\n.local.cfg\nnotes.txt\ntracked.txt\nlink/\nsecret.local\n:memory:\n-dash.cfg\nnested/\n')
const wt = await worktree('task-include')
check('an ignored directory named in .worktreeinclude is copied', readFileSync(`${wt}/node_modules/pkg/index.js`, 'utf8') === 'module\n')
check('a path with a space is copied', readFileSync(`${wt}/node_modules/pkg/with space.js`, 'utf8') === 'spaced\n')
check('a symlink is copied as a symlink', lstatSync(`${wt}/node_modules/pkg/.bin/pkg`).isSymbolicLink() && readlinkSync(`${wt}/node_modules/pkg/.bin/pkg`) === '../index.js')
check('an ignored file named in .worktreeinclude is copied', readFileSync(`${wt}/.local.cfg`, 'utf8') === 'local\n')
check('names that look like pathspec magic or options are copied', readFileSync(`${wt}/:memory:`, 'utf8') === 'memory\n' && readFileSync(`${wt}/-dash.cfg`, 'utf8') === 'dash\n')
check('an untracked file that is not ignored is not copied', !existsSync(`${wt}/notes.txt`))
check('an ignored directory not named in .worktreeinclude is not copied', !existsSync(`${wt}/build`))
check('a tracked file comes from git, not from the copy', readFileSync(`${wt}/tracked.txt`, 'utf8') === 'tracked\n')
check('nothing is written through a symlink the worktree holds', !existsSync(`${outside}/b.txt`) && lstatSync(`${wt}/link`).isSymbolicLink())
check('a file ignored only by an uncommitted .gitignore line is not copied', !existsSync(`${wt}/secret.local`))
check('an untracked nested repository is not copied', !existsSync(`${wt}/nested`))
check('the worktree shows no untracked file after the copy', spawnSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' }).stdout === '')
check('the copy is logged with its counts', logs.some((l) => l.includes('copied 6 and skipped')))

// Direct runs of the script against plain git worktrees, so its own behavior is what is checked.
const script = `${ROOT}/scripts/worktree-include.py`
let plainCount = 0
function plainWorktree() {
  plainCount += 1
  const path = `${repo}-wt/plain-${plainCount}`
  spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', path, '-b', `plain-${plainCount}`])
  return path
}
const staged = (wt) => existsSync(`${dirname(wt)}/.orq-include-${basename(wt)}`)
const run = (cmd) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })

run(`printf 'big/\\n' >> '${repo}/.gitignore' && git -C '${repo}' commit -q -am big`)
writeFileSync(`${repo}/.worktreeinclude`, 'big/\n')
mkdirSync(`${repo}/big/deep`, { recursive: true })
writeFileSync(`${repo}/big/a.js`, 'a\n')
writeFileSync(`${repo}/big/deep/big.bin`, Buffer.alloc(300 * 1024, 1))
const full = plainWorktree()
const limited = run(`ulimit -f 100; exec python3 '${script}' '${repo}' '${full}' 60`)
check('a write that fails midway leaves no partial file and no staging directory', limited.status === 1 && !existsSync(`${full}/big`) && !staged(full))

for (let i = 0; i < 20000; i += 1) {
  if (i % 1000 === 0) mkdirSync(`${repo}/big/many/${i / 1000}`, { recursive: true })
  writeFileSync(`${repo}/big/many/${Math.floor(i / 1000)}/${i}.js`, 'x\n')
}
const timed = plainWorktree()
const overdue = run(`exec python3 '${script}' '${repo}' '${timed}' 0.2`)
check('a copy past its deadline midway is undone', overdue.status === 1 && overdue.stderr.includes('ran out of time') && !existsSync(`${timed}/big`) && !staged(timed))
const termed = plainWorktree()
const term = run(`timeout --preserve-status -s TERM 0.2 python3 '${script}' '${repo}' '${termed}' 60`)
check('a copy stopped by SIGTERM is undone', term.status === 1 && term.stderr.includes('signal') && !existsSync(`${termed}/big`) && !staged(termed))
rmSync(`${repo}/big`, { recursive: true, force: true })

writeFileSync(`${repo}/x1.cfg`, 'tracked\n')
spawnSync('git', ['-C', repo, 'add', 'x1.cfg'])
spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x1'])
spawnSync('bash', ['-c', `printf 'x*.cfg\\n' >> '${repo}/.gitignore' && git -C '${repo}' commit -q -am glob`])
writeFileSync(`${repo}/x[0-9].cfg`, 'glob name\n')
mkdirSync(`${repo}/priv`, { recursive: true })
writeFileSync(`${repo}/priv/key.txt`, 'k\n')
spawnSync('chmod', ['700', `${repo}/priv`])
spawnSync('bash', ['-c', `printf 'priv/\\n' >> '${repo}/.gitignore' && git -C '${repo}' commit -q -am priv`])
writeFileSync(`${repo}/.worktreeinclude`, 'x[[]0-9].cfg\npriv/\n')
const globbed = plainWorktree()
const globRun = run(`exec python3 '${script}' '${repo}' '${globbed}' 60`)
check('a name with glob characters is judged as itself, not as a pattern over tracked files', globRun.status === 0 && existsSync(`${globbed}/x[0-9].cfg`) && readFileSync(`${globbed}/x[0-9].cfg`, 'utf8') === 'glob name\n')
check('a copied directory keeps its source mode', (statSync(`${globbed}/priv`).mode & 0o777) === 0o700)

// An unreadable file fails the copy midway; root reads it anyway, so the case needs another user.
if (process.getuid() !== 0) {
  writeFileSync(`${repo}/.worktreeinclude`, 'node_modules/\n')
  writeFileSync(`${repo}/node_modules/pkg/zz-unreadable.js`, 'x\n', { mode: 0o000 })
  const broken = await prepareWorktree(dollar, repo, 'task-broken')
  check('a copy that fails still gives the task its worktree', !('failure' in broken) && existsSync(`${broken.plan.worktree}/tracked.txt`))
  check('a copy that fails is undone, so no partial node_modules is left', !existsSync(`${broken.plan.worktree}/node_modules`))
  check('a copy that fails is logged as undone', logs.some((l) => l.includes('failed and was undone')))
}

console.log(`pass=${passed} fail=${failed}`)
process.exit(failed === 0 ? 0 : 1)
JS

ORQ_ROOT="$ROOT" node "$T/driver.mjs" "$REPO" "$OUTSIDE"
