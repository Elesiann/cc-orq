import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nodeEngine } from '../../server/node-engine.ts'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..', '..')
const MiB = 1024 * 1024
const LIMIT = 4 * MiB
const NODE = process.execPath
const PATH = process.env.PATH ?? ''

const baseEnv = (extra = {}) => ({ PATH, ...extra })

const GIT_ENV = {
  PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'orq-test',
  GIT_AUTHOR_EMAIL: 'orq-test@example.invalid',
  GIT_COMMITTER_NAME: 'orq-test',
  GIT_COMMITTER_EMAIL: 'orq-test@example.invalid',
}

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', env: GIT_ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'orq-node-engine-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// Polls until the pid is gone. Resolves false when the pid still exists after `ms`.
async function goneWithin(pid, ms) {
  const until = Date.now() + ms
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return true
      throw error
    }
    if (Date.now() >= until) return false
    await sleep(50)
  }
}

function withTimeout(promise, ms) {
  let timer
  const late = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`still pending after ${ms} ms`)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

test('stdin text reaches the child, and a child with no stdin reads end of file at once', async () => {
  const $ = nodeEngine({ env: baseEnv() })
  const echo = 'let text = ""; process.stdin.on("data", (d) => { text += d }); process.stdin.on("end", () => process.stdout.write(JSON.stringify(text)))'
  const fed = await $.process.run([NODE, '-e', echo], { stdin: 'héllo\n' })
  assert.equal(fed.exitCode, 0)
  assert.equal(JSON.parse(fed.stdout), 'héllo\n')
  const empty = await $.process.run([NODE, '-e', echo])
  assert.equal(JSON.parse(empty.stdout), '')
})

test('a relative cwd resolves against the shim cwd, and the default cwd is the shim cwd', async (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'sub'))
  const $ = nodeEngine({ cwd: dir, env: baseEnv() })
  const pwd = [NODE, '-e', 'process.stdout.write(process.cwd())']
  assert.equal((await $.process.run(pwd)).stdout, realpathSync(dir))
  assert.equal((await $.process.run(pwd, { cwd: 'sub' })).stdout, realpathSync(join(dir, 'sub')))
})

test('env is set over the base environment, and env.get reads the base environment', async () => {
  const $ = nodeEngine({ env: baseEnv({ SHARED: 'base', ONLY_BASE: 'yes' }) })
  const show = 'process.stdout.write(JSON.stringify([process.env.SHARED, process.env.ONLY_BASE, process.env.ONLY_CALL]))'
  const r = await $.process.run([NODE, '-e', show], { env: { SHARED: 'call', ONLY_CALL: 'yes' } })
  assert.deepEqual(JSON.parse(r.stdout), ['call', 'yes', 'yes'])
  assert.equal(await $.env.get('SHARED'), 'base')
  assert.equal(await $.env.get('ONLY_CALL'), undefined)
  assert.equal(await $.env.get('MISSING_NAME'), undefined)
})

test('a bare command name is looked up on the PATH of the base environment', async (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'fake-cli'), '#!/bin/sh\necho "fake-cli ran with $1"\n')
  chmodSync(join(dir, 'fake-cli'), 0o755)
  const $ = nodeEngine({ cwd: dir, env: baseEnv({ PATH: `${dir}:${PATH}` }) })
  const r = await $.process.run(['fake-cli', 'one'])
  assert.equal(r.exitCode, 0)
  assert.equal(r.stdout, 'fake-cli ran with one\n')
})

test('a child still running at the timeout rejects, and its whole process group is gone afterwards', async (t) => {
  const dir = tempDir(t)
  const pidFile = join(dir, 'pid')
  const $ = nodeEngine({ cwd: dir, env: baseEnv() })
  const script = 'sleep 30 & echo $! > "$1"; wait'
  await assert.rejects(
    $.process.run(['bash', '-c', script, 'bash', pidFile], { timeoutMs: 1000 }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /bash/)
      assert.match(error.message, /1000 ms/)
      return true
    },
  )
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(pid > 0, 'the background sleep recorded its pid before the timeout')
  const gone = await goneWithin(pid, 2000)
  if (!gone) process.kill(pid, 'SIGKILL')
  assert.equal(gone, true, 'the grandchild outlived the killed process group')
})

