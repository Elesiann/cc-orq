import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SWEEP = join(root, 'scripts', 'sweep.py')
let counter = 0
const marker = () => `ORQ_SWEEP_TEST=${process.pid}-${(counter += 1)}-${Date.now()}`
const envWith = (pair) => ({ ...process.env, [pair.split('=')[0]]: pair.slice(pair.indexOf('=') + 1) })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hasProc = existsSync('/proc/self')
const needsProc = { skip: !hasProc && 'the sweep reads /proc, which this machine does not have' }

// A process in a session of its own, as an MCP server that left its CLI's group would be. Its whole group is
// killed when the test ends, whatever the test found, so that nothing it started outlives the suite.
const endGroup = (pid) => {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    /* the group is already gone */
  }
}
function stray(t, script, env) {
  const child = spawn('bash', ['-c', script], { env, detached: true, stdio: 'ignore' })
  child.unref()
  const gone = new Promise((resolve) => child.on('exit', () => resolve(true)))
  t.after(() => endGroup(child.pid))
  return { gone, alive: () => child.exitCode === null && child.signalCode === null }
}
const running = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'
  } catch {
    return false
  }
}
const settled = (p, ms) => Promise.race([p.gone, pause(ms).then(() => false)])
const sweep = (args, options = {}) => spawnSync('python3', [SWEEP, ...args], { encoding: 'utf8', ...options })

test('sweep.py ends a process that carries the marker outside its process group and spares every other process', needsProc, async (t) => {
  const mark = marker()
  const marked = stray(t, 'exec sleep 60', envWith(mark))
  const unmarked = stray(t, 'exec sleep 60', process.env)
  const otherValue = stray(t, 'exec sleep 60', envWith(`${mark}-other`))
  await pause(200)
  const run = sweep([mark])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(await settled(marked, 3000), true, 'the marked process is still running')
  assert.match(run.stderr, /ended 1 process/)
  assert.equal(unmarked.alive(), true, 'a process without the marker was ended')
  assert.equal(otherValue.alive(), true, 'a process with the same variable and another value was ended')
})

test('sweep.py spares its own ancestors even when they carry the marker', needsProc, async (t) => {
  const mark = marker()
  const sibling = stray(t, 'exec sleep 60', envWith(mark))
  await pause(200)
  const outer = `bash -c 'python3 ${SWEEP} ${mark}; echo survived'`
  const run = spawnSync('bash', ['-c', outer], { encoding: 'utf8', env: envWith(mark) })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.trim(), 'survived', 'the shell that called the sweep was ended')
  assert.equal(await settled(sibling, 3000), true, 'the marked sibling is still running')
})

test('sweep.py ends a process that ignores SIGTERM at once, without waiting out the grace period', needsProc, async (t) => {
  const mark = marker()
  const stubborn = stray(t, "trap '' TERM; exec sleep 60", envWith(mark))
  await pause(200)
  const started = Date.now()
  const run = sweep([mark, '5'])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(await settled(stubborn, 3000), true, 'the process that ignores SIGTERM is still running')
  assert.ok(Date.now() - started < 2500, `the sweep waited ${Date.now() - started} ms for a process that cannot be asked to stop`)
})

test('sweep.py asks a process to stop with SIGTERM first, and ends one that keeps running after the grace period', needsProc, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'orq-sweep-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const mark = marker()
  const polite = stray(t, `trap 'echo stopped > ${dir}/polite; exit 0' TERM; sleep 60 & wait`, envWith(mark))
  const deaf = stray(t, "trap ':' TERM; while :; do sleep 1; done", envWith(mark))
  await pause(300)
  const started = Date.now()
  const run = sweep([mark, '0.6'])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(await settled(polite, 3000), true, 'the process that handles SIGTERM is still running')
  assert.equal(await settled(deaf, 3000), true, 'the process that outlives its grace period is still running')
  assert.equal(existsSync(join(dir, 'polite')), true, 'the process was ended without a SIGTERM first')
  assert.ok(Date.now() - started >= 500, 'the sweep did not wait for the process that stays up after SIGTERM')
})

test('sweep.py spares what runs below --spare-tree, and still ends a marked process elsewhere', needsProc, async (t) => {
  const mark = marker()
  const holder = spawn('bash', ['-c', 'sleep 60 & wait'], { env: envWith(mark), detached: true, stdio: 'ignore' })
  holder.unref()
  t.after(() => endGroup(holder.pid))
  const elsewhere = stray(t, 'exec sleep 60', envWith(mark))
  await pause(300)
  const run = sweep([mark, '--spare-tree', String(holder.pid)])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(await settled(elsewhere, 3000), true, 'the marked process outside the spared tree is still running')
  assert.match(run.stderr, /ended 1 process that carried/, 'only the process outside the spared tree should be counted and ended')
  assert.equal(holder.exitCode === null && holder.signalCode === null, true, 'the process at the root of the spared tree was ended')
  const below = spawnSync('pgrep', ['-P', String(holder.pid), '-x', 'sleep'], { encoding: 'utf8' })
  assert.notEqual(below.stdout.trim(), '', 'the process below the spared root was ended')
})

test('sweep.py scans again for a process that a marked process starts when it gets SIGTERM', needsProc, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'orq-sweep-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const mark = marker()
  const respawner = stray(t, `trap 'sleep 60 & echo $! > ${dir}/started; exit 0' TERM; sleep 60 & wait`, envWith(mark))
  await pause(300)
  const run = sweep([mark, '0.6'])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(await settled(respawner, 3000), true, 'the process that handles SIGTERM is still running')
  const started = Number(readFileSync(join(dir, 'started'), 'utf8'))
  assert.ok(started > 0, 'the process did not start another one when it got SIGTERM')
  for (let waited = 0; running(started) && waited < 2000; waited += 50) await pause(50)
  assert.equal(running(started), false, 'the process started during the sweep is still running')
})

test('sweep.py exits 0 and ends nothing when no process carries the marker', () => {
  const run = sweep([marker()])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stderr, '')
})

test('where /proc is missing the sweep ends nothing, not even a process that carries the marker', { skip: hasProc && 'this machine has /proc' }, async (t) => {
  const mark = marker()
  const marked = stray(t, 'exec sleep 60', envWith(mark))
  await pause(200)
  const run = sweep([mark])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stderr, '')
  assert.equal(marked.alive(), true, 'the marked process was ended without /proc to find it by')
})
