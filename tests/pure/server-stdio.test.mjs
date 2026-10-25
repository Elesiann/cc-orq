// The orq MCP server, started the way Claude Code starts it (`node server/main.mjs`) and spoken to in JSON-RPC over
// stdio. Every message it sends is checked against the schemas that the SDK and @modelcontextprotocol/ext-tasks
// export. Jobs are synthetic job directories, a live process group, or a worktree job that a fake worker commits in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ErrorV2Schema, GetTaskRequestV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2'
import { SUPPORTED_PROTOCOL_VERSIONS, specTypeSchemas } from '@modelcontextprotocol/server'

import { defaultConfig } from '../../hooks/config.ts'
import { INTEGRATE_INPUT_SCHEMA } from '../../hooks/contract.ts'
import { launchTaskFromHeader } from '../../hooks/engine.ts'
import { parseTaskHeader } from '../../hooks/task-header.ts'
import { parentRuntimeModeFromPermissionMode } from '../../hooks/target.ts'
import { nodeEngine } from '../../server/node-engine.ts'
import { clientInfoOf } from '../../server/protocol.ts'
import { nodeVersionRefusal } from '../../server/node-version.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAIN = join(REPO, 'server', 'main.mjs')
const TASKS = 'io.modelcontextprotocol/tasks'
const REQUEST_MS = 20000
const AUTHOR = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'orq test',
  GIT_AUTHOR_EMAIL: 'orq@example.invalid',
  GIT_COMMITTER_NAME: 'orq test',
  GIT_COMMITTER_EMAIL: 'orq@example.invalid',
}

// ---------------------------------------------------------------------------------------------------------------------
// The schemas every message is held to.

function conforms(schema, value, what) {
  const parsed = schema.safeParse(value)
  assert.ok(parsed.success, `${what} does not match its schema: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}\n${JSON.stringify(value)}`)
}

const RESULT_SCHEMA = {
  'server/discover': specTypeSchemas.DiscoverResult,
  initialize: specTypeSchemas.InitializeResult,
  'tools/list': specTypeSchemas.ListToolsResult,
  'tools/call': specTypeSchemas.CallToolResult,
}

// ---------------------------------------------------------------------------------------------------------------------
// A server process and a JSON-RPC client for it.

const modern = (capabilities = { extensions: { [TASKS]: {} } }) => ({
  _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'server-stdio-test', version: '0' },
    'io.modelcontextprotocol/clientCapabilities': capabilities,
  },
})

function startServer({ env, args = [MAIN] }) {
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const messages = []
  const garbage = []
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
      buffer = buffer.slice(end + 1)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        garbage.push(line)
        continue
      }
      messages.push(message)
      const waiting = pending.get(message.id)
      if (waiting !== undefined) {
        pending.delete(message.id)
        waiting(message)
      }
    }
  })
  child.stdin.on('error', () => undefined)
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })))

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const request = (method, params) =>
    new Promise((done, fail) => {
      const id = nextId++
      const timer = setTimeout(() => fail(new Error(`no answer to ${method} within ${REQUEST_MS} ms; stderr: ${stderr}`)), REQUEST_MS)
      pending.set(id, (message) => {
        clearTimeout(timer)
        conforms(specTypeSchemas.JSONRPCMessage, message, `the answer to ${method}`)
        const schema = RESULT_SCHEMA[method]
        if (schema !== undefined && message.result !== undefined) conforms(schema, message.result, `the result of ${method}`)
        if (message.error !== undefined) {
          conforms(specTypeSchemas.JSONRPCErrorResponse, message, `the error to ${method}`)
          conforms(ErrorV2Schema, message.error, `the error object to ${method}`)
        }
        done(message)
      })
      send({ jsonrpc: '2.0', id, method, params })
    })

  const server = {
    child,
    messages,
    garbage,
    stderr: () => stderr,
    exited,
    request,
    send,
    /** tools/call with a modern envelope; answers the CallToolResult and its text, parsed as JSON when it is JSON. */
    async call(name, args = {}, capabilities) {
      const answer = await request('tools/call', { name, arguments: args, ...modern(capabilities) })
      assert.equal(answer.error, undefined, `tools/call ${name} answered a JSON-RPC error: ${JSON.stringify(answer.error)}`)
      const result = answer.result
      assert.equal(result.content.length, 1, 'a tool answers one content block')
      assert.equal(result.content[0].type, 'text')
      const text = result.content[0].text
      let json
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
      return { result, isError: result.isError === true, text, json }
    },
    async close() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      const ended = await exited
      clearTimeout(timer)
      return ended
    },
  }
  return server
}

/** One temporary home with the config the server reads, a jobs directory, and a bin directory ahead of a system PATH. */
function scene({ instances = [{ id: 'claudeAgent', driver: 'claudeAgent' }], bin = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orq-server-')))
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
    writeFileSync(join(home, '.config', 'orq', 'config.json'), JSON.stringify({ jobsDir, instances, ...extra }))
  setConfig()
  // The system directories only, so a provider CLI installed on this machine is never probed or run.
  const env = { ...process.env, ...AUTHOR, HOME: home, PATH: `${binDir}:/usr/bin:/bin` }
  delete env.CLAUDE_PLUGIN_ROOT
  delete env.CLAUDE_PROJECT_DIR
  delete env.CLAUDE_CODE_SESSION_ID
  const live = []
  return {
    root,
    home,
    jobsDir,
    env,
    setConfig,
    start: (extraEnv = {}) => startServer({ env: { ...env, ...extraEnv } }),
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
    cleanup() {
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

const SECOND = 1_700_000_000
const STARTED = SECOND * 1000

/** A job directory as the engine leaves it. `files` maps a file name to its text; an `exit` file gets `exitAt` as its mtime. */
function job(jobsDir, id, { startedAt = STARTED, meta = {}, files = {}, exitAt } = {}) {
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

const iso = (seconds) => new Date(seconds * 1000).toISOString()
const FAILURE = (code, message) => ({ error: { code, message } })

// ---------------------------------------------------------------------------------------------------------------------
// Negotiation: server/discover, the legacy initialize, and tools/list.

const INSTRUCTIONS = readFileSync(join(REPO, 'server', 'instructions.md'), 'utf8')
const TOOLS = ['capabilities', 'delegate', 'answer', 'status', 'list', 'cancel', 'integrate']

const LEGACY_INIT = {
  protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
  capabilities: {},
  clientInfo: { name: 'server-stdio-test', version: '0' },
}

test('the plugin manifest starts this server with node through the JavaScript entry', () => {
  const manifest = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'))
  const orq = manifest.mcpServers?.orq
  assert.equal(orq?.command, 'node')
  assert.equal(orq.args.length, 1)
  const entry = orq.args[0].replace('${CLAUDE_PLUGIN_ROOT}', REPO)
  assert.equal(entry, MAIN, 'the manifest must start server/main.mjs, which refuses an old Node with a reason')
  assert.ok(existsSync(entry))
})

test('server/discover answers the tools capability, the tasks extension and the instructions', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  const { result } = await server.request('server/discover', modern())
  assert.deepEqual(result.supportedVersions, ['2026-07-28'])
  assert.deepEqual(Object.keys(result.capabilities).sort(), ['extensions', 'tools'])
  assert.deepEqual(result.capabilities.extensions, { [TASKS]: {} })
  assert.equal(result.instructions, INSTRUCTIONS)
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'cc-orq')
})

test('the legacy initialize is served too, with the instructions, and its tools/list is the same', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  const { result } = await server.request('initialize', LEGACY_INIT)
  assert.equal(result.instructions, INSTRUCTIONS)
  assert.equal(result.serverInfo.name, 'cc-orq')
  assert.ok(result.capabilities.tools !== undefined)
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const legacy = await server.request('tools/list', {})
  const current = await server.request('tools/list', modern())
  assert.deepEqual(
    legacy.result.tools.map((tool) => tool.name),
    TOOLS,
  )
  assert.deepEqual(
    legacy.result.tools.map((tool) => tool.inputSchema),
    current.result.tools.map((tool) => tool.inputSchema),
  )
})

test('tools/list lists exactly the seven tools, with the input schemas of 0.1, the new list, the new delegate and the answer', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  const { result } = await server.request('tools/list', modern())
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    TOOLS,
  )
  const schemas = Object.fromEntries(result.tools.map((tool) => [tool.name, tool.inputSchema]))
  assert.deepEqual(schemas.capabilities, {
    type: 'object',
    properties: { sessionMode: { type: 'string', description: 'Filled by the cc-orq hook; leave it out.' } },
    additionalProperties: false,
  })
  assert.deepEqual(schemas.status, {
    type: 'object',
    properties: { taskId: { type: 'string' } },
    required: ['taskId'],
    additionalProperties: false,
  })
  assert.deepEqual(schemas.cancel, {
    type: 'object',
    properties: { taskId: { type: 'string' }, reason: { type: 'string', maxLength: 200 } },
    required: ['taskId'],
    additionalProperties: false,
  })
  assert.deepEqual(schemas.integrate, INTEGRATE_INPUT_SCHEMA)
  assert.deepEqual(schemas.answer, {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The taskId in the BLOCKED text of the job that asked the question.' },
      answer: { type: 'string', minLength: 1, maxLength: 20000, description: 'The answer, at most 20,000 characters. The worker gets it as its next message, in the session it already has.' },
      sessionMode: { type: 'string', description: 'Filled by the cc-orq hook; leave it out.' },
    },
    required: ['taskId', 'answer'],
    additionalProperties: false,
  })
  assert.equal(schemas.list.properties.limit.type, 'integer')
  assert.equal(schemas.list.properties.limit.minimum, 1)
  assert.equal(schemas.list.properties.limit.maximum, 50)
  assert.equal(schemas.list.required, undefined)
  for (const tool of result.tools) assert.ok(tool.description.length > 40, `${tool.name} has a description`)
  const described = Object.fromEntries(result.tools.map((tool) => [tool.name, tool.description]))
  assert.ok(described.integrate.includes('redelegate a rebase to the same worker, then integrate again'))
  assert.ok(described.integrate.includes('uncommitted work in the task worktree is not'))
  assert.ok(described.capabilities.includes('the lower of the config ceiling and the session permission mode'), 'the description says where the modes come from')
  assert.equal(described.capabilities.includes('do not follow the session yet'), false, 'the modes follow the session now')
})

