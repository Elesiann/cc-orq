// What the task tests share: the orq server started the way Claude Code starts it and spoken to over stdio, scenes
// with a temporary home and jobs directory, synthetic job directories, fake workers, and the checks that every answer
// of a tasks/* method or of a task-creating tools/call must pass. The ext-tasks schemas are necessary and lax, so
// `strictTask` adds what they leave out.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CancelTaskResultV2Schema,
  CreateTaskResultV2Schema,
  ErrorV2Schema,
  GetTaskResultV2Schema,
  UpdateTaskResultV2Schema,
} from '@modelcontextprotocol/ext-tasks/core/v2'
import { specTypeSchemas } from '@modelcontextprotocol/server'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const MAIN = join(REPO, 'server', 'main.mjs')
export const TASKS = 'io.modelcontextprotocol/tasks'
export const SESSION_ID = 'sess-0123456789'
export const SECOND = 1_700_000_000
export const STARTED = SECOND * 1000
const REQUEST_MS = 20000
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const AUTHOR = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'orq test',
  GIT_AUTHOR_EMAIL: 'orq@example.invalid',
  GIT_COMMITTER_NAME: 'orq test',
  GIT_COMMITTER_EMAIL: 'orq@example.invalid',
}

export function conforms(schema, value, what) {
  const parsed = schema.safeParse(value)
  assert.ok(parsed.success, `${what} does not match its schema: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}\n${JSON.stringify(value)}`)
}

/** What the published spec and the conformance suite ask of a task and that the ext-tasks schemas do not check. */
export function strictTask(task, what) {
  const text = JSON.stringify(task)
  assert.match(task.taskId, /^[\x21-\x7e]{1,128}$/, `${what}: taskId is at most 128 printable ASCII characters, no spaces`)
  for (const field of ['createdAt', 'lastUpdatedAt']) assert.match(task[field], ISO, `${what}: ${field} is an ISO time`)
  assert.equal(task.ttlMs, null, `${what}: ttlMs is null, since no job is deleted`)
  assert.ok(Number.isInteger(task.pollIntervalMs) && task.pollIntervalMs >= 250 && task.pollIntervalMs <= 30000, `${what}: pollIntervalMs is in 250..30000`)
  for (const absent of ['ttl', 'pollInterval', 'requestState', 'task']) assert.equal(absent in task, false, `${what}: no ${absent}`)
  assert.equal(text.includes('io.modelcontextprotocol/related-task'), false, `${what}: the related-task key of 2025-11-25 is not on the wire`)
  if (task.resultType === 'task') {
    assert.equal(task.status, 'working', `${what}: a task is created working`)
    for (const absent of ['result', 'error', 'inputRequests']) assert.equal(absent in task, false, `${what}: a creation answer has no ${absent}`)
    return
  }
  assert.equal(task.resultType, 'complete', `${what}: resultType`)
  assert.ok(typeof task.statusMessage === 'string' && task.statusMessage !== '', `${what}: a statusMessage on every tasks/get, or Claude Code clears it`)
  if (task.status === 'input_required') {
    const keys = Object.keys(task.inputRequests)
    assert.ok(keys.length >= 1 && keys.length <= 16, `${what}: one to sixteen input requests`)
    for (const key of keys) {
      const request = task.inputRequests[key]
      assert.equal(request.method, 'elicitation/create')
      assert.equal(request.params.mode, 'form')
      assert.equal(request.params.requestedSchema.type, 'object')
      for (const field of Object.values(request.params.requestedSchema.properties)) {
        assert.ok(['string', 'number', 'integer', 'boolean'].includes(field.type), `${what}: the form is flat: ${JSON.stringify(field)}`)
      }
    }
  } else {
    assert.equal('inputRequests' in task, false, `${what}: only an input_required task has inputRequests`)
  }
  if (task.status === 'completed') {
    assert.ok(task.result.content.length >= 1 && task.result.content.every((block) => block.type === 'text'), `${what}: the result has text content`)
    assert.equal(typeof task.result.isError, 'boolean', `${what}: isError is always set`)
  } else {
    assert.equal('result' in task, false, `${what}: only a completed task has a result`)
  }
  if (task.status === 'failed') assert.ok(Number.isInteger(task.error.code) && typeof task.error.message === 'string')
}

const RESULT_SCHEMA = {
  'server/discover': specTypeSchemas.DiscoverResult,
  initialize: specTypeSchemas.InitializeResult,
  'tools/list': specTypeSchemas.ListToolsResult,
}

