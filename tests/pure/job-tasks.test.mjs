// The tasks that delegate creates, read from synthetic job directories: one case for each row of the derivation of
// spec 4.4, then the approval flow of D7 (create, accept, decline, cancel, refuse) against a fake worker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { defaultConfig } from '../../hooks/config.ts'
import { TaskNotFound } from '../../server/protocol.ts'
import { jobTasks } from '../../server/job-tasks.ts'
import { nodeEngine } from '../../server/node-engine.ts'
import { FAKE_HELD_WORKER, FAKE_WORKER, REPO, SECOND, SESSION_ID, checkout, job, jobDirs, scene } from './support/harness.mjs'

const CLIENT = { tasks: true, forms: true }
const ISO = (seconds) => new Date(seconds * 1000).toISOString()

/** A scene, the task source over its jobs directory, and writers for the files of a task. */
function setup({ bin = {}, instances } = {}) {
  const s = scene({ bin, ...(instances ? { instances } : {}) })
  const { session, repo } = checkout(s)
  const engine = nodeEngine({ env: { ...s.env, CLAUDE_PROJECT_DIR: session, CLAUDE_CODE_SESSION_ID: SESSION_ID }, pluginRoot: REPO })
  const config = { ...defaultConfig(s.home), jobsDir: s.jobsDir, instances: [{ id: 'claudeAgent', driver: 'claudeAgent' }, ...(instances ?? [])] }
  const tasks = jobTasks(engine, async () => config)
  const taskDir = (id) => join(s.jobsDir, '.tasks', id)
  const record = (taskId, extra = {}) => {
    mkdirSync(taskDir(taskId), { recursive: true })
    writeFileSync(
      join(taskDir(taskId), 'task.json'),
      JSON.stringify({ taskId, createdAt: ISO(SECOND), tool: 'delegate', questions: 'parent', request: { target: 'codex', model: 'm', cwd: '/work', prompt: 'p' }, ...extra }),
    )
  }
  const mark = (taskId, name, text = '') => writeFileSync(join(taskDir(taskId), name), text)
  return { s, session, repo, engine, config, tasks, taskDir, record, mark }
}

const ESCALATION = {
  error: { code: 'runtime_mode_escalation_denied', message: 'Runtime mode auto is above the ceiling approval-required for this task.' },
}
const APPROVAL = {
  target: 'codex',
  model: 'gpt-x',
  cwd: '/work/repo',
  isolation: 'worktree',
  launch: { runtimeMode: 'auto', interactionMode: 'default' },
  config: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
  session: { runtimeMode: 'approval-required', interactionMode: 'default' },
  refusal: ESCALATION,
}

// ---------------------------------------------------------------------------------------------------------------------
// Row 1: no .tasks/ID, but a job with that id. The state comes from the job alone.

test('a job with no task record is read from the job alone: working while its supervisor lives, and while it waits or cancels', async (t) => {
  const { s, tasks } = setup()
  t.after(() => s.cleanup())
  const pgid = String(s.liveGroup())
  const startedAt = Date.now() - 135_000
  const events = ['{"type":"system","subtype":"init"}', '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the files"}]}}'].join('\n')
  job(s.jobsDir, 'job-live', { startedAt, files: { pgid, 'events.jsonl': events } })

  const task = await tasks.get('job-live')
  assert.equal(task.status, 'working')
  assert.match(task.statusMessage, /^codex · fixture-model · msg Reading the files · 2m1\ds$/, 'the instance, the model, the last action and the duration')
  assert.equal(task.createdAt, new Date(startedAt).toISOString())
  assert.ok(Date.parse(task.lastUpdatedAt) >= Date.parse(task.createdAt), 'the last update is not before the creation')

  job(s.jobsDir, 'job-waiting', { files: { pgid, 'question.txt': 'Which branch?' } })
  job(s.jobsDir, 'job-cancelling', { files: { pgid, cancel: 'cancelled' } })
  for (const id of ['job-waiting', 'job-cancelling']) assert.equal((await tasks.get(id)).status, 'working', id)
})

test('lastUpdatedAt is the newest mtime of the job files', async (t) => {
  const { s, tasks } = setup()
  t.after(() => s.cleanup())
  const dir = job(s.jobsDir, 'job-times', { files: { pgid: String(s.liveGroup()), 'events.jsonl': '' } })
  utimesSync(join(dir, 'meta.json'), SECOND + 10, SECOND + 10)
  utimesSync(join(dir, 'events.jsonl'), SECOND + 90, SECOND + 90)
  const task = await tasks.get('job-times')
  assert.equal(task.createdAt, ISO(SECOND))
  assert.equal(task.lastUpdatedAt, ISO(SECOND + 90))
})