test('server/instructions.md is under 4,000 bytes and names each of the seven tools', () => {
  assert.ok(Buffer.byteLength(INSTRUCTIONS) < 4000, `${Buffer.byteLength(INSTRUCTIONS)} bytes`)
  for (const tool of TOOLS) assert.ok(INSTRUCTIONS.includes(`\`${tool}\``), `the instructions name ${tool}`)
  for (const advice of ['not_fast_forward', 'merge_conflict']) assert.ok(INSTRUCTIONS.includes(advice), advice)
})

// ---------------------------------------------------------------------------------------------------------------------
// status

test('status answers each state of a job as the 0.1 mod did', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const alive = s.liveGroup()
  const dead = await s.deadGroup()
  const running = Date.now() - 5000
  job(s.jobsDir, 'job-run', { startedAt: running, files: { pgid: String(alive) } })
  job(s.jobsDir, 'job-ask', { startedAt: running, files: { pgid: String(alive), 'question.txt': 'Which branch?\n' } })
  job(s.jobsDir, 'job-ok', { files: { exit: '0', 'last.txt': 'The answer is 42.' }, exitAt: SECOND + 4 })
  job(s.jobsDir, 'job-blk', { files: { exit: '0', 'last.txt': 'BLOCKED: Which branch?', 'question.txt': 'Which branch?\n' }, exitAt: SECOND + 4 })
  job(s.jobsDir, 'job-bad', {
    files: { exit: '1', 'stderr.txt': 'Error: request refused\nAuthorization: Bearer fixture-bearer-value\n' },
    exitAt: SECOND + 2,
  })
  job(s.jobsDir, 'job-cut', { files: { exit: '124' }, exitAt: SECOND + 3 })
  job(s.jobsDir, 'job-gone', { files: { pgid: String(dead) } })
  const server = s.start()
  t.after(() => server.close())
  const status = async (taskId) => {
    const answer = await server.call('status', { taskId })
    assert.equal(answer.isError, 'error' in answer.json && typeof answer.json.error === 'object')
    return answer.json
  }
  const base = { kind: 'manual', instanceId: 'codex', model: 'fixture-model' }

  assert.deepEqual(await status('job-run'), {
    taskId: 'job-run',
    status: 'running',
    workState: 'working',
    ...base,
    startedAtIso: new Date(running).toISOString(),
  })
  assert.deepEqual(await status('job-ask'), {
    taskId: 'job-ask',
    status: 'waiting',
    workState: 'working',
    ...base,
    startedAtIso: new Date(running).toISOString(),
  })
  assert.deepEqual(await status('job-ok'), {
    taskId: 'job-ok',
    status: 'completed',
    workState: 'result_available',
    ...base,
    startedAtIso: iso(SECOND),
    finishedAtIso: iso(SECOND + 4),
    result: 'The answer is 42.',
  })
  assert.deepEqual(await status('job-blk'), {
    taskId: 'job-blk',
    status: 'completed',
    workState: 'result_available',
    ...base,
    startedAtIso: iso(SECOND),
    finishedAtIso: iso(SECOND + 4),
    result: 'BLOCKED on a question (taskId job-blk): Which branch?\n\nThis worker cannot be resumed (it recorded no session), so answer it in a new delegate with the original brief plus the answer.',
  })
  const failed = await status('job-bad')
  assert.deepEqual(failed, {
    taskId: 'job-bad',
    status: 'failed',
    workState: 'result_available',
    ...base,
    startedAtIso: iso(SECOND),
    finishedAtIso: iso(SECOND + 2),
    error: 'failed (exit 1)\nError: request refused\nAuthorization: [REDACTED]',
  })
  assert.equal(JSON.stringify(failed).includes('fixture-bearer-value'), false)
  assert.deepEqual(await status('job-cut'), {
    taskId: 'job-cut',
    status: 'cancelled',
    workState: 'result_available',
    ...base,
    startedAtIso: iso(SECOND),
    finishedAtIso: iso(SECOND + 3),
  })
  assert.deepEqual(await status('job-gone'), {
    taskId: 'job-gone',
    status: 'interrupted',
    workState: 'result_available',
    ...base,
    startedAtIso: iso(SECOND),
    error: 'its supervisor is gone and it left no exit file',
  })
})

test('status of an unknown or unsafe id is task_not_found, and without a taskId it is invalid_request, all as isError', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  for (const taskId of ['nope', '../x']) {
    const answer = await server.call('status', { taskId })
    assert.equal(answer.isError, true)
    assert.deepEqual(answer.json, FAILURE('task_not_found', `no task ${taskId}`))
  }
  for (const input of [{}, { taskId: '' }, { taskId: 7 }]) {
    const answer = await server.call('status', input)
    assert.equal(answer.isError, true)
    assert.deepEqual(answer.json, FAILURE('invalid_request', 'mcp__plugin_cc-orq_orq__status needs {"taskId": "<id>"}'))
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// cancel

test('cancel of a running or waiting job writes the cancel marker and answers cancel_requested, again on a repeat', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const alive = s.liveGroup()
  job(s.jobsDir, 'job-a', { startedAt: Date.now() - 5000, files: { pgid: String(alive) } })
  job(s.jobsDir, 'job-ask', { startedAt: Date.now() - 5000, files: { pgid: String(alive), 'question.txt': 'Which branch?\n' } })
  const server = s.start()
  t.after(() => server.close())

  const first = await server.call('cancel', { taskId: 'job-a' })
  assert.equal(first.isError, false)
  assert.deepEqual(first.json, { taskId: 'job-a', status: 'cancel_requested' })
  assert.ok(readFileSync(join(s.jobsDir, 'job-a', 'cancel'), 'utf8').startsWith('cancelled at '))
  assert.equal((await server.call('status', { taskId: 'job-a' })).json.status, 'running', 'a cancel request still reads as running')

  const again = await server.call('cancel', { taskId: 'job-a', reason: 'second request' })
  assert.deepEqual(again.json, { taskId: 'job-a', status: 'cancel_requested' })
  assert.ok(readFileSync(join(s.jobsDir, 'job-a', 'cancel'), 'utf8').includes('why="second request"'))

  assert.deepEqual((await server.call('cancel', { taskId: 'job-ask', reason: 'the user stopped it' })).json, {
    taskId: 'job-ask',
    status: 'cancel_requested',
  })
  assert.ok(readFileSync(join(s.jobsDir, 'job-ask', 'cancel'), 'utf8').includes('why="the user stopped it"'))
})

test('cancel of an ended, interrupted or unknown job is refused as isError, and writes nothing', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  job(s.jobsDir, 'job-fin', { files: { exit: '0', 'last.txt': 'OK' }, exitAt: SECOND + 1 })
  job(s.jobsDir, 'job-int', { files: { pgid: String(await s.deadGroup()) } })
  const server = s.start()
  t.after(() => server.close())
  const finished = await server.call('cancel', { taskId: 'job-fin' })
  assert.equal(finished.isError, true)
  assert.deepEqual(finished.json, FAILURE('task_not_cancellable', 'task job-fin is completed, so it has nothing left to cancel'))
  assert.deepEqual(
    (await server.call('cancel', { taskId: 'job-int' })).json,
    FAILURE('task_not_cancellable', 'task job-int is interrupted, so it has nothing left to cancel'),
  )
  assert.deepEqual((await server.call('cancel', { taskId: 'nope' })).json, FAILURE('task_not_found', 'no task nope'))
  for (const dir of ['job-fin', 'job-int']) assert.equal(existsSync(join(s.jobsDir, dir, 'cancel')), false)
})

test('cancel refuses a reason that is not text or is over 200 characters, and takes one of exactly 200', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  job(s.jobsDir, 'job-long', { startedAt: Date.now() - 5000, files: { pgid: String(s.liveGroup()) } })
  const server = s.start()
  t.after(() => server.close())
  for (const reason of ['x'.repeat(201), 5]) {
    const answer = await server.call('cancel', { taskId: 'job-long', reason })
    assert.equal(answer.isError, true)
    assert.equal(answer.json.error.code, 'invalid_request')
  }
  assert.equal(existsSync(join(s.jobsDir, 'job-long', 'cancel')), false)
  const atLimit = await server.call('cancel', { taskId: 'job-long', reason: 'é'.repeat(200) })
  assert.deepEqual(atLimit.json, { taskId: 'job-long', status: 'cancel_requested' })
  assert.deepEqual((await server.call('cancel', {})).json, FAILURE('invalid_request', 'mcp__plugin_cc-orq_orq__cancel needs {"taskId": "<id>"}'))
})

