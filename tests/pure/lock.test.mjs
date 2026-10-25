import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { LAUNCH_GRACE_MS, checkoutOf, claimCheckout, judgeLock, releaseLock, sha256Hex } from '../../hooks/lock.ts'
import { shellWord } from '../../hooks/types.ts'
import { nodeEngine } from '../../server/node-engine.ts'

test('sha256Hex agrees with node:crypto across padding boundaries and non-ASCII text', () => {
  const samples = [
    '',
    'abc',
    '/home/user/project',
    '/home/user/projéto/ação-日本語',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(63),
    'x'.repeat(64),
    'x'.repeat(65),
    `/srv/${'deep/'.repeat(80)}checkout`,
    '\u{1F680} launch',
  ]
  for (const text of samples) {
    assert.equal(sha256Hex(text), createHash('sha256').update(text, 'utf8').digest('hex'), JSON.stringify(text.slice(0, 40)))
  }
})

const YOUNG = LAUNCH_GRACE_MS - 1
const OLD = LAUNCH_GRACE_MS

test('a lock is busy while its owner runs, however old it is', () => {
  assert.deepEqual(judgeLock({ owner: 'job-a', ageMs: 0, state: 'running' }), { kind: 'busy', owner: 'job-a' })
  assert.deepEqual(judgeLock({ owner: 'job-a', ageMs: 7 * 24 * 3600_000, state: 'running' }), { kind: 'busy', owner: 'job-a' })
})

test('a lock is dead once its owner has finished or lost its supervisor, even a young one', () => {
  assert.deepEqual(judgeLock({ owner: 'job-a', ageMs: 0, state: 'finished' }), { kind: 'dead' })
  assert.deepEqual(judgeLock({ owner: 'job-a', ageMs: 0, state: 'gone' }), { kind: 'dead' })
})

test('an owner with no exit file and no pgid holds a lock younger than 10 s and loses one that is 10 s old', () => {
  assert.deepEqual(judgeLock({ owner: 'job-a', ageMs: YOUNG, state: 'unstarted' }), { kind: 'busy', owner: 'job-a' })
  assert.deepEqual(judgeLock({ owner: 'job-a', ageMs: OLD, state: 'unstarted' }), { kind: 'dead' })
})

test('a lock with no owner yet is a launch in progress for 10 s, then abandoned', () => {
  assert.deepEqual(judgeLock({ owner: null, ageMs: YOUNG }), { kind: 'busy', owner: null })
  assert.deepEqual(judgeLock({ owner: null, ageMs: OLD }), { kind: 'dead' })
})

// The rest runs the real lock scripts over the Node shim, on a temporary directory.

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orq-lock-')))
  return { root, engine: nodeEngine({ env: { ...process.env } }), jobsDir: join(root, 'jobs') }
}

function checkoutWithSubdirectory(root) {
  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
  return repo
}

