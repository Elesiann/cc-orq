import type { CoreEngine } from './engine.ts'
import { isSafeJobId, shellWord } from './types.ts'

/**
 * The lock that keeps two shared launches out of one checkout, across the mod and the MCP server. It is a
 * directory, JOBS_DIR/.locks/NAME, where NAME is the sha256 of the checkout's real path. `mkdir` makes it
 * atomically, and the launch's job id goes into `owner` inside it. A job never gives its lock back when it
 * ends: the next launch finds the owner gone and breaks the lock.
 *
 * Breaking a lock and giving one back are the only ways a lock directory goes away, and both run under a
 * second directory, NAME.mutex, which `mkdir` makes the same way. Under it the owner is read again, so a lock
 * that someone else broke and took in the meantime is never removed, and the lock moves aside to a name of its
 * own in one rename. A claim needs no mutex: `mkdir` fails while a lock exists.
 */
type LockEngine = Pick<CoreEngine, 'clock' | 'fs' | 'process'>

/** The checkout a shared launch writes into: the top level of its git checkout, else the directory itself. */
export type Checkout = { key: string; repository: boolean }

/** `unstarted` is a job with no exit file and no supervisor pid yet, which is how a launch in progress looks. */
export type OwnerState = 'finished' | 'running' | 'gone' | 'unstarted'

/** The state of a lock's owner, asked of whoever knows where jobs live. */
export type OwnerProbe = (owner: string) => Promise<OwnerState>

/** What a launcher finds in a lock it did not make. `ageMs` counts from the lock's last change. */
export type LockFacts = { owner: null; ageMs: number } | { owner: string; ageMs: number; state: OwnerState }

export type LockVerdict = { kind: 'busy'; owner: string | null } | { kind: 'dead' }

/** The supervisor takes up to 5 s to write its pid, so a launch younger than this may still be starting. */
export const LAUNCH_GRACE_MS = 10_000

/** The mutex guards a few milliseconds of work, so one this old belongs to a launcher that died holding it. */
export const MUTEX_STALE_MS = 30_000

export function judgeLock(facts: LockFacts): LockVerdict {
  if (facts.owner === null) return facts.ageMs < LAUNCH_GRACE_MS ? { kind: 'busy', owner: null } : { kind: 'dead' }
  switch (facts.state) {
    case 'running':
      return { kind: 'busy', owner: facts.owner }
    case 'unstarted':
      return facts.ageMs < LAUNCH_GRACE_MS ? { kind: 'busy', owner: facts.owner } : { kind: 'dead' }
    case 'finished':
    case 'gone':
      return { kind: 'dead' }
  }
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

const SHA256_START = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]

function utf8Bytes(text: string): number[] {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return bytes
}

