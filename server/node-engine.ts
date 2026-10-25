// The CoreEngine part of $, in plain Node, for the MCP server and the tests. Each member keeps the host
// semantics that the generated d.ts documents.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

import type { CoreEngine } from '../hooks/engine.ts'

type Env = Record<string, string | undefined>
type RunInit = Parameters<CoreEngine['process']['run']>[1]
type RunResult = Awaited<ReturnType<CoreEngine['process']['run']>>
type Stat = Awaited<ReturnType<CoreEngine['fs']['stat']>>
type StatOptions = Parameters<CoreEngine['fs']['stat']>[1]
type Entry = Awaited<ReturnType<CoreEngine['fs']['list']>>[number]
type Kind = Stat['kind']

export type NodeEngineOptions = {
  /** The base environment; a copy of process.env when absent. */
  env?: Env
  /** The shim's working directory; process.cwd() when absent. */
  cwd?: string
  /** plugin.root. Defaults to the base environment's CLAUDE_PLUGIN_ROOT when set, otherwise the repository root. */
  pluginRoot?: string
}

const READ_LIMIT_BYTES = 4 * 1024 * 1024
const STREAM_LIMIT_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function nodeEngine(options: NodeEngineOptions = {}): CoreEngine {
  const base: Env = { ...(options.env ?? process.env) }
  const cwd = resolve(options.cwd ?? process.cwd())
  const pluginRoot = options.pluginRoot ?? (base.CLAUDE_PLUGIN_ROOT || REPO_ROOT)
  const at = (path: string): string => resolve(cwd, path)
  return {
    clock: { now: async () => Date.now() },
    env: { get: async (name) => base[name] },
    fs: {
      read: async (path) => readText(at(path)),
      write: (path, text) => writeText(at(path), text),
      list: async (path) => listDir(at(path ?? '.')),
      exists: (path) => fsp.stat(at(path)).then(() => true, () => false),
      stat: (path, statOptions) => statOf(at(path), statOptions),
    },
    plugin: { root: pluginRoot },
    process: { run: (argv, init) => runChild(argv, init, cwd, base) },
    ui: {
      // stdout carries the MCP stdio channel, so a log line never goes there.
      log: (text) => {
        process.stderr.write(`${text}\n`)
      },
    },
  }
}

async function readText(path: string): Promise<string> {
  const { size } = await fsp.stat(path)
  if (size > READ_LIMIT_BYTES) throw new Error(`${path} is larger than 4 MiB, so fs.read refuses it`)
  return fsp.readFile(path, 'utf8')
}

async function writeText(path: string, text: string): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fsp.writeFile(temp, text, 'utf8')
    await fsp.rename(temp, path)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function listDir(path: string): Promise<Entry[]> {
  const dirents = await fsp.readdir(path, { withFileTypes: true })
  const entries = await Promise.all(dirents.map((dirent) => entryOf(join(path, dirent.name), dirent)))
  return entries.filter((entry) => entry !== undefined)
}

async function entryOf(path: string, dirent: Dirent): Promise<Entry | undefined> {
  const { name } = dirent
  if (dirent.isSymbolicLink()) return { name, kind: 'other', size: 0, mtimeMs: 0, isLink: true }
  if (dirent.isDirectory()) return { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
  if (!dirent.isFile()) return { name, kind: 'other', size: 0, mtimeMs: 0, isLink: false }
  const info = await fsp.lstat(path).catch(() => undefined)
  if (info === undefined) return undefined
  return { name, kind: 'file', size: info.size, mtimeMs: info.mtimeMs, isLink: false }
}

async function statOf(path: string, options: StatOptions): Promise<Stat> {
  const link = await fsp.lstat(path)
  const target = await fsp.stat(path).catch(() => undefined) // undefined when stat fails, which for a link means it leads nowhere
  const info = target ?? link
  const stat: Stat = {
    kind: target === undefined ? 'other' : kindOf(target),
    size: info.size,
    mtimeMs: info.mtimeMs,
    isLink: link.isSymbolicLink(),
  }
  if (options?.resolve === true) {
    const realPath = await fsp.realpath(path).catch(() => undefined)
    if (realPath !== undefined) return { ...stat, realPath }
  }
  return stat
}

function kindOf(info: Stats): Kind {
  if (info.isDirectory()) return 'dir'
  return info.isFile() ? 'file' : 'other'
}

async function runChild(argv: readonly string[], init: RunInit, cwd: string, base: Env): Promise<RunResult> {
  const [file, ...args] = argv
  if (file === undefined) throw new Error('process.run needs argv[0], the command to run')
  const timeoutMs = Math.min(init?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  if (!(timeoutMs > 0)) throw new RangeError(`process.run timeoutMs must be above 0, got ${init?.timeoutMs}`)

  const env = withoutGitHooks(file, childEnv(base, init?.env))
  // detached makes the child a process group leader, so a timeout can kill its grandchildren too.
  const child = spawn(file, args, { cwd: resolve(cwd, init?.cwd ?? '.'), env, stdio: 'pipe', detached: true })
  const out = capture(child.stdout)
  const err = capture(child.stderr)
  // A child that exits before reading its stdin is not a failed run, so its EPIPE is ignored.
  child.stdin.on('error', () => undefined)
  child.stdin.end(init?.stdin ?? '')

  return new Promise<RunResult>((done, fail) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // The group is already gone.
        }
      }
      child.stdout.destroy()
      child.stderr.destroy()
      fail(new Error(`${file} did not finish within ${timeoutMs} ms, so it was killed`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      fail(error)
    })
    // close fires after the exit and after both pipes close, so all output is captured.
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const o = out.done()
      const e = err.done()
      done({ exitCode: code ?? 1, stdout: o.text, stderr: e.text, isStdoutTruncated: o.truncated, isStderrTruncated: e.truncated })
    })
  })
}

function childEnv(base: Env, extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...extra }
}

// Git runs with repository hooks off, as the host runs it, through git's GIT_CONFIG_COUNT pairs.
function withoutGitHooks(file: string, env: Record<string, string>): Record<string, string> {
  if (basename(file) !== 'git') return env
  const raw = env.GIT_CONFIG_COUNT ?? '0'
  const n = /^\d+$/.test(raw) ? Number(raw) : 0
  return {
    ...env,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${n}`]: '/dev/null',
  }
}

// Keeps the first `STREAM_LIMIT_BYTES` of a stream as text and reads, then drops, the rest. After a cut,
// the decoder holds an unfinished character and is never ended, so that character is dropped.
function capture(stream: Readable): { done(): { text: string; truncated: boolean } } {
  const decoder = new StringDecoder('utf8')
  let text = ''
  let room = STREAM_LIMIT_BYTES
  let truncated = false
  stream.on('data', (chunk: Buffer) => {
    if (chunk.length <= room) {
      room -= chunk.length
      text += decoder.write(chunk)
      return
    }
    truncated = true
    text += decoder.write(chunk.subarray(0, room))
    room = 0
  })
  return { done: () => ({ text: truncated ? text : text + decoder.end(), truncated }) }
}