test('a subdirectory of a checkout, and a symlink to the checkout or to a subdirectory, key the same lock', async () => {
  const { root, engine } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    symlinkSync(repo, join(root, 'link'))
    symlinkSync(join(repo, 'src', 'deep'), join(root, 'deep-link'))
    const want = { key: repo, repository: true }
    for (const spelling of [repo, `${repo}/`, join(repo, 'src'), join(repo, 'src', 'deep'), join(root, 'link'), join(root, 'link', 'src'), join(root, 'deep-link')]) {
      assert.deepEqual(await checkoutOf(engine, spelling), want, spelling)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a .git file, as a worktree or a submodule has, marks a checkout like a .git directory does', async () => {
  const { root, engine } = scratch()
  try {
    const tree = join(root, 'tree')
    mkdirSync(join(tree, 'sub'), { recursive: true })
    writeFileSync(join(tree, '.git'), 'gitdir: /somewhere/else\n')
    assert.deepEqual(await checkoutOf(engine, join(tree, 'sub')), { key: tree, repository: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('outside a repository the real directory keys the lock, and a link to a directory inside a checkout leaves the checkout', async () => {
  const { root, engine } = scratch()
  try {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    symlinkSync(plain, join(root, 'plain-link'))
    assert.deepEqual(await checkoutOf(engine, plain), { key: plain, repository: false })
    assert.deepEqual(await checkoutOf(engine, join(root, 'plain-link')), { key: plain, repository: false })
    const repo = checkoutWithSubdirectory(root)
    symlinkSync(plain, join(repo, 'src', 'out'))
    assert.deepEqual(await checkoutOf(engine, join(repo, 'src', 'out')), { key: plain, repository: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a path that does not exist keys the lock as given, without a trailing slash', async () => {
  const { engine } = scratch()
  assert.deepEqual(await checkoutOf(engine, '/orq-test-missing/dir/'), { key: '/orq-test-missing/dir', repository: false })
})

function probeOf(states) {
  return async (id) => states[id] ?? 'running'
}

function locksIn(jobsDir) {
  return readdirSync(join(jobsDir, '.locks'))
}

function backdate(path, seconds) {
  const then = new Date(Date.now() - seconds * 1000)
  utimesSync(path, then, then)
}

// `shim` is bash that runs before the script of one action; a shell function in it shadows a command the script
// calls, which is how another launcher acts in the middle of the script without any timing.
function withShim(engine, action, shim) {
  const run = (argv, init) => {
    const script = argv[2]
    return engine.process.run(script.startsWith(`# orq:lock ${action}`) ? ['bash', '-c', `${shim}\n${script}`] : argv, init)
  }
  return { ...engine, process: { ...engine.process, run } }
}

test('a claim writes the owner and the key, and a second claim is busy with the first owner id', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    const first = await claimCheckout(engine, jobsDir, 'job-a', join(repo, 'src'), probeOf({}))
    assert.equal(first.kind, 'held')
    assert.deepEqual(first.checkout, { key: repo, repository: true })
    const [name] = locksIn(jobsDir)
    assert.equal(name, sha256Hex(repo))
    assert.equal(readFileSync(join(jobsDir, '.locks', name, 'owner'), 'utf8'), 'job-a\n')
    assert.equal(readFileSync(join(jobsDir, '.locks', name, 'key'), 'utf8'), `${repo}\n`)
    assert.deepEqual(await claimCheckout(engine, jobsDir, 'job-b', repo, probeOf({})), { kind: 'busy', owner: 'job-a' })
    assert.deepEqual(locksIn(jobsDir), [name])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a lock whose owner finished or lost its supervisor is broken, taken, and leaves no tombstone behind', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    assert.equal((await claimCheckout(engine, jobsDir, 'job-a', repo, probeOf({}))).kind, 'held')
    const second = await claimCheckout(engine, jobsDir, 'job-b', repo, probeOf({ 'job-a': 'finished' }))
    assert.equal(second.kind, 'held')
    const third = await claimCheckout(engine, jobsDir, 'job-c', repo, probeOf({ 'job-b': 'gone' }))
    assert.equal(third.kind, 'held')
    const [name, ...rest] = locksIn(jobsDir)
    assert.deepEqual(rest, [])
    assert.equal(readFileSync(join(jobsDir, '.locks', name, 'owner'), 'utf8'), 'job-c\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an owner with no pgid yet keeps a lock that is under 10 s old, and loses one that is older', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    assert.equal((await claimCheckout(engine, jobsDir, 'job-a', repo, probeOf({}))).kind, 'held')
    const lock = join(jobsDir, '.locks', sha256Hex(repo))
    const unstarted = probeOf({ 'job-a': 'unstarted' })
    backdate(lock, 5)
    assert.deepEqual(await claimCheckout(engine, jobsDir, 'job-b', repo, unstarted), { kind: 'busy', owner: 'job-a' })
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'job-a\n')
    backdate(lock, 15)
    assert.equal((await claimCheckout(engine, jobsDir, 'job-b', repo, unstarted)).kind, 'held')
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'job-b\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a lock with no owner is a launch in progress while young and abandoned when old, and an owner file that is not a job id is no owner', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    const lock = join(jobsDir, '.locks', sha256Hex(repo))
    mkdirSync(lock, { recursive: true })
    assert.deepEqual(await claimCheckout(engine, jobsDir, 'job-b', repo, probeOf({})), { kind: 'busy', owner: null })
    writeFileSync(join(lock, 'owner'), 'not a job id; rm -rf /\n')
    backdate(lock, 2)
    assert.deepEqual(await claimCheckout(engine, jobsDir, 'job-b', repo, probeOf({})), { kind: 'busy', owner: null })
    backdate(lock, 20)
    assert.equal((await claimCheckout(engine, jobsDir, 'job-b', repo, probeOf({}))).kind, 'held')
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'job-b\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('releasing gives the lock back, and never removes a lock that another job took since', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    const mine = await claimCheckout(engine, jobsDir, 'job-a', repo, probeOf({}))
    assert.equal(mine.kind, 'held')
    await releaseLock(engine, mine.held, probeOf({}))
    assert.deepEqual(locksIn(jobsDir), [])
    const again = await claimCheckout(engine, jobsDir, 'job-a2', repo, probeOf({}))
    assert.equal(again.kind, 'held')
    const lock = join(jobsDir, '.locks', sha256Hex(repo))
    writeFileSync(join(lock, 'owner'), 'job-taker\n')
    await releaseLock(engine, again.held, probeOf({}))
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'job-taker\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a lock broken between the claim\'s failed mkdir and its look at the directory is claimed, not reported as a failure', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    const lock = join(jobsDir, '.locks', sha256Hex(repo))
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner'), 'job-gone\n')
    const racing = withShim(
      engine,
      'claim',
      `mkdir() { command mkdir "$@"; local rc=$?; [ $rc -ne 0 ] && [ "$1" = ${shellWord(lock)} ] && rm -rf ${shellWord(lock)}; return $rc; }`,
    )
    const claim = await claimCheckout(racing, jobsDir, 'job-new', repo, probeOf({ 'job-gone': 'finished' }))
    assert.equal(claim.kind, 'held', JSON.stringify(claim))
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'job-new\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a lock broken and taken by another launcher between the claim\'s failed mkdir and its look is judged, and busy names the taker', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    const lock = join(jobsDir, '.locks', sha256Hex(repo))
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner'), 'job-gone\n')
    const taken = `rm -rf ${shellWord(lock)}; command mkdir ${shellWord(lock)}; printf 'job-taker\\n' > ${shellWord(`${lock}/owner`)}`
    const racing = withShim(
      engine,
      'claim',
      `mkdir() { command mkdir "$@"; local rc=$?; if [ $rc -ne 0 ] && [ "$1" = ${shellWord(lock)} ]; then ${taken}; fi; return $rc; }`,
    )
    assert.deepEqual(await claimCheckout(racing, jobsDir, 'job-new', repo, probeOf({ 'job-gone': 'finished' })), {
      kind: 'busy',
      owner: 'job-taker',
    })
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'job-taker\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a mutex released between the mutex script\'s failed mkdir and its look at the directory is taken on the next try, not reported as a launch in progress', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    const lock = join(jobsDir, '.locks', sha256Hex(repo))
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner'), 'job-dead\n')
    mkdirSync(`${lock}.mutex`)
    const releasing = withShim(
      engine,
      'mutex',
      `mkdir() { command mkdir "$@"; local rc=$?; [ $rc -ne 0 ] && rmdir ${shellWord(`${lock}.mutex`)} 2>/dev/null; return $rc; }`,
    )
    const claim = await claimCheckout(releasing, jobsDir, 'job-new', repo, probeOf({ 'job-dead': 'finished' }))
    assert.equal(claim.kind, 'held', JSON.stringify(claim))
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'job-new\n')
    assert.equal(existsSync(`${lock}.mutex`), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an owner that cannot be written leaves no lock behind and is answered as a failure to lock', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    const claim = await claimCheckout(withShim(engine, 'claim', 'ulimit -f 0'), jobsDir, 'job-a', repo, probeOf({}))
    assert.equal(claim.kind, 'failed', JSON.stringify(claim))
    assert.deepEqual(locksIn(jobsDir), [])
    assert.equal((await claimCheckout(engine, jobsDir, 'job-b', repo, probeOf({}))).kind, 'held')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a dead lock that cannot be moved aside is answered as a failure to lock, and stays for the next launch to break', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    const lock = join(jobsDir, '.locks', sha256Hex(repo))
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner'), 'job-dead\n')
    const probe = probeOf({ 'job-dead': 'finished' })
    const claim = await claimCheckout(withShim(engine, 'aside', 'mv() { return 1; }'), jobsDir, 'job-a', repo, probe)
    assert.equal(claim.kind, 'failed', JSON.stringify(claim))
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'job-dead\n')
    assert.equal((await claimCheckout(engine, jobsDir, 'job-b', repo, probe)).kind, 'held')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('twenty claims at once on one checkout give exactly one holder, and the others name it', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claimCheckout(engine, jobsDir, `job-${i}`, repo, probeOf({}))),
    )
    const held = results.filter((r) => r.kind === 'held')
    assert.equal(held.length, 1)
    const winner = held[0].held.owner
    for (const r of results.filter((r) => r.kind === 'busy')) assert.ok(r.owner === winner || r.owner === null, JSON.stringify(r))
    assert.equal(results.filter((r) => r.kind === 'busy').length, 19)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two claims that break one dead lock at once never both hold it', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    for (let round = 0; round < 25; round += 1) {
      const repo = join(root, `repo-${round}`)
      mkdirSync(join(repo, '.git'), { recursive: true })
      assert.equal((await claimCheckout(engine, jobsDir, `dead-${round}`, repo, probeOf({}))).kind, 'held')
      const probe = probeOf({ [`dead-${round}`]: 'finished' })
      const [a, b] = await Promise.all([
        claimCheckout(engine, jobsDir, `left-${round}`, repo, probe),
        claimCheckout(engine, jobsDir, `right-${round}`, repo, probe),
      ])
      assert.equal([a, b].filter((r) => r.kind === 'held').length, 1, `round ${round}: ${JSON.stringify([a, b])}`)
      const lock = join(jobsDir, '.locks', sha256Hex(repo))
      const owner = readFileSync(join(lock, 'owner'), 'utf8').trim()
      assert.equal(owner, [a, b].find((r) => r.kind === 'held').held.owner)
    }
    assert.deepEqual(locksIn(jobsDir).filter((name) => name.includes('.')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a break whose move aside is slow cannot take the lock a second launcher made in the meantime: one holder', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    const lock = join(jobsDir, '.locks', sha256Hex(repo))
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner'), 'dead-1\n')
    const probe = probeOf({ 'dead-1': 'finished' })
    let secondDone
    const second = new Promise((resolve) => (secondDone = resolve))
    let firstAtAside
    const atAside = new Promise((resolve) => (firstAtAside = resolve))
    const slowAside = {
      ...engine,
      process: {
        ...engine.process,
        run: async (argv, init) => {
          if (argv[2].startsWith('# orq:lock aside')) {
            firstAtAside()
            await Promise.race([second, sleep(1000)])
          }
          return engine.process.run(argv, init)
        },
      },
    }
    const first = claimCheckout(slowAside, jobsDir, 'job-first', repo, probe)
    await atAside
    const results = await Promise.all([first, claimCheckout(engine, jobsDir, 'job-second', repo, probe).finally(secondDone)])
    const held = results.filter((r) => r.kind === 'held')
    assert.equal(held.length, 1, JSON.stringify(results))
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8').trim(), held[0].held.owner)
    assert.deepEqual(locksIn(jobsDir).filter((name) => name.includes('.')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a mutex of two minutes is stepped over and left in place, and one of 45 s that never frees makes the claim busy', async () => {
  const { root, engine, jobsDir } = scratch()
  try {
    const repo = checkoutWithSubdirectory(root)
    assert.equal((await claimCheckout(engine, jobsDir, 'job-a', repo, probeOf({}))).kind, 'held')
    const lock = join(jobsDir, '.locks', sha256Hex(repo))
    mkdirSync(`${lock}.mutex`)
    backdate(`${lock}.mutex`, 120)
    assert.equal((await claimCheckout(engine, jobsDir, 'job-b', repo, probeOf({ 'job-a': 'finished' }))).kind, 'held')
    assert.equal(existsSync(`${lock}.mutex`), true)
    backdate(`${lock}.mutex`, 45)
    assert.deepEqual(await claimCheckout(engine, jobsDir, 'job-c', repo, probeOf({ 'job-b': 'finished' })), { kind: 'busy', owner: null })
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'job-b\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a checkout path with spaces, quotes and shell syntax is locked as written and runs nothing', async () => {
  const { root, engine, jobsDir } = scratch()
  const stray = join(process.cwd(), 'orq-lock-injected')
  try {
    const repo = join(root, `it's a "quoted" $(touch orq-lock-injected) \`touch orq-lock-injected\` ;touch orq-lock-injected`)
    mkdirSync(join(repo, '.git'), { recursive: true })
    const claim = await claimCheckout(engine, jobsDir, 'job-a', repo, probeOf({}))
    assert.equal(claim.kind, 'held')
    assert.equal(readFileSync(join(jobsDir, '.locks', sha256Hex(repo), 'key'), 'utf8'), `${repo}\n`)
    assert.deepEqual(await claimCheckout(engine, jobsDir, 'job-b', repo, probeOf({})), { kind: 'busy', owner: 'job-a' })
    assert.equal(existsSync(stray), false)
  } finally {
    rmSync(stray, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