test('a tool that cannot do its work answers isError with a text that names it, and the server logs it on stderr', { skip: process.getuid?.() === 0 && 'root can write into any directory' }, async (t) => {
  const s = scene()
  const dir = job(s.jobsDir, 'job-locked', { startedAt: Date.now() - 5000, files: { pgid: String(s.liveGroup()) } })
  chmodSync(dir, 0o555)
  const server = s.start()
  t.after(async () => {
    chmodSync(dir, 0o755)
    await server.close()
    s.cleanup()
  })
  const answer = await server.call('cancel', { taskId: 'job-locked' })
  assert.equal(answer.isError, true)
  assert.match(answer.text, /^orq: cancel failed: .*(EACCES|permission denied)/i)
  assert.match(server.stderr(), /orq: cancel failed: /)
  assert.equal(server.garbage.length, 0)
})

// ---------------------------------------------------------------------------------------------------------------------
// list

test('list answers the newest jobs first, whatever their kind, with the fields of a row', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const alive = s.liveGroup()
  const dead = await s.deadGroup()
  const running = Date.now() - 8000
  job(s.jobsDir, 'job-old', { startedAt: STARTED, files: { exit: '0', 'last.txt': 'OK' }, exitAt: SECOND + 4.0004 })
  job(s.jobsDir, 'job-mcp', {
    startedAt: STARTED + 1000,
    meta: { kind: 'mcp', agentId: 'sess-1', instanceId: undefined, model: undefined },
    files: { exit: '0', 'last.txt': 'BLOCKED: x', 'question.txt': 'Which branch?\n' },
    exitAt: SECOND + 11,
  })
  job(s.jobsDir, 'job-task', {
    startedAt: STARTED + 2000,
    meta: { kind: 'task', agentId: 'a-1', branch: 'orq/job-task', repo: '/work', worktree: '/work-wt/job-task', cwd: '/work-wt/job-task' },
    files: { exit: '1', 'stderr.txt': 'boom\n' },
    exitAt: SECOND + 5,
  })
  job(s.jobsDir, 'job-gone', { startedAt: STARTED + 3000, files: { pgid: String(dead) } })
  job(s.jobsDir, 'job-live', { startedAt: running, files: { pgid: String(alive) } })
  mkdirSync(join(s.jobsDir, 'no-meta-dir'))
  const server = s.start()
  t.after(() => server.close())
  const answer = await server.call('list')
  assert.equal(answer.isError, false)
  assert.deepEqual(Object.keys(answer.json), ['jobs'])
  const rows = answer.json.jobs
  assert.deepEqual(
    rows.map((row) => row.taskId),
    ['job-live', 'job-gone', 'job-task', 'job-mcp', 'job-old'],
  )
  const byId = Object.fromEntries(rows.map((row) => [row.taskId, row]))
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['branch', 'cwd', 'durationMs', 'instanceId', 'kind', 'model', 'parent', 'question', 'startedAt', 'status', 'taskId'])
    assert.equal(row.parent, null)
  }
  assert.deepEqual(byId['job-old'], {
    taskId: 'job-old',
    status: 'completed',
    kind: 'manual',
    instanceId: 'codex',
    model: 'fixture-model',
    startedAt: iso(SECOND),
    durationMs: 4000,
    cwd: '/work',
    branch: null,
    parent: null,
    question: false,
  })
  assert.deepEqual(byId['job-task'], {
    taskId: 'job-task',
    status: 'failed',
    kind: 'task',
    instanceId: 'codex',
    model: 'fixture-model',
    startedAt: iso(SECOND + 2),
    durationMs: 3000,
    cwd: '/work-wt/job-task',
    branch: 'orq/job-task',
    parent: null,
    question: false,
  })
  assert.equal(byId['job-mcp'].kind, 'mcp')
  assert.equal(byId['job-mcp'].instanceId, null)
  assert.equal(byId['job-mcp'].model, null)
  assert.equal(byId['job-mcp'].status, 'completed')
  assert.equal(byId['job-mcp'].question, true, 'a job that ended on a question says so')
  assert.equal(byId['job-mcp'].durationMs, 10000)
  assert.equal(byId['job-gone'].status, 'interrupted')
  assert.equal(byId['job-gone'].durationMs, null, 'an interrupted job has no end to measure to')
  assert.equal(byId['job-live'].status, 'running')
  assert.ok(byId['job-live'].durationMs >= 8000 && byId['job-live'].durationMs < 60000, `running for ${byId['job-live'].durationMs} ms`)
  assert.equal(byId['job-live'].question, false)
  for (const row of rows) assert.ok(row.durationMs === null || Number.isInteger(row.durationMs), `${row.taskId} lasted ${row.durationMs} ms`)
})

test('list takes a limit from 1 to 50, defaults to 20, and refuses any other limit as isError', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  for (let i = 0; i < 25; i += 1) {
    job(s.jobsDir, `job-${String(i).padStart(2, '0')}`, { startedAt: STARTED + i * 1000, files: { exit: '0', 'last.txt': 'OK' }, exitAt: SECOND + i + 1 })
  }
  const server = s.start()
  t.after(() => server.close())
  const ids = async (input) => (await server.call('list', input)).json.jobs.map((row) => row.taskId)
  assert.equal((await ids({})).length, 20)
  assert.deepEqual(await ids({}), Array.from({ length: 20 }, (_, i) => `job-${String(24 - i).padStart(2, '0')}`))
  assert.deepEqual(await ids({ limit: 3 }), ['job-24', 'job-23', 'job-22'])
  assert.equal((await ids({ limit: 1 })).length, 1)
  assert.equal((await ids({ limit: 50 })).length, 25)
  const refusal = FAILURE('invalid_request', 'limit must be a whole number from 1 to 50')
  for (const limit of [0, 51, 1.5, -1, '3', null, true]) {
    const answer = await server.call('list', { limit })
    assert.equal(answer.isError, true, `limit ${JSON.stringify(limit)} is refused`)
    assert.deepEqual(answer.json, refusal)
  }
})

test('list of an empty or missing jobs directory is an empty list, not an error', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  assert.deepEqual((await server.call('list')).json, { jobs: [] })
  rmSync(s.jobsDir, { recursive: true })
  const missing = await server.call('list')
  assert.equal(missing.isError, false)
  assert.deepEqual(missing.json, { jobs: [] })
})

// ---------------------------------------------------------------------------------------------------------------------
// capabilities

const FAKE_CODEX = (counter) =>
  [
    '#!/bin/bash',
    `case "$1 $2" in`,
    `  "debug models") echo probe >> '${counter}'`,
    `    printf '%s' '{"models":[{"slug":"fixture-model-1","display_name":"Fixture Model One","visibility":"list","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"}]}]}' ;;`,
    `  "login status") exit 0 ;;`,
    'esac',
    '',
  ].join('\n')

test('capabilities answers the CapabilitiesResult shape of 0.1, with the ceiling of the config alone when no session mode reached it', async (t) => {
  const s = scene({ bin: { claude: '#!/bin/bash\nexit 0\n' } })
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  const answer = await server.call('capabilities')
  assert.equal(answer.isError, false)
  assert.deepEqual(answer.json, {
    parentThreadId: null,
    inheritedProviderInstanceId: null,
    inheritedModel: null,
    runtimeMode: 'auto-accept-edits',
    interactionMode: 'default',
    providers: [
      {
        providerInstanceId: 'claudeAgent',
        driverKind: 'claudeAgent',
        displayName: null,
        models: [
          { id: 'haiku', label: null },
          { id: 'sonnet', label: null },
          { id: 'opus', label: null },
        ],
        canRunChildTask: true,
        canRunCrossProviderChildTask: true,
        constraints: [],
      },
    ],
    features: {
      appOwnedSubagents: true,
      asyncPolling: true,
      cancellation: true,
      batchThreadCreation: false,
      threadManagement: false,
      incrementalThreadRead: false,
      scheduledTasks: false,
      maxBatchThreads: 0,
    },
    ceiling: {
      config: { runtime: 'auto-accept-edits', sharedRuntime: 'approval-required', interaction: 'default' },
      session: null,
      effective: {
        worktree: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
        shared: { runtimeMode: 'approval-required', interactionMode: 'default' },
      },
    },
    client: { tasks: true, forms: false },
  })
})

test('capabilities probes once for ten minutes, probes again for another instances list, and reports a CLI that is missing', async (t) => {
  const s = scene({ instances: [{ id: 'codex', driver: 'codex' }] })
  const counter = join(s.root, 'probes')
  writeFileSync(join(s.root, 'bin', 'codex'), FAKE_CODEX(counter))
  chmodSync(join(s.root, 'bin', 'codex'), 0o755)
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  const probes = () => (existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').length : 0)

  const first = await server.call('capabilities')
  assert.equal(first.json.providers[0].models[0].id, 'fixture-model-1')
  assert.equal(first.json.providers[0].models[0].options[0].id, 'reasoningEffort')
  assert.equal(probes(), 1)
  await server.call('capabilities')
  assert.equal(probes(), 1, 'the second call reads the cache')

  s.setConfig({ instances: [{ id: 'codex-work', driver: 'codex' }] })
  const changed = await server.call('capabilities')
  assert.equal(probes(), 2, 'a changed instances list probes again inside the ten minutes')
  assert.deepEqual(
    changed.json.providers.map((p) => p.providerInstanceId),
    ['codex-work'],
  )

  s.setConfig({ instances: [{ id: 'opencode', driver: 'opencode' }] })
  const missing = await server.call('capabilities')
  assert.equal(missing.json.providers[0].canRunChildTask, false)
  assert.deepEqual(missing.json.providers[0].constraints, ['Provider executable is not installed.', "Executable 'opencode' was not found on PATH."])
})

test('a failed catalog probe answers no providers, logs why on stderr, and is probed again on the next call', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const server = s.start({ PATH: join(s.root, 'empty') })
  t.after(() => server.close())
  const answer = await server.call('capabilities')
  assert.equal(answer.isError, false)
  assert.deepEqual(answer.json.providers, [])
  assert.match(server.stderr(), /orq: catalog probe failed: /)
  assert.equal(server.garbage.length, 0)
})