test('a job with no task record ends as completed with the text of the 0.1 answer, and isError for a worker that failed or was lost', async (t) => {
  const { s, tasks } = setup()
  t.after(() => s.cleanup())
  const dead = String(await s.deadGroup())
  job(s.jobsDir, 'job-done', { files: { exit: '0', 'last.txt': 'All done.' }, exitAt: SECOND + 125 })
  job(s.jobsDir, 'job-failed', { files: { exit: '1', 'last.txt': '', 'stderr.txt': 'boom: it broke\n' }, exitAt: SECOND + 20 })
  job(s.jobsDir, 'job-lost', { files: { pgid: dead } })
  job(s.jobsDir, 'job-asked', { files: { exit: '0', 'question.txt': 'Which branch?' }, exitAt: SECOND + 20 })

  const done = await tasks.get('job-done')
  assert.equal(done.status, 'completed')
  assert.equal(done.result.isError, false)
  assert.match(done.result.content[0].text, /^All done\.\n\n— orq · manual · fixture-model · effort n\/a · 2m05s · tokens n\/a · taskId job-done · session job-done$/)
  assert.match(done.statusMessage, /^codex · fixture-model · finished · 2m05s$/)

  const failed = await tasks.get('job-failed')
  assert.equal(failed.status, 'completed', 'a worker that fails is a completed task whose result is an error, not a failed task')
  assert.equal(failed.result.isError, true)
  assert.equal(failed.result.content[0].text, 'orq: job-failed failed (exit 1)\nboom: it broke')

  const lost = await tasks.get('job-lost')
  assert.equal(lost.status, 'completed')
  assert.equal(lost.result.isError, true)
  assert.equal(lost.result.content[0].text, 'orq: job-lost was interrupted: its supervisor is gone and it left no exit file')

  const asked = await tasks.get('job-asked')
  assert.equal(asked.status, 'completed', 'in parent mode a question ends the task')
  assert.equal(asked.result.isError, false)
  assert.match(asked.result.content[0].text, /^BLOCKED on a question \(taskId job-asked\): Which branch\?/)
  assert.match(asked.statusMessage, /blocked on a question/)
})

test('a job that exited 124 is a cancelled task', async (t) => {
  const { s, tasks } = setup()
  t.after(() => s.cleanup())
  job(s.jobsDir, 'job-stopped', { files: { exit: '124', cancel: 'cancelled' }, exitAt: SECOND + 7 })
  const task = await tasks.get('job-stopped')
  assert.equal(task.status, 'cancelled')
  assert.equal('result' in task, false)
  assert.match(task.statusMessage, /cancelled/)
})

test('an id that names no task or job, or that is not a safe id, is TaskNotFound', async (t) => {
  const { s, tasks, record } = setup()
  t.after(() => s.cleanup())
  record('task-gone')
  for (const id of ['nothing-here', '../escape', '', '.tasks', 'a/b']) {
    await assert.rejects(() => tasks.get(id), TaskNotFound, JSON.stringify(id))
    await assert.rejects(() => tasks.update(id, {}), TaskNotFound)
    await assert.rejects(() => tasks.cancel(id), TaskNotFound)
  }
  await assert.rejects(() => tasks.get('task-gone'), TaskNotFound, 'a task with no approval and no job has lost its job')
})

// ---------------------------------------------------------------------------------------------------------------------
// Row 2: cancelled is present.

test('a cancelled marker makes the task cancelled before anything else, a live job included', async (t) => {
  const { s, tasks, record, mark } = setup()
  t.after(() => s.cleanup())
  record('task-form', { approval: APPROVAL })
  mark('task-form', 'cancelled')
  assert.equal((await tasks.get('task-form')).status, 'cancelled')

  job(s.jobsDir, 'task-started', { files: { pgid: String(s.liveGroup()) } })
  record('task-started')
  mark('task-started', 'cancelled')
  const task = await tasks.get('task-started')
  assert.equal(task.status, 'cancelled')
  assert.equal(task.statusMessage, 'cancelled')
})

// ---------------------------------------------------------------------------------------------------------------------
// Row 3: an approval that is pending, declined or refused.