test('a child ended by a signal resolves with exitCode 1, and an ordinary exit keeps its code', async () => {
  const $ = nodeEngine({ env: baseEnv() })
  const killed = await $.process.run(['sh', '-c', 'kill -9 $$'])
  assert.equal(killed.exitCode, 1)
  const exited = await $.process.run(['sh', '-c', 'exit 3'])
  assert.equal(exited.exitCode, 3)
})

test('a command that does not exist rejects with ENOENT', async () => {
  const $ = nodeEngine({ env: baseEnv() })
  await assert.rejects($.process.run(['orq-no-such-command-xyz']), { code: 'ENOENT' })
})

test('stdout and stderr are each kept to their first 4 MiB and flagged; a stream of exactly 4 MiB is not flagged', async () => {
  const $ = nodeEngine({ env: baseEnv() })
  const over = await $.process.run([
    NODE,
    '-e',
    `process.stdout.write('a'.repeat(${LIMIT + 1000})); process.stderr.write('b'.repeat(${LIMIT + 5}))`,
  ])
  assert.equal(over.stdout.length, LIMIT)
  assert.equal(over.isStdoutTruncated, true)
  assert.equal(over.stderr.length, LIMIT)
  assert.equal(over.isStderrTruncated, true)
  const exact = await $.process.run([NODE, '-e', `process.stdout.write('a'.repeat(${LIMIT}))`])
  assert.equal(exact.stdout.length, LIMIT)
  assert.equal(exact.isStdoutTruncated, false)
})

test('a cut inside a multi-byte character drops that character', async () => {
  const $ = nodeEngine({ env: baseEnv() })
  const r = await $.process.run([NODE, '-e', `process.stdout.write('€'.repeat(${LIMIT}))`])
  assert.equal(r.isStdoutTruncated, true)
  assert.equal(r.stdout, '€'.repeat(Math.floor(LIMIT / 3)))
  assert.equal(Buffer.byteLength(r.stdout), LIMIT - (LIMIT % 3))
})