function checkResult(method, result) {
  if (method === 'tools/call') {
    if (result.resultType === 'task') {
      conforms(CreateTaskResultV2Schema, result, 'the creation answer')
      strictTask(result, 'the creation answer')
    } else {
      conforms(specTypeSchemas.CallToolResult, result, 'the result of tools/call')
    }
  } else if (method === 'tasks/get') {
    conforms(GetTaskResultV2Schema, result, 'the result of tasks/get')
    strictTask(result, 'tasks/get')
  } else if (method === 'tasks/update' || method === 'tasks/cancel') {
    conforms(method === 'tasks/update' ? UpdateTaskResultV2Schema : CancelTaskResultV2Schema, result, `the ack of ${method}`)
    for (const field of ['taskId', 'status', 'result', 'error', 'inputRequests']) assert.equal(field in result, false, `the ack of ${method} has no ${field}`)
    assert.equal(result.resultType, 'complete')
  } else if (RESULT_SCHEMA[method] !== undefined) {
    conforms(RESULT_SCHEMA[method], result, `the result of ${method}`)
  }
}

export const modern = (capabilities = { extensions: { [TASKS]: {} } }) => ({
  _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'server-tasks-test', version: '0' },
    'io.modelcontextprotocol/clientCapabilities': capabilities,
  },
})

export const WITH_FORMS = { extensions: { [TASKS]: {} }, elicitation: { form: {}, url: {} } }
export const NO_TASKS = {}