test('a task with an approval and no answer is input_required, with one flat form under the key approve', async (t) => {
  const { s, tasks, record } = setup()
  t.after(() => s.cleanup())
  record('task-form', { approval: APPROVAL })
  const task = await tasks.get('task-form')
  assert.equal(task.status, 'input_required')
  assert.equal(task.createdAt, ISO(SECOND))
  assert.deepEqual(Object.keys(task.inputRequests), ['approve'])
  const { method, params } = task.inputRequests.approve
  assert.equal(method, 'elicitation/create')
  assert.equal(params.mode, 'form')
  assert.equal(
    params.message,
    [
      'A task asks for more than your ceiling allows: runtime auto.',
      'It runs in its own worktree.',
      'Worker "codex", model "gpt-x", directory "/work/repo".',
    ].join('\n'),
    'three lines, because Claude Code collapses the rest of a message',
  )
  assert.deepEqual(params.requestedSchema, {
    type: 'object',
    properties: {
      approve: {
        type: 'boolean',
        title: 'Allow in its own worktree, this task only',
        description: "runtime auto is above ceiling.runtime auto-accept-edits and the session's permission mode approval-required.",
        default: true,
      },
    },
    required: ['approve'],
  })
  assert.ok(params.requestedSchema.properties.approve.title.length <= 46, 'Claude Code cuts a title at about 47 characters')
  assert.equal(task.statusMessage, 'waiting for your approval to go above the ceiling')
})

test('the form says where the task runs, in words, and names the limit that a shared task exceeds', async (t) => {
  const { s, tasks, record } = setup()
  t.after(() => s.cleanup())
  record('task-shared', {
    approval: { ...APPROVAL, isolation: 'shared', config: { runtimeMode: 'approval-required', interactionMode: 'default' }, session: null },
  })
  const { params } = (await tasks.get('task-shared')).inputRequests.approve
  const lines = params.message.split('\n')
  assert.equal(lines[1], 'It runs in your checkout itself (shared, no worktree).')
  assert.equal(params.requestedSchema.properties.approve.title, 'Allow in your checkout itself, this task only')
  assert.ok(params.requestedSchema.properties.approve.title.length <= 46)
  assert.equal(params.requestedSchema.properties.approve.description, 'runtime auto is above ceiling.sharedRuntime approval-required.', 'with no session mode the config alone is named')
})

test('a form for a request above both ceilings names both levels and both limits', async (t) => {
  const { s, tasks, record } = setup()
  t.after(() => s.cleanup())
  record('task-both', {
    approval: {
      ...APPROVAL,
      launch: { runtimeMode: 'full-access', interactionMode: 'default' },
      config: { runtimeMode: 'auto', interactionMode: 'plan' },
      session: null,
    },
  })
  const { params } = (await tasks.get('task-both')).inputRequests.approve
  assert.equal(params.message.split('\n')[0], 'A task asks for more than your ceiling allows: runtime full-access and interaction default.')
  assert.equal(
    params.requestedSchema.properties.approve.description,
    'runtime full-access is above ceiling.runtime auto; interaction default is above ceiling.interaction plan.',
  )
})

test('the description names only the limits that are below the level, so a limit that allows it is not called a limit in the way', async (t) => {
  const { s, tasks, record } = setup()
  t.after(() => s.cleanup())
  const equal = { runtimeMode: 'auto-accept-edits', interactionMode: 'default' }
  record('task-session', { approval: { ...APPROVAL, launch: equal, config: equal, session: { runtimeMode: 'approval-required', interactionMode: 'default' } } })
  record('task-config', { approval: { ...APPROVAL, launch: equal, config: { runtimeMode: 'approval-required', interactionMode: 'default' }, session: equal } })
  record('task-neither-named-twice', { approval: { ...APPROVAL, launch: equal, config: { runtimeMode: 'approval-required', interactionMode: 'default' }, session: { runtimeMode: 'approval-required', interactionMode: 'default' } } })
  const description = async (id) => (await tasks.get(id)).inputRequests.approve.params.requestedSchema.properties.approve.description
  assert.equal(await description('task-session'), "runtime auto-accept-edits is above the session's permission mode approval-required.")
  assert.equal(await description('task-config'), 'runtime auto-accept-edits is above ceiling.runtime approval-required.')
  assert.equal(
    await description('task-neither-named-twice'),
    "runtime auto-accept-edits is above ceiling.runtime approval-required and the session's permission mode approval-required.",
  )
})

test('a declined form ends the task as completed with the escalation error that the request got', async (t) => {
  const { s, tasks, record, mark } = setup()
  t.after(() => s.cleanup())
  record('task-no', { approval: APPROVAL })
  mark('task-no', 'declined')
  const task = await tasks.get('task-no')
  assert.equal(task.status, 'completed')
  assert.equal(task.result.isError, true)
  assert.deepEqual(JSON.parse(task.result.content[0].text), ESCALATION)
})

