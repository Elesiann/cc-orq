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
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
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

// A plain git worktree, so the copy under test is the only one that runs into it.
const fresh = `${repo}-wt/plain-deadline`
spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', fresh, '-b', 'plain-deadline'])
const late = spawnSync('python3', [`${ROOT}/scripts/worktree-include.py`, repo, fresh, '-1'], { encoding: 'utf8' })
check('a copy past its deadline fails and leaves nothing behind', late.status === 1 && late.stderr.includes('ran out of time') && !existsSync(`${fresh}/node_modules`) && !existsSync(`${fresh}/.local.cfg`))

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