test('git runs with repository hooks off, so a post-checkout hook does not run through the shim', async (t) => {
  const dir = tempDir(t)
  const repo = join(dir, 'repo')
  const marker = join(dir, 'hook-ran')
  git(['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(['-C', repo, 'add', 'shared.txt'])
  git(['-C', repo, 'commit', '-q', '-m', 'base'])
  const hook = join(repo, '.git', 'hooks', 'post-checkout')
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(hook, 0o755)

  // Control: plain git runs the hook, so the marker shows the hook can fire in this setup.
  git(['-C', repo, 'worktree', 'add', '-q', join(dir, 'control'), '-b', 'control'])
  assert.equal(existsSync(marker), true, 'plain git runs the post-checkout hook')
  rmSync(marker)

  const $ = nodeEngine({ cwd: repo, env: GIT_ENV })
  const r = await $.process.run(['git', 'worktree', 'add', '-q', join(dir, 'shim'), '-b', 'shim'])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(existsSync(marker), false, 'git through the shim left the hook unrun')
})

test('git keeps the config entries the base environment already counts, and adds its hooksPath and fsmonitor pairs after them', async (t) => {
  const dir = tempDir(t)
  const repo = join(dir, 'repo')
  git(['init', '-q', '-b', 'main', repo])
  const $ = nodeEngine({
    cwd: repo,
    env: { ...GIT_ENV, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'from-the-base-env' },
  })
  const name = await $.process.run(['git', 'config', '--get', 'user.name'])
  assert.equal(name.exitCode, 0)
  assert.equal(name.stdout, 'from-the-base-env\n')
  const hooks = await $.process.run(['git', 'config', '--get', 'core.hooksPath'])
  assert.equal(hooks.stdout, '/dev/null\n')
  const fsmonitor = await $.process.run(['git', 'config', '--get', 'core.fsmonitor'])
  assert.equal(fsmonitor.stdout, 'false\n')
})

test('git through the shim does not run a checkout\'s core.fsmonitor program, and reads back both config values', async (t) => {
  const dir = tempDir(t)
  const repo = join(dir, 'repo')
  const marker = join(dir, 'fsmonitor-ran')
  git(['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(['-C', repo, 'add', 'shared.txt'])
  git(['-C', repo, 'commit', '-q', '-m', 'base'])
  const monitor = join(dir, 'monitor.sh')
  writeFileSync(monitor, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(monitor, 0o755)
  git(['-C', repo, 'config', 'core.fsmonitor', monitor])

  git(['-C', repo, 'status', '--porcelain'])
  assert.equal(existsSync(marker), true, 'plain git runs the core.fsmonitor program')
  rmSync(marker)

  const $ = nodeEngine({ cwd: repo, env: GIT_ENV })
  const status = await $.process.run(['git', 'status', '--porcelain'])
  assert.equal(status.exitCode, 0, status.stderr)
  assert.equal(existsSync(marker), false, 'git through the shim left the core.fsmonitor program unrun')
  const fsmonitor = await $.process.run(['git', 'config', '--get', 'core.fsmonitor'])
  assert.equal(fsmonitor.stdout, 'false\n')
  const hooks = await $.process.run(['git', 'config', '--get', 'core.hooksPath'])
  assert.equal(hooks.stdout, '/dev/null\n')
})

test('a command that is not git gets no GIT_CONFIG_* variables from the shim', async () => {
  const $ = nodeEngine({ env: baseEnv() })
  const bare = await $.process.run(['env'])
  assert.equal(bare.exitCode, 0)
  assert.doesNotMatch(bare.stdout, /^GIT_CONFIG_/m)

  const counted = nodeEngine({
    env: baseEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'from-the-base-env' }),
  })
  const seen = await counted.process.run(['env'])
  const config = seen.stdout.split('\n').filter((line) => line.startsWith('GIT_CONFIG_'))
  assert.deepEqual(config.sort(), ['GIT_CONFIG_COUNT=1', 'GIT_CONFIG_KEY_0=user.name', 'GIT_CONFIG_VALUE_0=from-the-base-env'])
})

test('fs.write creates parent folders, replaces an existing file, and leaves no temporary file behind', async (t) => {
  const dir = tempDir(t)
  const $ = nodeEngine({ cwd: dir, env: baseEnv() })
  await $.fs.write('a/b/note.txt', 'first')
  assert.equal(readFileSync(join(dir, 'a', 'b', 'note.txt'), 'utf8'), 'first')
  await $.fs.write('a/b/note.txt', 'second, longer')
  assert.equal(readFileSync(join(dir, 'a', 'b', 'note.txt'), 'utf8'), 'second, longer')
  assert.deepEqual(readdirSync(join(dir, 'a', 'b')), ['note.txt'])
})

test('fs.read rejects a missing file and a file over 4 MiB, and reads a file of exactly 4 MiB', async (t) => {
  const dir = tempDir(t)
  const $ = nodeEngine({ cwd: dir, env: baseEnv() })
  await assert.rejects($.fs.read('missing.txt'), { code: 'ENOENT' })
  writeFileSync(join(dir, 'exact.txt'), 'x'.repeat(LIMIT))
  assert.equal((await $.fs.read('exact.txt')).length, LIMIT)
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(LIMIT + 1))
  await assert.rejects($.fs.read('big.txt'), /larger than 4 MiB/)
})

test('fs.read rejects a FIFO within a second instead of blocking on it', { timeout: 5000 }, async (t) => {
  const dir = tempDir(t)
  const $ = nodeEngine({ cwd: dir, env: baseEnv() })
  assert.equal(spawnSync('mkfifo', [join(dir, 'fifo')]).status, 0)
  await assert.rejects(withTimeout($.fs.read('fifo'), 1000), /fifo.*not a regular file/)
})

test('fs.read rejects a symlink to /dev/zero and a directory, because neither is a regular file', { timeout: 5000 }, async (t) => {
  const dir = tempDir(t)
  const $ = nodeEngine({ cwd: dir, env: baseEnv() })
  symlinkSync('/dev/zero', join(dir, 'zero'))
  mkdirSync(join(dir, 'folder'))
  await assert.rejects(withTimeout($.fs.read('zero'), 1000), /zero.*not a regular file/)
  await assert.rejects(withTimeout($.fs.read('folder'), 1000), /folder.*not a regular file/)
})

test('fs.read follows a symlink to a regular file and returns its text', async (t) => {
  const dir = tempDir(t)
  const $ = nodeEngine({ cwd: dir, env: baseEnv() })
  writeFileSync(join(dir, 'target.txt'), 'linked text, héllo\n')
  symlinkSync('target.txt', join(dir, 'link.txt'))
  assert.equal(await $.fs.read('link.txt'), 'linked text, héllo\n')
})

test('fs.stat reports kinds and isLink, a dangling link as other, realPath with resolve, and rejects a missing path', async (t) => {
  const dir = tempDir(t)
  const $ = nodeEngine({ cwd: dir, env: baseEnv() })
  writeFileSync(join(dir, 'file.txt'), 'abc')
  mkdirSync(join(dir, 'folder'))
  symlinkSync('file.txt', join(dir, 'link-file'))
  symlinkSync('gone.txt', join(dir, 'dangling'))

  const file = await $.fs.stat('file.txt')
  assert.equal(file.kind, 'file')
  assert.equal(file.size, 3)
  assert.equal(file.isLink, false)
  assert.equal('realPath' in file, false)

  const folder = await $.fs.stat('folder')
  assert.equal(folder.kind, 'dir')
  assert.equal(folder.isLink, false)

  const link = await $.fs.stat('link-file')
  assert.equal(link.kind, 'file')
  assert.equal(link.size, 3)
  assert.equal(link.isLink, true)
  assert.equal((await $.fs.stat('link-file', { resolve: true })).realPath, realpathSync(join(dir, 'file.txt')))

  const dangling = await $.fs.stat('dangling')
  assert.equal(dangling.kind, 'other')
  assert.equal(dangling.isLink, true)
  assert.equal(dangling.size, 'gone.txt'.length, 'a dangling link reports its own size')
  assert.equal('realPath' in (await $.fs.stat('dangling', { resolve: true })), false)

  await assert.rejects($.fs.stat('missing.txt'), { code: 'ENOENT' })
})

test('fs.list reports kinds, a link as other with isLink, and 0 size and mtime for every non-file', async (t) => {
  const dir = tempDir(t)
  const $ = nodeEngine({ cwd: dir, env: baseEnv() })
  writeFileSync(join(dir, 'file.txt'), 'hello')
  utimesSync(join(dir, 'file.txt'), 1_700_000_000, 1_700_000_000)
  mkdirSync(join(dir, 'folder'))
  symlinkSync('file.txt', join(dir, 'link'))

  const byName = Object.fromEntries((await $.fs.list()).map((entry) => [entry.name, entry]))
  assert.deepEqual(byName['file.txt'], { name: 'file.txt', kind: 'file', size: 5, mtimeMs: 1_700_000_000_000, isLink: false })
  assert.deepEqual(byName.folder, { name: 'folder', kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
  assert.deepEqual(byName.link, { name: 'link', kind: 'other', size: 0, mtimeMs: 0, isLink: true })
  assert.equal(Object.keys(byName).length, 3)
})

test('ui.log writes its line to stderr and nothing to stdout', async () => {
  const $ = nodeEngine({ env: baseEnv() })
  const shim = pathToFileURL(join(REPO, 'server', 'node-engine.ts')).href
  const script = 'const { nodeEngine } = await import(process.argv[1]); nodeEngine().ui.log("line from the shim")'
  const r = await $.process.run([NODE, '--input-type=module', '-e', script, shim])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /^line from the shim$/m)
})

test('plugin.root is the repository root by default', () => {
  const root = nodeEngine({ env: baseEnv() }).plugin.root
  assert.equal(root, REPO)
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name, 'cc-orq')
})

test('CLAUDE_PLUGIN_ROOT in the base environment overrides plugin.root, and the pluginRoot option overrides both', () => {
  assert.equal(nodeEngine({ env: baseEnv({ CLAUDE_PLUGIN_ROOT: '/opt/cc-orq' }) }).plugin.root, '/opt/cc-orq')
  const explicit = nodeEngine({ env: baseEnv({ CLAUDE_PLUGIN_ROOT: '/opt/cc-orq' }), pluginRoot: '/srv/elsewhere' })
  assert.equal(explicit.plugin.root, '/srv/elsewhere')
})