test('a launch that was refused after the approval ends the task as completed with the refusal', async (t) => {
  const { s, tasks, record, mark } = setup()
  t.after(() => s.cleanup())
  record('task-refused', { approval: APPROVAL })
  mark('task-refused', 'approved')
  assert.equal((await tasks.get('task-refused')).status, 'working', 'approved with no job yet is a launch that is starting')
  assert.equal((await tasks.get('task-refused')).statusMessage, 'starting after your approval')
  mark('task-refused', 'refused', '{"error":{"code":"worktree_busy","message":"busy"}}')
  const task = await tasks.get('task-refused')
  assert.equal(task.status, 'completed')
  assert.equal(task.result.isError, true)
  assert.equal(task.result.content[0].text, '{"error":{"code":"worktree_busy","message":"busy"}}')
})

// ---------------------------------------------------------------------------------------------------------------------
// Row 4: the chain from the job of the task.

test('a task with a job follows the job, and a job that exists wins over a refusal that was written late', async (t) => {
  const { s, tasks, record, mark } = setup()
  t.after(() => s.cleanup())
  job(s.jobsDir, 'task-run', { meta: { kind: 'mcp' }, files: { pgid: String(s.liveGroup()) } })
  record('task-run')
  mark('task-run', 'approved')
  mark('task-run', 'refused', 'a refusal that arrived after the launch')
  const task = await tasks.get('task-run')
  assert.equal(task.status, 'working')
  assert.equal(task.createdAt, ISO(SECOND), 'the creation time is the task record\'s')
})

test('the result of a finished worktree job also names its branch and the integrate call, and a job with no branch does not', async (t) => {
  const { s, tasks, record } = setup()
  t.after(() => s.cleanup())
  job(s.jobsDir, 'task-wt', {
    meta: { kind: 'mcp', branch: 'orq/task-wt', repo: '/work', worktree: '/work-wt/task-wt' },
    files: { exit: '0', 'last.txt': 'Done in a branch.' },
    exitAt: SECOND + 60,
  })
  job(s.jobsDir, 'task-shared', { meta: { kind: 'mcp' }, files: { exit: '0', 'last.txt': 'Done in place.' }, exitAt: SECOND + 60 })
  record('task-wt')
  record('task-shared')
  const wt = (await tasks.get('task-wt')).result.content[0].text
  assert.ok(wt.startsWith('Done in a branch.\n\n— orq · mcp'), wt)
  assert.ok(wt.endsWith('\n\nBranch orq/task-wt. Merge it with integrate: {"taskId": "task-wt"}'), wt)
  const shared = (await tasks.get('task-shared')).result.content[0].text
  assert.equal(shared.includes('integrate'), false)
})

test('a result over 100 KB is cut, and the answer says where the whole text is', async (t) => {
  const { s, tasks, record } = setup()
  t.after(() => s.cleanup())
  job(s.jobsDir, 'task-big', { meta: { kind: 'mcp' }, files: { exit: '0', 'last.txt': 'é'.repeat(150_000) }, exitAt: SECOND + 60 })
  record('task-big')
  const { text } = (await tasks.get('task-big')).result.content[0]
  assert.ok(Buffer.byteLength(text) <= 100 * 1024 + 200, `${Buffer.byteLength(text)} bytes`)
  assert.ok(text.includes('[cut at 100 KB: the full text is in last.txt'), 'the cut says where the whole text is')
  assert.equal(text.includes('�'), false, 'the cut does not split a character')
  assert.equal(readFileSync(join(s.jobsDir, 'task-big', 'last.txt'), 'utf8').length, 150_000, 'last.txt keeps the whole text')
})

test('a task record that cannot be read is a failed task with -32603 inline, and the failure is terminal', async (t) => {
  const { s, tasks, taskDir } = setup()
  t.after(() => s.cleanup())
  mkdirSync(taskDir('task-bad'), { recursive: true })
  writeFileSync(join(taskDir('task-bad'), 'task.json'), '{"taskId": "task-bad", "createdAt": ')
  const task = await tasks.get('task-bad')
  assert.equal(task.status, 'failed')
  assert.equal(task.error.code, -32603)
  assert.equal(typeof task.error.message, 'string')
  writeFileSync(join(taskDir('task-bad'), 'task.json'), JSON.stringify({ taskId: 'someone-else', createdAt: ISO(SECOND), tool: 'delegate', questions: 'parent', request: {} }))
  assert.equal((await tasks.get('task-bad')).status, 'failed', 'a record of another task is not this task')
})

// ---------------------------------------------------------------------------------------------------------------------
// create: what delegate does with a request, by what the client can do.