/** The mod's typecheck has no Node or DOM types, so there is no crypto to call; tests compare this with node:crypto. */
export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text)
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (const word of [Math.floor(bitLength / 2 ** 32), bitLength >>> 0]) {
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((word >>> shift) & 0xff)
  }
  const view = new DataView(Uint8Array.from(bytes).buffer)
  const state = Uint32Array.from(SHA256_START)
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let block = 0; block < bytes.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0
      const w2 = w[i - 2] ?? 0
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = (w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = state
    for (let i = 0; i < 64; i += 1) {
      const t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (SHA256_K[i] ?? 0) + (w[i] ?? 0)
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    const next = [a, b, c, d, e, f, g, h]
    for (let i = 0; i < 8; i += 1) state[i] = (state[i] ?? 0) + (next[i] ?? 0)
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('')
}

type LockPaths = { locks: string; dir: string }

/** A lock a launch holds: give it back with `releaseLock` when the launch fails. */
export type HeldLock = { paths: LockPaths; owner: string }

export type Claim =
  | { kind: 'held'; held: HeldLock; checkout: Checkout }
  /** `owner` is the job that holds the lock, or null while its launcher has not written its id yet. */
  | { kind: 'busy'; owner: string | null }
  | { kind: 'failed'; detail: string }

const SCRIPT_TIMEOUT_MS = 15000
const MUTEX_GENERATIONS = 4
const EXIT_TAKEN = 0
const EXIT_HELD = 1
const EXIT_LOST = 3

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

async function exitCodeOf($: LockEngine, script: string): Promise<number> {
  return (await $.process.run(['bash', '-c', script], { timeoutMs: SCRIPT_TIMEOUT_MS })).exitCode
}

const quoted = shellWord

function claimScript({ locks, dir }: LockPaths, owner: string, key: string): string {
  return (
    `# orq:lock claim\n` +
    `mkdir -p ${quoted(locks)} || exit 8\n` +
    `mkdir ${quoted(dir)} 2>/dev/null || { [ -d ${quoted(dir)} ] && exit ${EXIT_HELD}; exit 9; }\n` +
    `( set -C; printf '%s\\n' ${quoted(owner)} > ${quoted(`${dir}/owner`)} ) 2>/dev/null || exit ${EXIT_LOST}\n` +
    `printf '%s\\n' ${quoted(key)} > ${quoted(`${dir}/key`)} 2>/dev/null\n` +
    `exit 0`
  )
}

function mutexScript(mutex: string): string {
  return (
    `# orq:lock mutex\n` +
    `i=0\n` +
    `while [ "$i" -lt 100 ]; do\n` +
    `  mkdir ${quoted(mutex)} 2>/dev/null && exit ${EXIT_TAKEN}\n` +
    `  [ -d ${quoted(mutex)} ] || exit 9\n` +
    `  sleep 0.02\n` +
    `  i=$((i + 1))\n` +
    `done\n` +
    `exit ${EXIT_HELD}`
  )
}

function unmutexScript(mutex: string): string {
  return `# orq:lock unmutex\nrmdir ${quoted(mutex)} 2>/dev/null\nexit 0`
}

/** One rename, so a lock is gone or whole, never half removed; `$$` keeps the tombstone's name unique. */
function asideScript(dir: string, tombstone: string): string {
  return (
    `# orq:lock aside\n` +
    `mv ${quoted(dir)} ${quoted(tombstone)}.$$ 2>/dev/null || exit 1\n` +
    `rm -rf ${quoted(tombstone)}.$$ 2>/dev/null\n` +
    `exit 0`
  )
}

async function realPathOf($: LockEngine, path: string): Promise<string> {
  const stat = await orNull(() => $.fs.stat(path, { resolve: true }))
  // A host hook may withhold realPath, and a path that does not resolve has none: the path as given keys the lock.
  return stat?.realPath ?? (path.replace(/\/+$/, '') || '/')
}

/** The nearest ancestor of the real `cwd` that holds a `.git`, directory or file, else the real `cwd` itself. */
export async function checkoutOf($: LockEngine, cwd: string): Promise<Checkout> {
  const real = await realPathOf($, cwd)
  let dir = real
  for (;;) {
    if ((await orNull(() => $.fs.exists(`${dir === '/' ? '' : dir}/.git`))) === true) return { key: dir, repository: true }
    const cut = dir.lastIndexOf('/')
    if (cut < 0 || dir === '/') return { key: real, repository: false }
    dir = cut === 0 ? '/' : dir.slice(0, cut)
  }
}

function lockPathsFor(jobsDir: string, checkout: Checkout): LockPaths {
  const locks = `${jobsDir}/.locks`
  return { locks, dir: `${locks}/${sha256Hex(checkout.key)}` }
}

/** What a lock holds now, or null when it is gone. A lock whose owner file cannot be read counts as made a moment ago. */
async function inspect($: LockEngine, { dir }: LockPaths, ownerState: OwnerProbe): Promise<LockFacts | null> {
  const ownerText = await orNull(() => $.fs.read(`${dir}/owner`))
  const stat = await orNull(() => $.fs.stat(dir))
  if (stat === null && (await orNull(() => $.fs.exists(dir))) !== true) return null
  if (ownerText === null && (await orNull(() => $.fs.exists(`${dir}/owner`))) === true) return { owner: null, ageMs: 0 }
  const ageMs = stat === null ? 0 : Math.max(0, (await $.clock.now()) - stat.mtimeMs)
  const owner = (ownerText ?? '').trim()
  // An owner file that holds anything but a job id counts as no owner, so what it holds is never run or shown.
  return isSafeJobId(owner) ? { owner, ageMs, state: await ownerState(owner) } : { owner: null, ageMs }
}

async function isStale($: LockEngine, mutex: string): Promise<boolean> {
  const stat = await orNull(() => $.fs.stat(mutex))
  return stat !== null && (await $.clock.now()) - stat.mtimeMs >= MUTEX_STALE_MS
}

/**
 * Runs `hold` with the lock's mutex, or answers 'contended' when it cannot be had. A stale mutex is stepped
 * over to the next name, never removed: removing it would let a second launcher that also found it stale take
 * down the mutex the first one has just made.
 */
async function withMutex<T>($: LockEngine, { dir }: LockPaths, hold: () => Promise<T>): Promise<T | 'contended'> {
  for (let generation = 0; generation < MUTEX_GENERATIONS; generation += 1) {
    const mutex = generation === 0 ? `${dir}.mutex` : `${dir}.mutex.${generation}`
    if (await isStale($, mutex)) continue
    const code = await exitCodeOf($, mutexScript(mutex))
    if (code === EXIT_TAKEN) {
      try {
        return await hold()
      } finally {
        await exitCodeOf($, unmutexScript(mutex)).catch(() => 0)
      }
    }
    if (code === EXIT_HELD && (await isStale($, mutex))) continue
    return 'contended'
  }
  return 'contended'
}

/** A lock leaves only when its owner is the one the caller meant, and, for a break, is still dead. */
type Eviction = { reason: 'dead'; owner: string | null } | { reason: 'release'; owner: string }

async function evict(
  $: LockEngine,
  paths: LockPaths,
  actor: string,
  eviction: Eviction,
  ownerState: OwnerProbe,
): Promise<'removed' | 'changed' | 'contended'> {
  return withMutex($, paths, async () => {
    const facts = await inspect($, paths, ownerState)
    if (facts === null || facts.owner !== eviction.owner) return 'changed'
    if (eviction.reason === 'dead' && judgeLock(facts).kind !== 'dead') return 'changed'
    await exitCodeOf($, asideScript(paths.dir, `${paths.dir}.dead.${actor}`))
    return 'removed'
  })
}

/**
 * Take the lock of the checkout that holds `cwd` for job `owner`, breaking the lock of a dead owner on the way.
 * It answers busy, with the owner's id, while a live job or a launch in progress holds it, and never throws.
 */
export async function claimCheckout(
  $: LockEngine,
  jobsDir: string,
  owner: string,
  cwd: string,
  ownerState: OwnerProbe,
): Promise<Claim> {
  try {
    const checkout = await checkoutOf($, cwd)
    const paths = lockPathsFor(jobsDir, checkout)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const code = await exitCodeOf($, claimScript(paths, owner, checkout.key))
      if (code === EXIT_TAKEN) return { kind: 'held', held: { paths, owner }, checkout }
      if (code !== EXIT_HELD && code !== EXIT_LOST) return { kind: 'failed', detail: `exit ${code}` }
      const facts = await inspect($, paths, ownerState)
      if (facts === null) continue
      const verdict = judgeLock(facts)
      if (verdict.kind === 'busy') return verdict
      // Past the first break, or with another launcher in the mutex, someone else is taking this lock right now.
      if (attempt === 1) return { kind: 'busy', owner: null }
      const evicted = await evict($, paths, owner, { reason: 'dead', owner: facts.owner }, ownerState)
      if (evicted === 'contended') return { kind: 'busy', owner: null }
    }
    return { kind: 'busy', owner: null }
  } catch (err) {
    return { kind: 'failed', detail: String(err) }
  }
}

/** Give back a lock a failed launch holds, unless someone else has broken it and taken it since. Never throws. */
export async function releaseLock($: LockEngine, held: HeldLock, ownerState: OwnerProbe): Promise<void> {
  try {
    await evict($, held.paths, held.owner, { reason: 'release', owner: held.owner }, ownerState)
  } catch {
    // Left in place, the lock belongs to a job with an exit file, and the next launch breaks it.
  }
}