export function startServer({ env }) {
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const messages = []
  const frames = new Map()
  let stderr = ''
  let buffer = ''
  let nextId = 1
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end)
      const message = JSON.parse(line)
      buffer = buffer.slice(end + 1)
      messages.push(message)
      frames.set(message.id, line)
      const waiting = pending.get(message.id)
      if (waiting !== undefined) {
        pending.delete(message.id)
        waiting(message)
      }
    }
  })
  child.stdin.on('error', () => undefined)
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })))

  const request = (method, params) =>
    new Promise((done, fail) => {
      const id = nextId++
      const timer = setTimeout(() => fail(new Error(`no answer to ${method} within ${REQUEST_MS} ms; stderr: ${stderr}`)), REQUEST_MS)
      pending.set(id, (message) => {
        clearTimeout(timer)
        conforms(specTypeSchemas.JSONRPCMessage, message, `the answer to ${method}`)
        if (message.result !== undefined) checkResult(method, message.result)
        if (message.error !== undefined) {
          conforms(specTypeSchemas.JSONRPCErrorResponse, message, `the error to ${method}`)
          conforms(ErrorV2Schema, message.error, `the error object to ${method}`)
        }
        done(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  return {
    child,
    messages,
    stderr: () => stderr,
    request,
    /** tasks/get with the extension; answers the task. */
    async get(taskId, capabilities) {
      const answer = await request('tasks/get', { taskId, ...modern(capabilities) })
      assert.equal(answer.error, undefined, `tasks/get ${taskId}: ${JSON.stringify(answer.error)}`)
      return answer.result
    },
    async update(taskId, inputResponses, capabilities) {
      return request('tasks/update', { taskId, inputResponses, ...modern(capabilities) })
    },
    async cancel(taskId, capabilities) {
      return request('tasks/cancel', { taskId, ...modern(capabilities) })
    },
    /** tools/call with a modern envelope. A task comes back as `task`; any other answer as its text block. */
    async call(name, args = {}, capabilities, extraMeta = {}) {
      const envelope = modern(capabilities)
      const answer = await request('tools/call', { name, arguments: args, _meta: { ...envelope._meta, ...extraMeta } })
      assert.equal(answer.error, undefined, `tools/call ${name} answered a JSON-RPC error: ${JSON.stringify(answer.error)}`)
      const { result } = answer
      const frame = frames.get(answer.id)
      if (result.resultType === 'task') return { result, task: result, isError: false, frame }
      assert.equal(result.content.length, 1, 'a tool answers one content block')
      const { text } = result.content[0]
      let json
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
      return { result, isError: result.isError === true, text, json, frame }
    },
    async close() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      const ended = await exited
      clearTimeout(timer)
      return ended
    },
  }
}

/** One temporary home with the config the server reads, a jobs directory, and a bin directory ahead of a system PATH. */
export function scene({ instances = [{ id: 'claudeAgent', driver: 'claudeAgent' }], bin = {}, config = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orq-tasks-')))
  const home = join(root, 'home')
  const jobsDir = join(root, 'jobs')
  const binDir = join(root, 'bin')
  mkdirSync(join(home, '.config', 'orq'), { recursive: true })
  mkdirSync(jobsDir)
  mkdirSync(binDir)
  for (const [name, body] of Object.entries(bin)) {
    writeFileSync(join(binDir, name), body)
    chmodSync(join(binDir, name), 0o755)
  }
  const setConfig = (extra = {}) =>
    writeFileSync(join(home, '.config', 'orq', 'config.json'), JSON.stringify({ jobsDir, instances, ...config, ...extra }))
  setConfig()
  const env = { ...process.env, ...AUTHOR, HOME: home, PATH: `${binDir}:/usr/bin:/bin` }
  delete env.CLAUDE_PLUGIN_ROOT
  delete env.CLAUDE_PROJECT_DIR
  delete env.CLAUDE_CODE_SESSION_ID
  const live = []
  const servers = []
  return {
    root,
    home,
    jobsDir,
    env,
    setConfig,
    start(extraEnv = {}) {
      const server = startServer({ env: { ...env, ...extraEnv } })
      servers.push(server)
      return server
    },
    /** A server started inside a session directory, with the session id that Claude Code gives it. */
    startIn(session, extraEnv = {}) {
      return this.start({ CLAUDE_PROJECT_DIR: session, CLAUDE_CODE_SESSION_ID: SESSION_ID, ...extraEnv })
    },
    /** A process group that stays alive, as a running supervisor's does; its pid is the pgid. */
    liveGroup() {
      const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
      child.unref()
      live.push(child.pid)
      return child.pid
    },
    /** The pid of a process group that no longer exists. */
    async deadGroup() {
      const child = spawn('true', [], { detached: true, stdio: 'ignore' })
      await new Promise((done) => child.on('exit', done))
      return child.pid
    },
    async cleanup() {
      await Promise.all(servers.map((server) => server.close()))
      for (const pid of live) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** A job directory as the engine leaves it. `files` maps a file name to its text; an `exit` file gets `exitAt` as its mtime. */
export function job(jobsDir, id, { startedAt = STARTED, meta = {}, files = {}, exitAt } = {}) {
  const dir = join(jobsDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      id,
      kind: 'manual',
      agentId: 'manual',
      cwd: '/work',
      startedAt,
      startedAtIso: new Date(startedAt).toISOString(),
      model: 'fixture-model',
      instanceId: 'codex',
      ...meta,
    }),
  )
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  if (exitAt !== undefined) utimesSync(join(dir, 'exit'), exitAt, exitAt)
  return dir
}

export function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...AUTHOR } })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** A session directory that holds one git checkout with one commit. */
export function checkout(s) {
  const session = join(s.root, 'session')
  const repo = join(session, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(repo, ['add', 'shared.txt'])
  git(repo, ['commit', '-q', '-m', 'base'])
  return { session, repo }
}

/** The worker commits `<worktree name>.txt` in its own worktree, then answers as the Claude CLI does. */
export const FAKE_WORKER = [
  '#!/bin/bash',
  'f="$(basename "$PWD").txt"',
  'printf "worker output\\n" > "$f"',
  'git add "$f"',
  'git -c user.name=orq-test -c user.email=orq-test@example.invalid -c commit.gpgsign=false commit -q -m "worker commit in $PWD"',
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"ses-fake"}'`,
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"ses-fake","result":"FAKE-WORKER","usage":{"input_tokens":3,"output_tokens":2},"modelUsage":{"fake-model":{}}}'`,
  'exit 0',
  '',
].join('\n')

/** The same worker with its argv kept, held until the test creates `go` in the job directory. */
export const FAKE_HELD_WORKER = FAKE_WORKER.replace(
  '#!/bin/bash\n',
  '#!/bin/bash\nprintf "%s\\n" "$@" > "$ORQ_JOB_DIR/argv.txt"\nfor _ in $(seq 1 300); do [ -e "$ORQ_JOB_DIR/go" ] && break; sleep 0.1; done\n',
)

export const jobDirs = (s) => (existsSync(s.jobsDir) ? readdirSync(s.jobsDir).filter((name) => !name.startsWith('.')) : [])

/** Polls tasks/get until the task is in none of the given statuses. */
export async function until(server, taskId, notIn = ['working']) {
  const stopAt = Date.now() + 30000
  for (;;) {
    const task = await server.get(taskId)
    if (!notIn.includes(task.status)) return task
    assert.ok(Date.now() < stopAt, `${taskId} is still ${task.status}`)
    await new Promise((done) => setTimeout(done, 200))
  }
}