const REQUEST = (repo, more = {}) => ({ target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Go.', ...more })

test('create launches within the ceiling and answers the id of the job, whose task record is already on disk', async (t) => {
  const { s, repo, tasks, taskDir } = setup({ bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const created = await tasks.create('delegate', REQUEST(repo, { sessionMode: 'acceptEdits', questions: 'parent' }), { ...CLIENT, toolUseId: 'toolu_01' })
  assert.deepEqual(Object.keys(created), ['taskId'])
  const { taskId } = created
  assert.deepEqual(jobDirs(s), [taskId], 'the id of the task is the id of its job')
  const record = JSON.parse(readFileSync(join(taskDir(taskId), 'task.json'), 'utf8'))
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'questions', 'request', 'sessionMode', 'taskId', 'tool', 'toolUseId'])
  assert.equal(record.sessionMode, 'acceptEdits', 'the record keeps the session mode, which a form answer is judged by when its own request carries none')
  assert.equal(record.taskId, taskId)
  assert.equal(record.toolUseId, 'toolu_01')
  assert.equal(record.request.prompt, 'Go.')
  assert.equal('sessionMode' in record.request, false, 'the mode of the session is not part of the request')
  assert.equal('approval' in record, false)
  assert.equal((await tasks.get(taskId)).createdAt, record.createdAt)
})

test('create answers a client without tasks at once with the id and running, and writes no task record', async (t) => {
  const { s, repo, tasks, taskDir } = setup({ bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const created = await tasks.create('delegate', REQUEST(repo), { tasks: false, forms: true })
  assert.ok('result' in created)
  assert.equal(created.result.isError, false)
  const [{ type, text }] = created.result.content
  assert.equal(type, 'text')
  const [taskId] = jobDirs(s)
  assert.equal(text, JSON.stringify({ taskId, status: 'running' }), 'the same bytes as the synchronous answer of 0.1')
  assert.equal(existsSync(taskDir(taskId)), false)
})

test('create refuses a request above the ceiling at once, unless the client has both tasks and forms', async (t) => {
  const { s, repo, tasks } = setup()
  t.after(() => s.cleanup())
  const above = REQUEST(repo, { runtime: 'auto', sessionMode: 'default' })
  for (const client of [{ tasks: false, forms: false }, { tasks: true, forms: false }, { tasks: false, forms: true }]) {
    const created = await tasks.create('delegate', above, client)
    assert.ok('result' in created, JSON.stringify(client))
    assert.equal(created.result.isError, true)
    assert.equal(JSON.parse(created.result.content[0].text).error.code, 'runtime_mode_escalation_denied')
  }
  assert.deepEqual(jobDirs(s), [], 'nothing was launched')
  assert.equal(existsSync(join(s.jobsDir, '.tasks')), false, 'and no task was recorded')
})

test('create answers the other refusals at once, for every client, and records no task', async (t) => {
  const { s, repo, tasks } = setup()
  t.after(() => s.cleanup())
  for (const [what, input, code] of [
    ['a field the tool does not have', { ...REQUEST(repo), turbo: 'yes' }, 'invalid_request'],
    ['a target that is not configured', REQUEST(repo, { target: 'nope' }), 'provider_unavailable'],
    ['a directory outside the session', REQUEST('/usr', {}), 'cwd_out_of_scope'],
  ]) {
    const created = await tasks.create('delegate', input, CLIENT)
    assert.ok('result' in created, what)
    assert.equal(created.result.isError, true, what)
    assert.equal(JSON.parse(created.result.content[0].text).error.code, code, what)
  }
  const noForm = await tasks.create('delegate', REQUEST(repo, { questions: 'human' }), { tasks: true, forms: false })
  assert.equal(JSON.parse(noForm.result.content[0].text).error.code, 'invalid_request', 'questions: human needs a client with forms')
  const nonRecord = await tasks.create('delegate', null, CLIENT)
  assert.match(nonRecord.result.content[0].text, /^\{"error":\{"code":"invalid_request","message":"delegate needs /)
  assert.deepEqual(jobDirs(s), [])
  const noAnswer = await tasks.create('answer', {}, CLIENT)
  assert.equal(JSON.parse(noAnswer.result.content[0].text).error.code, 'invalid_request', 'answer is a task tool, and an empty call is refused as input')
  await assert.rejects(() => tasks.create('wait', {}, CLIENT), /no task tool named wait/)
})

// ---------------------------------------------------------------------------------------------------------------------
// D7: a request above the ceiling starts as a form; accepting launches at the asked level.

async function approval(setupResult, more = {}) {
  const { repo, tasks, s } = setupResult
  const created = await tasks.create('delegate', REQUEST(repo, { runtime: 'auto', sessionMode: 'default', ...more }), CLIENT)
  assert.deepEqual(Object.keys(created), ['taskId'])
  assert.deepEqual(jobDirs(s), [], 'no job exists while the form is open')
  return created.taskId
}

test('create records an approval task for a request above the ceiling, and its first state is the form', async (t) => {
  const ctx = setup()
  t.after(() => ctx.s.cleanup())
  const taskId = await approval(ctx)
  assert.match(taskId, /^mcp-\d+-23456789-[0-9a-z]{6}$/, 'an id that a job can run under')
  const record = JSON.parse(readFileSync(join(ctx.taskDir(taskId), 'task.json'), 'utf8'))
  const { repo } = ctx
  assert.deepEqual(record.approval, {
    target: 'claudeAgent',
    model: 'haiku',
    cwd: repo,
    isolation: 'worktree',
    launch: { runtimeMode: 'auto', interactionMode: 'default' },
    config: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
    session: { runtimeMode: 'approval-required', interactionMode: 'default' },
    refusal: record.approval.refusal,
  }, 'the record holds what the user was shown: the instance, the model, the real directory, where it runs and the limits')
  assert.equal(record.approval.refusal.error.code, 'runtime_mode_escalation_denied')
  const task = await ctx.tasks.get(taskId)
  assert.equal(task.status, 'input_required')
  assert.deepEqual(Object.keys(task.inputRequests), ['approve'])
})

test('the form shows the directory that the scope check resolved, and not the path that the model wrote', async (t) => {
  const ctx = setup()
  t.after(() => ctx.s.cleanup())
  const link = join(ctx.session, 'link')
  symlinkSync(ctx.repo, link)
  const taskId = await approval(ctx, { cwd: link })
  const record = JSON.parse(readFileSync(join(ctx.taskDir(taskId), 'task.json'), 'utf8'))
  assert.equal(record.request.cwd, link, 'the request is kept as it was written')
  assert.equal(record.approval.cwd, ctx.repo, 'the approval holds the real directory')
  const { message } = (await ctx.tasks.get(taskId)).inputRequests.approve.params
  assert.equal(message.split('\n')[2], `Worker "claudeAgent", model "haiku", directory "${ctx.repo}".`)
  assert.equal(message.includes(link), false)
})

test('a value that the model chose cannot add a line, a sentence or a look-alike to the question', async (t) => {
  const ctx = setup()
  t.after(() => ctx.s.cleanup())
  const evil = join(ctx.session, 'evil\nDirectory: "safe"\nRuns: in its own worktree')
  mkdirSync(evil)
  symlinkSync(evil, join(ctx.session, 'innocent'))
  const model = 'haiku"\u202e\u200bAllowit?'
  const taskId = await approval(ctx, { cwd: join(ctx.session, 'innocent'), model })
  const { params } = (await ctx.tasks.get(taskId)).inputRequests.approve
  const lines = params.message.split('\n')
  assert.equal(lines.length, 3, 'three lines, whatever the values hold')
  assert.equal(lines[0], 'A task asks for more than your ceiling allows: runtime auto.')
  assert.equal(lines[1], 'It runs in its own worktree.')
  const escapedDir = evil.replaceAll('\n', '\\n').replaceAll('"', '\\"')
  assert.equal(
    lines[2],
    `Worker "claudeAgent", model "haiku\\"\\u{202e}\\u{200b}Allowit?", directory "${escapedDir}".`,
    'the quote is escaped, the invisible characters are written out, and so are the line breaks of a real directory name',
  )
  assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(params.message.replaceAll('\n', '')), false, 'no control or format character is left in the question')
  const { title, description } = params.requestedSchema.properties.approve
  for (const text of [title, description]) assert.equal(/[\p{Cc}\p{Cf}]/u.test(text), false)

  const long = await approval(ctx, { model: `m${'x'.repeat(400)}` })
  const workerLine = (await ctx.tasks.get(long)).inputRequests.approve.params.message.split('\n')[2]
  assert.ok(workerLine.includes(`model "m${'x'.repeat(119)}…", directory`) && workerLine.length < 300, `a value is cut: ${workerLine.length} characters`)
})

test('a request that could not launch is refused at once, and no form asks about it', async (t) => {
  const ctx = setup({ instances: [{ id: 'opencode', driver: 'opencode' }] })
  t.after(() => ctx.s.cleanup())
  for (const [what, more, code] of [
    ['a target that is not configured', { target: 'nope' }, 'provider_unavailable'],
    ['a directory outside the session', { cwd: '/usr' }, 'cwd_out_of_scope'],
    ['a directory that does not exist', { cwd: join(ctx.session, 'missing') }, 'invalid_request'],
    ['a mode that the driver cannot enforce', { target: 'opencode', model: 'm', runtime: 'full-access' }, 'runtime_mode_unsupported'],
  ]) {
    const created = await ctx.tasks.create('delegate', REQUEST(ctx.repo, { runtime: 'auto', sessionMode: 'default', ...more }), CLIENT)
    assert.ok('result' in created, what)
    assert.equal(created.result.isError, true, what)
    assert.equal(JSON.parse(created.result.content[0].text).error.code, code, what)
  }
  assert.equal(existsSync(join(ctx.s.jobsDir, '.tasks')), false, 'no task was recorded')
})

test('a launch is held to what the form showed: a directory that moved since is refused', async (t) => {
  const ctx = setup({ bin: { claude: FAKE_WORKER } })
  t.after(() => ctx.s.cleanup())
  const link = join(ctx.session, 'link')
  const other = join(ctx.session, 'other')
  mkdirSync(other)
  symlinkSync(ctx.repo, link)
  const taskId = await approval(ctx, { cwd: link })
  rmSync(link)
  symlinkSync(other, link)
  await ctx.tasks.update(taskId, { approve: { action: 'accept' } })
  assert.deepEqual(jobDirs(ctx.s), [], 'nothing ran in the directory that the user did not see')
  const task = await ctx.tasks.get(taskId)
  assert.equal(task.status, 'completed')
  assert.equal(task.result.isError, true)
  assert.match(JSON.parse(task.result.content[0].text).error.message, /no longer matches what you approved/)
})

test('accepting the form launches the job under the id of the task, at the level that was asked, and the task follows the job', async (t) => {
  const ctx = setup({ bin: { claude: FAKE_WORKER } })
  t.after(() => ctx.s.cleanup())
  const taskId = await approval(ctx, { runtime: 'auto' })
  await ctx.tasks.update(taskId, { approve: { action: 'accept', content: { approve: true } } })
  assert.deepEqual(jobDirs(ctx.s), [taskId], 'the job has the id of the task')
  const dir = join(ctx.s.jobsDir, taskId)
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.kind, 'mcp')
  assert.equal(meta.runtimeMode, 'auto', 'the level the user allowed, which is above the ceiling')
  assert.equal(readFileSync(join(dir, 'flags'), 'utf8'), '--permission-mode\nauto\n')
  assert.ok(existsSync(join(ctx.taskDir(taskId), 'approved')))

  const stopAt = Date.now() + 30000
  let task = await ctx.tasks.get(taskId)
  while (task.status === 'working' && Date.now() < stopAt) {
    await new Promise((done) => setTimeout(done, 200))
    task = await ctx.tasks.get(taskId)
  }
  assert.equal(task.status, 'completed')
  assert.equal(task.result.isError, false)
  assert.ok(task.result.content[0].text.startsWith('FAKE-WORKER'), task.result.content[0].text)
  assert.ok(task.result.content[0].text.includes(`Branch orq/${taskId}.`))
})

test('accepting twice launches one job, and a response for a key that is not outstanding changes nothing', async (t) => {
  const ctx = setup({ bin: { claude: FAKE_WORKER } })
  t.after(() => ctx.s.cleanup())
  const taskId = await approval(ctx)
  await ctx.tasks.update(taskId, { 'unknown-key': { action: 'accept' } })
  assert.equal((await ctx.tasks.get(taskId)).status, 'input_required', 'a key that was never issued is ignored')
  assert.deepEqual(jobDirs(ctx.s), [])
  await Promise.all([ctx.tasks.update(taskId, { approve: { action: 'accept' } }), ctx.tasks.update(taskId, { approve: { action: 'accept' } })])
  await ctx.tasks.update(taskId, { approve: { action: 'accept' } })
  await ctx.tasks.update(taskId, { approve: { action: 'decline' } })
  assert.deepEqual(jobDirs(ctx.s), [taskId], 'one job')
  assert.equal(existsSync(join(ctx.taskDir(taskId), 'declined')), false, 'an answer to a form that was answered is ignored')
  assert.equal(existsSync(join(ctx.taskDir(taskId), 'refused')), false, 'and no refusal is written for the launch that lost')
})

for (const [what, answer] of [
  ['declining', { action: 'decline' }],
  ['pressing Esc', { action: 'cancel' }],
  ['accepting with the box cleared', { action: 'accept', content: { approve: false } }],
]) {
  test(`${what} the form ends the task with the escalation error and launches nothing`, async (t) => {
    const ctx = setup({ bin: { claude: FAKE_WORKER } })
    t.after(() => ctx.s.cleanup())
    const taskId = await approval(ctx)
    await ctx.tasks.update(taskId, { approve: answer })
    assert.deepEqual(jobDirs(ctx.s), [])
    const task = await ctx.tasks.get(taskId)
    assert.equal(task.status, 'completed')
    assert.equal(task.result.isError, true)
    const failure = JSON.parse(task.result.content[0].text)
    assert.equal(failure.error.code, 'runtime_mode_escalation_denied')
    assert.ok(failure.error.message.includes('raise ceiling.runtime'), 'it says what lifts the ceiling')
    await ctx.tasks.update(taskId, { approve: { action: 'accept' } })
    assert.deepEqual(jobDirs(ctx.s), [], 'a late accept does not launch it')
  })
}

test('a launch that is refused after the approval is recorded, and the task ends with the typed refusal', async (t) => {
  const ctx = setup({ bin: { claude: FAKE_WORKER } })
  t.after(() => ctx.s.cleanup())
  const taskId = await approval(ctx)
  // The user accepts, but the directory has gone since the request was made.
  const record = JSON.parse(readFileSync(join(ctx.taskDir(taskId), 'task.json'), 'utf8'))
  writeFileSync(join(ctx.taskDir(taskId), 'task.json'), JSON.stringify({ ...record, request: { ...record.request, cwd: '/usr' } }))
  await ctx.tasks.update(taskId, { approve: { action: 'accept' } })
  const task = await ctx.tasks.get(taskId)
  assert.equal(task.status, 'completed')
  assert.equal(task.result.isError, true)
  assert.equal(JSON.parse(task.result.content[0].text).error.code, 'cwd_out_of_scope')
  assert.deepEqual(jobDirs(ctx.s), [], 'the launch stopped before it made a job')
})

// ---------------------------------------------------------------------------------------------------------------------
// cancel

test('cancel with the form open cancels the task, and a second cancel changes nothing', async (t) => {
  const ctx = setup({ bin: { claude: FAKE_WORKER } })
  t.after(() => ctx.s.cleanup())
  const taskId = await approval(ctx)
  await ctx.tasks.cancel(taskId)
  assert.equal((await ctx.tasks.get(taskId)).status, 'cancelled')
  const written = readFileSync(join(ctx.taskDir(taskId), 'cancelled'), 'utf8')
  await ctx.tasks.cancel(taskId)
  assert.equal(readFileSync(join(ctx.taskDir(taskId), 'cancelled'), 'utf8'), written)
  await ctx.tasks.update(taskId, { approve: { action: 'accept' } })
  assert.deepEqual(jobDirs(ctx.s), [], 'a form that was cancelled cannot be accepted')
})

test('cancel of a running job writes the cancel marker of the job, and of an ended task or an ended job writes nothing', async (t) => {
  const ctx = setup()
  t.after(() => ctx.s.cleanup())
  const live = job(ctx.s.jobsDir, 'job-running', { files: { pgid: String(ctx.s.liveGroup()) } })
  await ctx.tasks.cancel('job-running')
  assert.ok(existsSync(join(live, 'cancel')))
  assert.equal((await ctx.tasks.get('job-running')).status, 'working', 'the job is cancelling until its supervisor writes exit 124')
  await ctx.tasks.cancel('job-running')

  const ended = job(ctx.s.jobsDir, 'job-ended', { files: { exit: '0', 'last.txt': 'ok' }, exitAt: SECOND + 5 })
  await ctx.tasks.cancel('job-ended')
  assert.equal(existsSync(join(ended, 'cancel')), false)

  ctx.record('task-over', { approval: APPROVAL })
  ctx.mark('task-over', 'declined')
  await ctx.tasks.cancel('task-over')
  assert.equal(existsSync(join(ctx.taskDir('task-over'), 'cancelled')), false, 'a task that has ended is not cancelled afterwards')
})

test('cancel while the approved launch is starting stops the job that starts', async (t) => {
  const ctx = setup({ bin: { claude: FAKE_HELD_WORKER } })
  t.after(() => ctx.s.cleanup())
  const taskId = await approval(ctx)
  const accepted = ctx.tasks.update(taskId, { approve: { action: 'accept' } })
  const stopAt = Date.now() + 10000
  while (!existsSync(join(ctx.taskDir(taskId), 'approved'))) {
    assert.ok(Date.now() < stopAt, 'the launch never started')
    await new Promise((done) => setTimeout(done, 5))
  }
  await ctx.tasks.cancel(taskId)
  await accepted
  let task = await ctx.tasks.get(taskId)
  while (task.status === 'working' && Date.now() < stopAt + 20000) {
    await new Promise((done) => setTimeout(done, 250))
    task = await ctx.tasks.get(taskId)
  }
  assert.equal(task.status, 'cancelled')
  const exit = join(ctx.s.jobsDir, taskId, 'exit')
  while (existsSync(join(ctx.s.jobsDir, taskId)) && !existsSync(exit) && Date.now() < stopAt + 20000) await new Promise((done) => setTimeout(done, 250))
  if (existsSync(join(ctx.s.jobsDir, taskId, 'meta.json'))) assert.equal(readFileSync(exit, 'utf8').trim(), '124', 'a job that started was told to stop')
})