// ---------------------------------------------------------------------------------------------------------------------
// integrate, on a worktree job that a fake worker commits in

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...AUTHOR } })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** The worker commits `<worktree name>.txt` in its own worktree, then answers as the Claude CLI does. */
const FAKE_WORKER = [
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

async function untilEnded(statusOf, taskId) {
  const stopAt = Date.now() + 30000
  for (;;) {
    const { json } = await statusOf(taskId)
    if (!['running', 'waiting'].includes(json.status)) return json
    assert.ok(Date.now() < stopAt, `${taskId} is still ${json.status}`)
    await new Promise((done) => setTimeout(done, 200))
  }
}

test('integrate fast-forwards a worktree job that a fake worker committed in, and refuses what it must', async (t) => {
  const s = scene({ instances: [{ id: 'claudeAgent', driver: 'claudeAgent' }], bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const session = join(s.root, 'session')
  const repo = join(session, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(repo, ['add', 'shared.txt'])
  git(repo, ['commit', '-q', '-m', 'base'])

  const engine = nodeEngine({ env: s.env, pluginRoot: REPO })
  const config = { ...defaultConfig(s.home), jobsDir: s.jobsDir }
  const launch = async (agentId) => {
    const header = parseTaskHeader(`target: claudeAgent haiku\ncwd: ${repo}\nisolation: worktree\n\nwork`)
    const launched = await launchTaskFromHeader(engine, config, {
      agentId,
      header,
      ceiling: parentRuntimeModeFromPermissionMode('acceptEdits'),
      sessionDir: session,
    })
    assert.ok('job' in launched, JSON.stringify(launched))
    return launched.job
  }

  const server = s.start()
  t.after(() => server.close())
  const statusOf = (taskId) => server.call('status', { taskId })
  const jobA = await launch('agent-a')
  const jobB = await launch('agent-b')
  const jobC = await launch('agent-c')
  for (const j of [jobA, jobB, jobC]) assert.equal((await untilEnded(statusOf, j.id)).status, 'completed')
  assert.equal(readFileSync(join(jobA.dir, 'meta.json'), 'utf8').includes(`orq/${jobA.id}`), true)

  const integrate = (taskId, strategy) => server.call('integrate', strategy === undefined ? { taskId } : { taskId, strategy })
  const tip = git(jobA.worktree ?? join(session, 'repo-wt', jobA.id), ['rev-parse', 'HEAD'])

  const ff = await integrate(jobA.id)
  assert.equal(ff.isError, false)
  assert.deepEqual(ff.json, { ok: true, taskId: jobA.id, mergedSha: tip, branch: `orq/${jobA.id}`, worktree: join(session, 'repo-wt', jobA.id) })
  assert.equal(git(repo, ['rev-parse', 'HEAD']), tip, 'the checkout moved to the task commit')
  assert.equal(readFileSync(join(repo, `${jobA.id}.txt`), 'utf8'), 'worker output\n')
  assert.equal(git(repo, ['rev-list', '--merges', '--count', 'HEAD']), '0', 'ff-only makes no merge commit')

  const again = await integrate(jobA.id)
  assert.equal(again.isError, true)
  assert.equal(again.json.ok, false)
  assert.equal(again.json.error.code, 'already_integrated')

  writeFileSync(join(repo, 'notes.txt'), 'untracked\n')
  assert.equal((await integrate(jobB.id)).json.error.code, 'dirty_worktree')
  rmSync(join(repo, 'notes.txt'))

  writeFileSync(join(session, 'repo-wt', jobB.id, 'shared.txt'), 'from task b\n')
  git(join(session, 'repo-wt', jobB.id), ['commit', '-q', '-a', '-m', 'task b edits the shared file'])
  writeFileSync(join(repo, 'shared.txt'), 'from main\n')
  git(repo, ['commit', '-q', '-a', '-m', 'main edits the shared file'])
  const behind = await integrate(jobB.id)
  assert.equal(behind.isError, true)
  assert.equal(behind.json.error.code, 'not_fast_forward')

  const conflict = await integrate(jobB.id, 'merge')
  assert.equal(conflict.isError, true)
  assert.equal(conflict.json.error.code, 'merge_conflict')
  assert.deepEqual(conflict.json.error.files, ['shared.txt'])
  assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false, 'the conflicting merge was aborted')
  assert.equal(git(repo, ['status', '--porcelain']), '')

  const headBeforeMerge = git(repo, ['rev-parse', 'HEAD'])
  const merged = await integrate(jobC.id, 'merge')
  assert.equal(merged.isError, false)
  assert.equal(merged.json.ok, true)
  assert.equal(git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3, 'a merge commit with two parents')
  assert.notEqual(merged.json.mergedSha, headBeforeMerge)

  const bad = [{}, { taskId: '' }, { taskId: jobA.id, strategy: 'rebase' }, { taskId: 3 }]
  for (const input of bad) {
    const refused = await server.call('integrate', input)
    assert.equal(refused.isError, true)
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'invalid_request')
  }
  assert.equal((await integrate('job-nope')).json.error.code, 'task_not_found')
  job(s.jobsDir, 'job-plain', { meta: { cwd: repo } })
  assert.equal((await integrate('job-plain')).json.error.code, 'no_worktree')
  const outside = join(s.root, 'not-a-checkout')
  mkdirSync(outside)
  job(s.jobsDir, 'job-lost', { meta: { repo: outside, branch: 'orq/job-lost', worktree: `${outside}-wt`, cwd: `${outside}-wt` } })
  assert.equal((await integrate('job-lost')).json.error.code, 'not_a_repository')
  assert.equal(readdirSync(session).includes('repo-wt'), true)
})

function checkoutWithLauncher(s) {
  const session = join(s.root, 'session')
  const repo = join(session, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(repo, ['add', 'shared.txt'])
  git(repo, ['commit', '-q', '-m', 'base'])
  const engine = nodeEngine({ env: s.env, pluginRoot: REPO })
  const config = { ...defaultConfig(s.home), jobsDir: s.jobsDir }
  const launch = async (agentId) => {
    const header = parseTaskHeader(`target: claudeAgent haiku\ncwd: ${repo}\nisolation: worktree\n\nwork`)
    const launched = await launchTaskFromHeader(engine, config, {
      agentId,
      header,
      ceiling: parentRuntimeModeFromPermissionMode('acceptEdits'),
      sessionDir: session,
    })
    assert.ok('job' in launched, JSON.stringify(launched))
    return launched.job
  }
  return { repo, launch }
}

function hookFile(repo, name, body) {
  const path = join(repo, '.git', 'hooks', name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

test('integrate runs no hook of the checkout until the config says gitHooks run, and then answers hook_failed with the hook output', async (t) => {
  const s = scene({ instances: [{ id: 'claudeAgent', driver: 'claudeAgent' }], bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const { repo, launch } = checkoutWithLauncher(s)
  const refusing = join(s.root, 'lint-fails')
  const marker = join(s.root, 'post-merge-ran')
  writeFileSync(refusing, '')
  hookFile(repo, 'pre-merge-commit', `if [ -e "${refusing}" ]; then echo "lint: a trailing space" >&2; exit 1; fi`)
  hookFile(repo, 'post-merge', `touch "${marker}"`)

  const server = s.start()
  t.after(() => server.close())
  const statusOf = (taskId) => server.call('status', { taskId })
  const first = await launch('agent-a')
  const second = await launch('agent-b')
  for (const j of [first, second]) assert.equal((await untilEnded(statusOf, j.id)).status, 'completed')

  const byDefault = await server.call('integrate', { taskId: first.id, strategy: 'merge' })
  assert.equal(byDefault.isError, false)
  assert.equal(byDefault.json.ok, true)
  assert.equal(existsSync(marker), false, 'the post-merge hook did not run by default')
  assert.equal(git(repo, ['rev-list', '--merges', '--count', 'HEAD']), '1', 'the refusing pre-merge-commit hook did not stop the merge by default')

  for (const gitHooks of ['RUN', true, 'on']) {
    s.setConfig({ integrate: { gitHooks } })
    const ignored = await server.call('integrate', { taskId: second.id, strategy: 'merge' })
    assert.equal(ignored.json.error?.code, undefined, `integrate.gitHooks ${JSON.stringify(gitHooks)} is not run`)
    assert.equal(ignored.json.ok, true)
    git(repo, ['reset', '-q', '--hard', 'HEAD~1'])
  }

  s.setConfig({ integrate: { gitHooks: 'run' } })
  const headBefore = git(repo, ['rev-parse', 'HEAD'])
  const refused = await server.call('integrate', { taskId: second.id, strategy: 'merge' })
  assert.equal(refused.isError, true)
  assert.equal(refused.json.ok, false)
  assert.equal(refused.json.error.code, 'hook_failed')
  assert.match(refused.json.error.message, /lint: a trailing space/)
  assert.match(refused.json.error.message, /checkout's hook/)
  assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false, 'no merge is left pending')
  assert.equal(git(repo, ['status', '--porcelain']), '', 'the checkout is clean')
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore, 'HEAD did not move')
  assert.equal(existsSync(marker), false, 'a merge that a hook refused ran no post-merge hook')

  rmSync(refusing)
  const merged = await server.call('integrate', { taskId: second.id, strategy: 'merge' })
  assert.equal(merged.isError, false)
  assert.equal(merged.json.ok, true)
  assert.equal(existsSync(marker), true, 'the post-merge hook ran with the opt-in')
})

test('integrate answers task_running with the id of a live job on the branch, before git runs, and goes on once that job is gone', async (t) => {
  const s = scene({ instances: [{ id: 'claudeAgent', driver: 'claudeAgent' }], bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const { repo, launch } = checkoutWithLauncher(s)
  const server = s.start()
  t.after(() => server.close())
  const first = await launch('agent-a')
  assert.equal((await untilEnded((taskId) => server.call('status', { taskId }), first.id)).status, 'completed')

  const group = s.liveGroup()
  job(s.jobsDir, 'job-next', {
    meta: { kind: 'task', agentId: 'agent-n', repo, branch: `orq/${first.id}`, worktree: first.worktree, cwd: first.worktree },
    files: { pgid: `${group}\n` },
  })
  const headBefore = git(repo, ['rev-parse', 'HEAD'])
  const refused = await server.call('integrate', { taskId: first.id })
  assert.equal(refused.isError, true)
  assert.equal(refused.json.ok, false)
  assert.equal(refused.json.error.code, 'task_running')
  assert.match(refused.json.error.message, /job-next/)
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore, 'HEAD did not move')
  assert.equal(git(repo, ['status', '--porcelain']), '', 'the checkout is clean')
  assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false)

  process.kill(-group, 'SIGKILL')
  for (let wait = 0; wait < 250; wait += 1) {
    try {
      process.kill(-group, 0)
    } catch {
      break
    }
    await new Promise((done) => setTimeout(done, 20))
  }
  const merged = await server.call('integrate', { taskId: first.id })
  assert.equal(merged.isError, false)
  assert.equal(merged.json.ok, true)
  assert.equal(git(repo, ['rev-parse', 'HEAD']), merged.json.mergedSha)
})

test('integrate answers task_running for a live shared job inside the task worktree and for a job that has no pgid yet, and goes on once they are gone', async (t) => {
  const s = scene({ instances: [{ id: 'claudeAgent', driver: 'claudeAgent' }], bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const { repo, launch } = checkoutWithLauncher(s)
  const server = s.start()
  t.after(() => server.close())
  const first = await launch('agent-a')
  assert.equal((await untilEnded((taskId) => server.call('status', { taskId }), first.id)).status, 'completed')
  const headBefore = git(repo, ['rev-parse', 'HEAD'])
  const refuse = async (name) => {
    const refused = await server.call('integrate', { taskId: first.id })
    assert.equal(refused.isError, true)
    assert.equal(refused.json.error.code, 'task_running')
    assert.match(refused.json.error.message, new RegExp(`task ${name} is still running`))
    assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore, 'HEAD did not move')
    assert.equal(git(repo, ['status', '--porcelain']), '', 'the checkout is clean')
  }

  const group = s.liveGroup()
  job(s.jobsDir, 'job-shared', { meta: { kind: 'task', agentId: 'agent-s', cwd: join(first.worktree, 'src') }, files: { pgid: `${group}\n` } })
  await refuse('job-shared')
  process.kill(-group, 'SIGKILL')
  for (let wait = 0; wait < 250; wait += 1) {
    try {
      process.kill(-group, 0)
    } catch {
      break
    }
    await new Promise((done) => setTimeout(done, 20))
  }

  job(s.jobsDir, 'job-fresh', { startedAt: Date.now(), meta: { kind: 'task', agentId: 'agent-f', cwd: first.worktree } })
  await refuse('job-fresh')
  job(s.jobsDir, 'job-fresh', { startedAt: Date.now() - 60_000, meta: { kind: 'task', agentId: 'agent-f', cwd: first.worktree } })
  const merged = await server.call('integrate', { taskId: first.id })
  assert.equal(merged.isError, false)
  assert.equal(merged.json.ok, true)
  assert.equal(git(repo, ['rev-parse', 'HEAD']), merged.json.mergedSha)
})

// ---------------------------------------------------------------------------------------------------------------------
// capabilities and the session mode

const CLIENT_WITH_FORMS = { extensions: { [TASKS]: {} }, elicitation: { form: {} } }

test('capabilities follows the session mode that the hook supplies, and says which limit is which', async (t) => {
  const s = scene({ bin: { claude: '#!/bin/bash\nexit 0\n' } })
  s.setConfig({ ceiling: { runtime: 'auto', sharedRuntime: 'auto-accept-edits' } })
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  const ask = async (sessionMode) => (await server.call('capabilities', sessionMode === undefined ? {} : { sessionMode })).json
  const modes = (answer) => [answer.runtimeMode, answer.interactionMode]

  const alone = await ask(undefined)
  assert.deepEqual(modes(alone), ['auto', 'default'], 'without a session mode only the config limits')
  assert.equal(alone.ceiling.session, null)
  assert.deepEqual(alone.ceiling.config, { runtime: 'auto', sharedRuntime: 'auto-accept-edits', interaction: 'default' })
  assert.deepEqual(alone.ceiling.effective, {
    worktree: { runtimeMode: 'auto', interactionMode: 'default' },
    shared: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
  })

  const rows = [
    ['default', ['approval-required', 'default'], 'approval-required'],
    ['manual', ['approval-required', 'default'], 'approval-required'],
    ['dontAsk', ['approval-required', 'default'], 'approval-required'],
    ['acceptEdits', ['auto-accept-edits', 'default'], 'auto-accept-edits'],
    ['auto', ['auto', 'default'], 'auto-accept-edits'],
    ['bypassPermissions', ['auto', 'default'], 'auto-accept-edits'],
    ['plan', ['approval-required', 'plan'], 'approval-required'],
    ['root-please', ['approval-required', 'default'], 'approval-required'],
  ]
  for (const [sessionMode, expected, shared] of rows) {
    const answer = await ask(sessionMode)
    assert.deepEqual(modes(answer), expected, `${sessionMode}: the modes are the effective ceiling of a worktree task`)
    assert.equal(answer.ceiling.session.mode, sessionMode, `${sessionMode}: the mode that arrived`)
    assert.deepEqual(answer.ceiling.effective.worktree, { runtimeMode: expected[0], interactionMode: expected[1] })
    assert.equal(answer.ceiling.effective.shared.runtimeMode, shared, `${sessionMode}: a shared task has its own limit`)
    assert.deepEqual(answer.ceiling.config, alone.ceiling.config, `${sessionMode}: the config part never changes with the session`)
  }
})

test('capabilities refuses a sessionMode that is not text, tells a client with tasks and forms from one without, and warns about a ceiling it cannot read', async (t) => {
  const s = scene({ bin: { claude: '#!/bin/bash\nexit 0\n' } })
  s.setConfig({ ceiling: { runtime: 'turbo', interaction: 7 } })
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  for (const sessionMode of [7, null, ['auto'], { mode: 'auto' }, true]) {
    const answer = await server.call('capabilities', { sessionMode })
    assert.equal(answer.isError, true, JSON.stringify(sessionMode))
    assert.deepEqual(answer.json, FAILURE('invalid_request', 'sessionMode must be text; the cc-orq hook fills it, so leave it out'))
  }
  const ceilingOf = async (capabilities) => (await server.call('capabilities', {}, capabilities)).json
  const plain = await ceilingOf({})
  assert.deepEqual(plain.client, { tasks: false, forms: false })
  assert.deepEqual((await ceilingOf(CLIENT_WITH_FORMS)).client, { tasks: true, forms: true })
  assert.deepEqual((await ceilingOf({ elicitation: { form: {} } })).client, { tasks: false, forms: true })
  assert.deepEqual([plain.runtimeMode, plain.interactionMode], ['approval-required', 'plan'], 'an invalid ceiling fails closed')
  assert.deepEqual(plain.ceiling.warnings, [
    'ceiling.runtime must be one of approval-required, auto-accept-edits, auto, full-access; it counts as approval-required',
    'ceiling.interaction must be one of default, plan; it counts as plan',
  ])
  assert.match(server.stderr(), /orq: config: ceiling\.runtime must be one of/, 'the server logs the warning too')
})

// ---------------------------------------------------------------------------------------------------------------------
// delegate

const SESSION_ID = 'sess-0123456789'

/** A session directory that holds one git checkout with one commit. */
function checkout(s) {
  const session = join(s.root, 'session')
  const repo = join(session, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(repo, ['add', 'shared.txt'])
  git(repo, ['commit', '-q', '-m', 'base'])
  return { session, repo }
}

const startIn = (s, session, extraEnv = {}) => s.start({ CLAUDE_PROJECT_DIR: session, CLAUDE_CODE_SESSION_ID: SESSION_ID, ...extraEnv })
const jobDirs = (s) => (existsSync(s.jobsDir) ? readdirSync(s.jobsDir) : [])

/** The worker of the integrate test with its argv kept, and held until the test creates `go` in the job directory. */
const FAKE_HELD_WORKER = FAKE_WORKER.replace(
  '#!/bin/bash\n',
  '#!/bin/bash\nprintf "%s\\n" "$@" > "$ORQ_JOB_DIR/argv.txt"\nfor _ in $(seq 1 300); do [ -e "$ORQ_JOB_DIR/go" ] && break; sleep 0.1; done\n',
)

const NO_TASKS = {}
const ENUMS = (text) => /one of: (.*)\.$/.exec(parseTaskHeader(text).error.message)[1].split(', ')
const HEADER = 'target: a b\ncwd: /x\n'

test('the delegate input schema takes the header fields, requires four, and takes sessionMode from the hook', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  const { result } = await server.request('tools/list', modern())
  const delegate = result.tools.find((tool) => tool.name === 'delegate')
  const schema = delegate.inputSchema
  assert.equal(schema.type, 'object')
  assert.deepEqual(Object.keys(schema.properties), ['target', 'model', 'effort', 'cwd', 'isolation', 'role', 'runtime', 'interaction', 'questions', 'prompt', 'sessionMode'])
  assert.deepEqual(schema.required, ['target', 'model', 'cwd', 'prompt'])
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.sessionMode.description, 'Filled by the cc-orq hook; leave it out.')
  for (const [field, text] of [
    ['isolation', `${HEADER}isolation: nope\n\np`],
    ['role', `${HEADER}role: nope\n\np`],
  ]) {
    assert.deepEqual(schema.properties[field].enum, ENUMS(text), `${field} offers what the header parser accepts`)
  }
  assert.deepEqual(schema.properties.runtime.enum, ENUMS('target: a b runtime=nope\ncwd: /x\n\np'))
  assert.deepEqual(schema.properties.interaction.enum, ENUMS('target: a b interaction=nope\ncwd: /x\n\np'))
  assert.deepEqual(schema.properties.questions.enum, ['parent', 'human'])
  assert.equal(schema.properties.prompt.maxLength, 200000, 'the schema advertises the cap that the handler enforces')
  for (const phrase of ['{"taskId", "status": "running"}', 'commit', 'integrate', 'status', 'ceiling', 'worktree', 'questions']) {
    assert.ok(delegate.description.includes(phrase), `the description names ${phrase}`)
  }
})

test('delegate refuses what the cc-orq:task header refuses, with the same code and message, and launches nothing', async (t) => {
  const s = scene({ instances: [{ id: 'claudeAgent', driver: 'claudeAgent' }, { id: 'opencode', driver: 'opencode' }] })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = startIn(s, session)
  t.after(() => server.close())
  const base = { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Go.' }
  const line = (more = '') => `target: claudeAgent haiku${more}\ncwd: ${repo}\n`
  const cases = [
    ['no target and no model', { cwd: repo, prompt: 'Go.' }, `cwd: ${repo}\n\nGo.`],
    ['no model', { target: 'claudeAgent', cwd: repo, prompt: 'Go.' }, `target: claudeAgent\ncwd: ${repo}\n\nGo.`],
    ['a model that starts with a dash', { ...base, model: '-haiku' }, `target: claudeAgent -haiku\ncwd: ${repo}\n\nGo.`],
    ['an effort that is not a word of plain characters', { ...base, effort: 'high!' }, `${line(' effort=high!')}\nGo.`],
    ['an empty effort', { ...base, effort: '' }, `${line(' effort=')}\nGo.`],
    ['a runtime that is not a mode', { ...base, runtime: 'turbo' }, `${line(' runtime=turbo')}\nGo.`],
    ['an interaction that is not a mode', { ...base, interaction: 'chat' }, `${line(' interaction=chat')}\nGo.`],
    ['no cwd', { target: 'claudeAgent', model: 'haiku', prompt: 'Go.' }, 'target: claudeAgent haiku\n\nGo.'],
    ['a relative cwd', { ...base, cwd: 'relative/path' }, 'target: claudeAgent haiku\ncwd: relative/path\n\nGo.'],
    ['an isolation that is not one', { ...base, isolation: 'copy' }, `${line()}isolation: copy\n\nGo.`],
    ['a role that is not one', { ...base, role: 'wizard' }, `${line()}role: wizard\n\nGo.`],
    ['no prompt', { target: 'claudeAgent', model: 'haiku', cwd: repo }, line()],
    ['an empty prompt', { ...base, prompt: '' }, line()],
    ['a prompt of only blanks', { ...base, prompt: ' \n\t ' }, line()],
  ]
  for (const [name, input, text] of cases) {
    const expected = parseTaskHeader(text)
    assert.ok('error' in expected, `${name}: the header parser refuses this too`)
    const answer = await server.call('delegate', input)
    assert.equal(answer.isError, true, name)
    assert.deepEqual(answer.json, expected, name)
  }
  assert.deepEqual((await server.call('delegate', {})).json, parseTaskHeader(''), 'an empty call reads as a header with nothing in it')

  const own = [
    ['a target that is not text', { ...base, target: 7 }, 'target must be text'],
    ['a prompt that is null', { ...base, prompt: null }, 'prompt must be text'],
    ['a cwd that is a list', { ...base, cwd: [repo] }, 'cwd must be text'],
    ['a target with a space', { ...base, target: 'claude Agent' }, 'target must be one word, without spaces or line breaks'],
    ['a model with a line break', { ...base, model: 'haiku\ncwd: /etc' }, 'model must be one word, without spaces or line breaks'],
    ['an effort with a space', { ...base, effort: 'very high' }, 'effort must be one word, without spaces or line breaks'],
    ['a cwd with a line break', { ...base, cwd: `${repo}\nrole: design` }, 'cwd must be on one line'],
    ['a role with a line break', { ...base, role: 'design\nisolation: shared' }, 'role must be on one line'],
    ['a questions value that is not one', { ...base, questions: 'ask' }, 'questions must be one of: parent, human.'],
    ['a field the tool does not have', { ...base, runtimeMode: 'auto' }, 'delegate has no field "runtimeMode"; its fields are target, model, effort, cwd, isolation, role, runtime, interaction, questions, prompt'],
    ['a sessionMode that is not text', { ...base, sessionMode: 7 }, 'sessionMode must be text; the cc-orq hook fills it, so leave it out'],
  ]
  for (const [name, input, message] of own) {
    const answer = await server.call('delegate', input)
    assert.equal(answer.isError, true, name)
    assert.deepEqual(answer.json, FAILURE('invalid_request', message), name)
  }

  const unknown = await server.call('delegate', { ...base, target: 'nope' })
  assert.deepEqual(unknown.json, FAILURE('provider_unavailable', 'Provider instance nope is not configured.'))
  const unsupported = await server.call('delegate', { ...base, target: 'opencode', model: 'fixture-model' })
  assert.deepEqual(
    unsupported.json,
    FAILURE('runtime_mode_unsupported', 'Driver opencode cannot enforce runtime mode auto-accept-edits; it supports approval-required, auto.'),
    'the refusal lists the modes the driver accepts',
  )
  assert.deepEqual(jobDirs(s), [], 'nothing was launched')
  assert.equal(server.garbage.length, 0)
})

test('delegate takes a prompt of at most 200,000 characters, counted as characters and not as UTF-16 units, and refuses more', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = startIn(s, session)
  t.after(() => server.close())
  const call = (prompt) => server.call('delegate', { target: 'nope', model: 'haiku', cwd: repo, prompt })
  const unknownInstance = FAILURE('provider_unavailable', 'Provider instance nope is not configured.')
  for (const [name, prompt] of [
    ['exactly 200,000 characters', 'x'.repeat(200000)],
    ['100,001 emoji, which are 200,002 UTF-16 units and 100,001 characters', '😀'.repeat(100001)],
    ['200,000 emoji, the most in characters', '😀'.repeat(200000)],
  ]) {
    assert.deepEqual((await call(prompt)).json, unknownInstance, `${name} goes on to the next check`)
  }
  for (const [name, prompt, count] of [
    ['one character over', 'x'.repeat(200001), 200001],
    ['an emoji over', '😀'.repeat(200001), 200001],
    ['a megabyte', 'y'.repeat(1_000_000), 1_000_000],
  ]) {
    const answer = await call(prompt)
    assert.equal(answer.isError, true, name)
    assert.deepEqual(answer.json, FAILURE('invalid_request', `prompt must be at most 200000 characters, got ${count}`), name)
  }
  assert.deepEqual(jobDirs(s), [], 'nothing was launched')
})

test('delegate refuses questions: human to a client that cannot show a form', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = startIn(s, session)
  t.after(() => server.close())
  for (const capabilities of [undefined]) {
    const answer = await server.call('delegate', { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Go.', questions: 'human' }, capabilities)
    assert.equal(answer.isError, true)
    assert.equal(answer.json.error.code, 'invalid_request')
    assert.equal(
      answer.json.error.message,
      'questions: human needs a client that declares MCP tasks and form input, such as the Claude Code CLI, and this one does not. Leave questions out, and a question the worker asks comes back to you in its result.',
    )
  }
  assert.deepEqual(jobDirs(s), [])
})

test('delegate above the ceiling is refused at once with the escalation code and what would lift it, and launches nothing', async (t) => {
  const s = scene({ instances: [{ id: 'claudeAgent', driver: 'claudeAgent' }] })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = startIn(s, session)
  t.after(() => server.close())
  const call = (extra) => server.call('delegate', { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Go.', ...extra })

  for (const sessionMode of ['default', 'manual']) {
    const answer = await call({ runtime: 'auto', sessionMode })
    assert.equal(answer.isError, true)
    assert.deepEqual(
      answer.json,
      FAILURE(
        'runtime_mode_escalation_denied',
        "Runtime mode auto is above the ceiling approval-required for this task: the config allows auto-accept-edits (ceiling.runtime) and the session's permission mode allows approval-required. " +
          'To allow auto, raise ceiling.runtime in ~/.config/orq/config.json and use a session permission mode that allows it; otherwise ask for approval-required at most.',
      ),
      sessionMode,
    )
  }
  const noSession = await call({ runtime: 'auto' })
  assert.deepEqual(
    noSession.json,
    FAILURE(
      'runtime_mode_escalation_denied',
      'Runtime mode auto is above the ceiling auto-accept-edits for this task: the config allows auto-accept-edits (ceiling.runtime). ' +
        'To allow auto, raise ceiling.runtime in ~/.config/orq/config.json; otherwise ask for auto-accept-edits at most.',
    ),
    'without a session mode the config alone refuses it',
  )
  const shared = await call({ runtime: 'auto-accept-edits', isolation: 'shared', sessionMode: 'auto' })
  assert.equal(shared.json.error.code, 'runtime_mode_escalation_denied')
  assert.ok(shared.json.error.message.includes('(ceiling.sharedRuntime)'), shared.json.error.message)
  assert.ok(shared.json.error.message.includes('raise ceiling.sharedRuntime in ~/.config/orq/config.json'))
  const plan = await call({ interaction: 'default', sessionMode: 'plan' })
  assert.equal(plan.json.error.code, 'interaction_mode_escalation_denied')
  assert.ok(plan.json.error.message.startsWith('Interaction mode default is above the ceiling plan for this task: '), plan.json.error.message)

  const forged = await call({ runtime: 'full-access', sessionMode: 'bypassPermissions' })
  assert.equal(forged.json.error.code, 'runtime_mode_escalation_denied', 'a forged mode cannot lift the ceiling above the config')
  assert.deepEqual(jobDirs(s), [], 'nothing was launched')
})

test('delegate holds cwd to the session directory and the allowed roots, and answers what the launch refuses as typed failures', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const elsewhere = join(s.root, 'elsewhere')
  mkdirSync(elsewhere)
  const plain = join(session, 'not-a-checkout')
  mkdirSync(plain)
  const server = startIn(s, session)
  t.after(() => server.close())
  const call = (extra) => server.call('delegate', { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Go.', ...extra })

  const outside = await call({ cwd: elsewhere })
  assert.deepEqual(outside.json, FAILURE('cwd_out_of_scope', `cwd ${elsewhere} is outside the session directory and the allowed roots (${session}).`))
  assert.deepEqual((await call({ cwd: join(session, 'missing') })).json, FAILURE('invalid_request', `directory does not exist: ${join(session, 'missing')}`))
  assert.deepEqual((await call({ cwd: join(repo, 'shared.txt') })).json, FAILURE('invalid_request', `not a directory: ${join(repo, 'shared.txt')}`))
  const notRepo = await call({ cwd: plain })
  assert.equal(notRepo.json.error.code, 'not_a_repository')
  assert.ok(notRepo.json.error.message.endsWith('Pass `isolation: shared` to run the task in this directory as it is.'), notRepo.json.error.message)
  assert.equal(notRepo.isError, true)

  const bare = s.start()
  t.after(() => bare.close())
  const noSessionDir = await bare.call('delegate', { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Go.' })
  assert.deepEqual(noSessionDir.json, FAILURE('cwd_out_of_scope', `cwd ${repo} is outside the session directory and the allowed roots (none).`), 'without CLAUDE_PROJECT_DIR only allowedRoots count')
  s.setConfig({ allowedRoots: [session] })
  const roots = await bare.call('delegate', { target: 'claudeAgent', model: 'haiku', cwd: plain, prompt: 'Go.' })
  assert.equal(roots.json.error.code, 'not_a_repository', 'an allowed root lets the call past the scope check, to the refusal that comes after it')
})

test('delegate launches through a fake worker, answers running at once, and leaves a job of kind mcp that status, list and integrate read', async (t) => {
  const s = scene({ bin: { claude: FAKE_HELD_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = startIn(s, session)
  t.after(() => server.close())
  const statusOf = (taskId) => server.call('status', { taskId })

  const answer = await server.call('delegate', { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Add a file and commit it.', sessionMode: 'acceptEdits' }, NO_TASKS)
  assert.equal(answer.isError, false, answer.text)
  assert.deepEqual(Object.keys(answer.json), ['taskId', 'status'])
  assert.equal(answer.json.status, 'running')
  const taskId = answer.json.taskId
  assert.match(taskId, /^mcp-\d+-[0-9a-z]+-[0-9a-z]+$/)
  assert.equal((await statusOf(taskId)).json.status, 'running', 'the worker is held, so the job is running when delegate has answered')
  writeFileSync(join(s.jobsDir, taskId, 'go'), '')

  const dir = join(s.jobsDir, taskId)
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.kind, 'mcp')
  assert.equal(meta.agentId, SESSION_ID)
  assert.equal(meta.questions, 'parent')
  assert.equal(meta.instanceId, 'claudeAgent')
  assert.equal(meta.driver, 'claudeAgent')
  assert.equal(meta.model, 'haiku')
  assert.equal(meta.runtimeMode, 'auto-accept-edits')
  assert.equal(meta.interactionMode, 'default')
  assert.equal(meta.branch, `orq/${taskId}`)
  assert.equal(meta.repo, repo)
  assert.equal(readFileSync(join(dir, 'flags'), 'utf8'), '--permission-mode\nacceptEdits\n')
  assert.ok(readFileSync(join(dir, 'prompt.txt'), 'utf8').startsWith('Add a file and commit it.'))

  const ended = await untilEnded(statusOf, taskId)
  assert.equal(ended.status, 'completed')
  assert.equal(ended.kind, 'mcp')
  assert.ok(ended.result.startsWith('FAKE-WORKER'), ended.result)
  const argv = readFileSync(join(dir, 'argv.txt'), 'utf8').split('\n')
  assert.deepEqual(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2), ['--permission-mode', 'acceptEdits'], 'the CLI got the flag')

  const listed = (await server.call('list')).json.jobs.find((row) => row.taskId === taskId)
  assert.equal(listed.kind, 'mcp')
  assert.equal(listed.status, 'completed')
  assert.equal(listed.instanceId, 'claudeAgent')
  assert.equal(listed.branch, `orq/${taskId}`)
  const merged = await server.call('integrate', { taskId })
  assert.equal(merged.isError, false, merged.text)
  assert.equal(merged.json.ok, true)
  assert.equal(readFileSync(join(repo, `${taskId}.txt`), 'utf8'), 'worker output\n')
})

test('a job that delegate launches records the session id as its agentId, and mcp when the server has none', async (t) => {
  const s = scene({ bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const input = { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Go.' }
  const withSession = startIn(s, session)
  t.after(() => withSession.close())
  const withoutSession = startIn(s, session, { CLAUDE_CODE_SESSION_ID: '' })
  t.after(() => withoutSession.close())
  const first = (await withSession.call('delegate', input, NO_TASKS)).json.taskId
  const second = (await withoutSession.call('delegate', input, NO_TASKS)).json.taskId
  const agentOf = (taskId) => JSON.parse(readFileSync(join(s.jobsDir, taskId, 'meta.json'), 'utf8')).agentId
  assert.equal(agentOf(first), SESSION_ID)
  assert.equal(agentOf(second), 'mcp')
  for (const [server, taskId] of [[withSession, first], [withoutSession, second]]) {
    assert.equal((await untilEnded((id) => server.call('status', { taskId: id }), taskId)).status, 'completed')
  }
})

test('under "ceiling": {"runtime": "auto"} and a session in auto mode, a delegate to the claudeAgent instance runs with the auto policy', async (t) => {
  const s = scene({ bin: { claude: FAKE_WORKER } })
  s.setConfig({ ceiling: { runtime: 'auto' } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = startIn(s, session)
  t.after(() => server.close())
  const input = { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Go.' }
  const flagsOf = (answer) => readFileSync(join(s.jobsDir, answer.json.taskId, 'flags'), 'utf8')
  const metaOf = (answer) => JSON.parse(readFileSync(join(s.jobsDir, answer.json.taskId, 'meta.json'), 'utf8'))

  const asked = await server.call('delegate', { ...input, runtime: 'auto', sessionMode: 'auto' }, NO_TASKS)
  assert.equal(asked.isError, false, asked.text)
  assert.equal(flagsOf(asked), '--permission-mode\nauto\n')
  assert.equal(metaOf(asked).runtimeMode, 'auto')

  const inherited = await server.call('delegate', { ...input, sessionMode: 'auto' }, NO_TASKS)
  assert.equal(flagsOf(inherited), '--permission-mode\nauto\n', 'a runtime left out inherits the effective ceiling')

  const configAlone = await server.call('delegate', { ...input, runtime: 'auto' }, NO_TASKS)
  assert.equal(flagsOf(configAlone), '--permission-mode\nauto\n', 'without a session mode the config alone decides')

  const lowered = await server.call('delegate', { ...input, sessionMode: 'acceptEdits' }, NO_TASKS)
  assert.equal(flagsOf(lowered), '--permission-mode\nacceptEdits\n', 'the session mode lowers what the config allows')

  const stricter = await server.call('delegate', { ...input, runtime: 'approval-required', sessionMode: 'auto' }, NO_TASKS)
  assert.equal(flagsOf(stricter), '--permission-mode\nmanual\n', 'a task may ask for less than the ceiling')

  const ended = async (answer) => (await untilEnded((id) => server.call('status', { taskId: id }), answer.json.taskId)).status
  for (const answer of [asked, inherited, configAlone, lowered, stricter]) assert.equal(await ended(answer), 'completed')

  // A shared launch is refused while a live job holds the checkout, so it goes last, once the worktree jobs have ended.
  const shared = await server.call('delegate', { ...input, isolation: 'shared', sessionMode: 'auto' }, NO_TASKS)
  assert.equal(shared.isError, false, shared.text)
  assert.equal(flagsOf(shared), '--permission-mode\nmanual\n', 'a shared task keeps the sharedRuntime limit, approval-required')
  assert.equal(metaOf(shared).worktree, undefined)
  assert.equal(await ended(shared), 'completed')
})

// ---------------------------------------------------------------------------------------------------------------------
// The tasks/* methods, and what the server reads of the client.

test('tasks/get, tasks/update and tasks/cancel answer -32021 without the extension, with the capability they need', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
    const answer = await server.request(method, { taskId: 'task-1', ...modern({ elicitation: { form: {} } }) })
    assert.equal(answer.error.code, -32021, method)
    assert.deepEqual(answer.error.data, { requiredCapabilities: { extensions: { [TASKS]: {} } } })
    assert.equal(answer.result, undefined)
  }
  const bare = await server.request('tasks/get', { taskId: 'task-1', ...modern({}) })
  assert.equal(bare.error.code, -32021)
})

test('tasks/get, tasks/update and tasks/cancel answer -32602 for an id that names no task, and for an unsafe one', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  const request = { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 'x', ...modern() } }
  conforms(GetTaskRequestV2Schema, request, 'the tasks/get request this test sends')
  for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
    for (const taskId of ['task-unknown', '../escape', '']) {
      const answer = await server.request(method, { taskId, ...modern() })
      assert.equal(answer.error.code, -32602, `${method} ${JSON.stringify(taskId)}`)
      assert.match(answer.error.message, /Task not found$/)
    }
  }
})

test('a legacy session has not declared the tasks extension, so tasks/get answers -32021', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const server = s.start()
  t.after(() => server.close())
  await server.request('initialize', LEGACY_INIT)
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const answer = await server.request('tasks/get', { taskId: 'task-1' })
  assert.equal(answer.error.code, -32021)
})

test('clientInfoOf reads the tasks extension and the form capability from the envelope the SDK hands over', () => {
  const key = 'io.modelcontextprotocol/clientCapabilities'
  const both = { [key]: { elicitation: { form: {}, url: {} }, extensions: { [TASKS]: {} } } }
  assert.deepEqual(clientInfoOf(both), { tasks: true, forms: true })
  assert.deepEqual(clientInfoOf({ [key]: { extensions: { [TASKS]: {} } } }), { tasks: true, forms: false })
  assert.deepEqual(clientInfoOf({ [key]: { elicitation: { form: {} } } }), { tasks: false, forms: true })
  assert.deepEqual(clientInfoOf({ [key]: { elicitation: {}, extensions: { 'other/extension': {} } } }), { tasks: false, forms: true }, 'an elicitation capability with no mode is form mode')
  assert.deepEqual(clientInfoOf({ [key]: { elicitation: { url: {} }, extensions: { [TASKS]: {} } } }), { tasks: true, forms: false })
  assert.deepEqual(clientInfoOf({ [key]: { extensions: { [TASKS]: null } } }), { tasks: false, forms: false })
  assert.deepEqual(clientInfoOf({ [key]: { extensions: { [TASKS]: true } } }), { tasks: false, forms: false })
  for (const absent of [undefined, null, {}, 'envelope', 7, [], { [key]: null }, { [key]: 'x' }, { [key]: {} }]) {
    assert.deepEqual(clientInfoOf(absent), { tasks: false, forms: false }, JSON.stringify(absent))
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// The Node version gate

test('a Node older than 22.18 is refused with one line, and 22.18.0 and newer are not', () => {
  assert.equal(nodeVersionRefusal('22.17.0'), 'cc-orq: the orq server needs Node 22.18 or newer, found 22.17.0')
  for (const old of ['22.17.9', '22.0.0', '20.19.0', '21.7.3', '18.20.4', '22.9.0']) {
    assert.equal(nodeVersionRefusal(old), `cc-orq: the orq server needs Node 22.18 or newer, found ${old}`, old)
  }
  for (const fine of ['22.18.0', '22.18.1', '22.22.1', '22.100.0', '23.0.0', '24.0.0', '24.12.1', '22.18.0-nightly20250101']) {
    assert.equal(nodeVersionRefusal(fine), null, fine)
  }
  assert.match(nodeVersionRefusal('not-a-version') ?? '', /found not-a-version$/)
})

test('server/main.mjs on a Node that reports 22.17.0 writes the refusal to stderr, nothing to stdout, and exits 1', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'orq-version-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const preload = join(dir, 'old-node.mjs')
  writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: '22.17.0' })\n")
  const run = spawnSync(process.execPath, ['--import', preload, MAIN], { encoding: 'utf8', input: '', timeout: 20000 })
  assert.equal(run.status, 1)
  assert.equal(run.stderr.trim().split('\n').filter((line) => line.startsWith('cc-orq:')).join('\n'), 'cc-orq: the orq server needs Node 22.18 or newer, found 22.17.0')
  assert.equal(run.stdout, '')
})

// ---------------------------------------------------------------------------------------------------------------------
// The process: stdout, and how it ends

test('stdout carries JSON-RPC and nothing else over a whole session, errors and refusals included', async (t) => {
  const s = scene({ bin: { claude: '#!/bin/bash\nexit 0\n' } })
  t.after(() => s.cleanup())
  job(s.jobsDir, 'job-ok', { files: { exit: '0', 'last.txt': 'OK' }, exitAt: SECOND + 1 })
  const server = s.start()
  await server.request('server/discover', modern())
  await server.request('tools/list', modern())
  await server.call('capabilities')
  await server.call('list')
  await server.call('status', { taskId: 'job-ok' })
  await server.call('status', { taskId: 'missing' })
  await server.call('cancel', { taskId: 'job-ok' })
  await server.call('integrate', { taskId: 'job-ok' })
  await server.request('tasks/get', { taskId: 'x', ...modern({}) })
  await server.request('no/such-method', modern())
  server.child.stdin.write('this is not JSON\n')
  await server.request('tools/list', modern())
  const ended = await server.close()
  assert.equal(ended.code, 0)
  assert.deepEqual(server.garbage, [], 'every stdout line is JSON')
  for (const message of server.messages) assert.equal(message.jsonrpc, '2.0')
  assert.equal(server.messages.length, 11, 'one answer for each of the eleven requests, and none for the line that is not JSON')
})

test('no module the server loads writes to stdout, apart from the transport of the SDK', () => {
  const sources = [
    ...readdirSync(join(REPO, 'server')).filter((name) => /\.(?:ts|mjs)$/.test(name)).map((name) => join(REPO, 'server', name)),
    ...readdirSync(join(REPO, 'hooks')).filter((name) => name.endsWith('.ts')).map((name) => join(REPO, 'hooks', name)),
  ]
  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    assert.equal(/console\.(?:log|info|debug)\b|process\.stdout|\bprintf?\(/.test(text), false, `${file} writes to stdout`)
  }
  const vendor = readFileSync(join(REPO, 'server', 'vendor', 'mcp-sdk.mjs'), 'utf8')
  assert.equal(/console\.(?:log|info|debug)\b/.test(vendor), false, 'the SDK bundle logs to stdout')
  assert.equal(vendor.match(/process\.stdout/g)?.length, 1, 'only the stdio transport of the SDK touches stdout')
})

// Spelled in parts, so that this file is not a match of its own search.
const OLD_PREFIX = ['mcp', 'cc-orq', ''].join('__')

test('no text that names a tool uses the old prefix, except for the wait tool the mod still serves', (t) => {
  // The live harness names the prefix to assert that no mod tool appears when mods are off.
  const found = spawnSync('git', ['grep', '-n', OLD_PREFIX, '--', '.', ':!CHANGELOG.md', ':!tests/live'], { cwd: REPO, encoding: 'utf8' })
  if (found.status !== 0 && found.status !== 1) return t.skip('not inside a git checkout, so there are no tracked files to search')
  const stale = found.stdout.split('\n').filter((line) => line !== '' && line.replaceAll(`${OLD_PREFIX}wait`, '').includes(OLD_PREFIX))
  assert.deepEqual(stale, [])
})

test('the server exits promptly on stdin EOF even while a catalog probe is still running', async (t) => {
  const s = scene({ instances: [{ id: 'codex', driver: 'codex' }] })
  const started = join(s.root, 'probe-started')
  const pids = join(s.root, 'probe-pids')
  writeFileSync(join(s.root, 'bin', 'codex'), ['#!/bin/bash', `echo $$ >> '${pids}'`, `touch '${started}'`, 'exec sleep 30', ''].join('\n'))
  chmodSync(join(s.root, 'bin', 'codex'), 0o755)
  t.after(() => {
    for (const pid of existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean) : []) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    s.cleanup()
  })
  const server = s.start()
  void server.call('capabilities').catch(() => undefined)
  for (let waited = 0; !existsSync(started); waited += 50) {
    assert.ok(waited < 10000, 'the probe never started')
    await new Promise((done) => setTimeout(done, 50))
  }
  const closedAt = Date.now()
  assert.deepEqual(await server.close(), { code: 0, signal: null })
  assert.ok(Date.now() - closedAt < 4000, `the server took ${Date.now() - closedAt} ms to exit`)
})

test('the server exits on stdin EOF, SIGTERM and SIGINT, and leaves a detached worker running', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const worker = s.liveGroup()
  const alive = () => {
    try {
      process.kill(worker, 0)
      return true
    } catch {
      return false
    }
  }
  job(s.jobsDir, 'job-run', { startedAt: Date.now() - 1000, files: { pgid: String(worker) } })

  const eof = s.start()
  assert.equal((await eof.call('status', { taskId: 'job-run' })).json.status, 'running')
  assert.deepEqual(await eof.close(), { code: 0, signal: null })

  for (const signal of ['SIGTERM', 'SIGINT']) {
    const server = s.start()
    await server.request('server/discover', modern())
    server.child.kill(signal)
    const timer = setTimeout(() => server.child.kill('SIGKILL'), 5000)
    const ended = await server.exited
    clearTimeout(timer)
    assert.deepEqual(ended, { code: 0, signal: null }, signal)
  }
  assert.equal(alive(), true, 'the worker is still there after three server exits')
})
