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
const TOOLS = ['capabilities', 'status', 'list', 'cancel', 'integrate']

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

test('tools/list lists exactly the five tools, with the input schemas of 0.1 and the new list', async (t) => {
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
  assert.deepEqual(schemas.capabilities, { type: 'object', properties: {}, required: [], additionalProperties: false })
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
  assert.equal(schemas.list.properties.limit.type, 'integer')
  assert.equal(schemas.list.properties.limit.minimum, 1)
  assert.equal(schemas.list.properties.limit.maximum, 50)
  assert.equal(schemas.list.required, undefined)
  for (const tool of result.tools) assert.ok(tool.description.length > 40, `${tool.name} has a description`)
  const described = Object.fromEntries(result.tools.map((tool) => [tool.name, tool.description]))
  assert.ok(described.integrate.includes('redelegate a rebase to the same worker, then integrate again'))
  assert.ok(described.integrate.includes('uncommitted work in the task worktree is not'))
  assert.ok(described.capabilities.includes('approval-required and default'), 'the description says what the modes are until the session mode reaches the server')
  assert.ok(described.capabilities.includes('do not follow the session yet'))
})

test('server/instructions.md is under 4,000 bytes and names each of the five tools, and none that does not exist yet', () => {
  assert.ok(Buffer.byteLength(INSTRUCTIONS) < 4000, `${Buffer.byteLength(INSTRUCTIONS)} bytes`)
  for (const tool of TOOLS) assert.ok(INSTRUCTIONS.includes(`\`${tool}\``), `the instructions name ${tool}`)
  for (const advice of ['not_fast_forward', 'merge_conflict']) assert.ok(INSTRUCTIONS.includes(advice), advice)
  assert.equal(/`(?:delegate|answer)`/.test(INSTRUCTIONS), false)
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
    result: 'BLOCKED on a question (taskId job-blk): Which branch?\n\nAnswer it in a new cc-orq:task with the original brief plus the answer.',
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

test('capabilities answers the CapabilitiesResult shape of 0.1, with the modes of an unknown session mode', async (t) => {
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
    runtimeMode: 'approval-required',
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
  })
  assert.deepEqual(
    { runtimeMode: answer.json.runtimeMode, interactionMode: answer.json.interactionMode },
    parentRuntimeModeFromPermissionMode(undefined),
  )
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

test('tasks/get, tasks/update and tasks/cancel answer -32602 for any id when the extension is declared', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  job(s.jobsDir, 'job-real', { files: { exit: '0', 'last.txt': 'OK' }, exitAt: SECOND + 1 })
  const server = s.start()
  t.after(() => server.close())
  const request = { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 'x', ...modern() } }
  conforms(GetTaskRequestV2Schema, request, 'the tasks/get request this test sends')
  for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
    for (const taskId of ['task-unknown', 'job-real']) {
      const answer = await server.request(method, { taskId, ...modern() })
      assert.equal(answer.error.code, -32602, `${method} ${taskId}`)
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
  assert.deepEqual(clientInfoOf({ [key]: { elicitation: {}, extensions: { 'other/extension': {} } } }), { tasks: false, forms: false })
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
  const found = spawnSync('git', ['grep', '-n', OLD_PREFIX, '--', '.', ':!CHANGELOG.md'], { cwd: REPO, encoding: 'utf8' })
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
