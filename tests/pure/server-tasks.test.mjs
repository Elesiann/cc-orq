// delegate as a task, through the real server over stdio. The harness holds every answer to the core/v2 schemas of
// ext-tasks and to what they leave out (ISO times, the poll interval, the form being flat, a statusMessage on every
// tasks/get), so a test here only has to say what it expects and the wire is checked on every line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FAKE_HELD_WORKER, FAKE_WORKER, NO_TASKS, REPO, SECOND, TASKS, WITH_FORMS, checkout, job, jobDirs, modern, scene, until } from './support/harness.mjs'

const REQUEST = (repo, more = {}) => ({ target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Go.', ...more })
const VERSION = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')).version
const release = (s, taskId) => writeFileSync(join(s.jobsDir, taskId, 'go'), '')
const taskFile = (s, taskId) => join(s.jobsDir, '.tasks', taskId, 'task.json')

test('delegate answers a client with the tasks extension a task that is already on disk, and the first tasks/get resolves it', async (t) => {
  const s = scene({ bin: { claude: FAKE_HELD_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)

  const answer = await server.call('delegate', REQUEST(repo, { sessionMode: 'acceptEdits' }), undefined, { 'claudecode/toolUseId': 'toolu_01abc' })
  assert.equal(answer.task.resultType, 'task')
  const { taskId } = answer.task
  assert.match(taskId, /^mcp-\d+-23456789-[0-9a-z]+$/, 'the id of the task is the id of its job')
  assert.ok(existsSync(taskFile(s, taskId)), 'the task record was on disk when the answer was sent')
  assert.deepEqual(jobDirs(s), [taskId])
  assert.equal(JSON.parse(readFileSync(taskFile(s, taskId), 'utf8')).toolUseId, 'toolu_01abc', 'the server sees the tool use id that Claude Code puts in _meta')

  const first = await server.get(taskId)
  assert.equal(first.status, 'working')
  assert.match(first.statusMessage, /^claudeAgent · haiku · /, 'the instance and the model lead the message')
  assert.equal(first.createdAt, answer.task.createdAt)

  release(s, taskId)
  const done = await until(server, taskId)
  assert.equal(done.status, 'completed')
  assert.equal(done.result.isError, false)
  const [{ text }] = done.result.content
  assert.ok(text.startsWith('FAKE-WORKER\n\n— orq · mcp · '), text)
  assert.ok(text.endsWith(`Branch orq/${taskId}. Merge it with integrate: {"taskId": "${taskId}"}`), text)

  assert.equal((await server.call('status', { taskId })).json.status, 'completed', 'status takes the id that /tasks shows')
  assert.ok((await server.call('list')).json.jobs.some((row) => row.taskId === taskId))
  const merged = await server.call('integrate', { taskId })
  assert.equal(merged.json.ok, true, merged.text)
  assert.equal(readFileSync(join(repo, `${taskId}.txt`), 'utf8'), 'worker output\n', 'integrate merges the branch of the task')
})

test('tasks/get on a live, a finished, a failed, a cancelled and an interrupted job gives the derived state and the statusMessage', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const events = '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the files"}]}}\n'
  job(s.jobsDir, 'job-live', { startedAt: Date.now() - 65_000, files: { pgid: String(s.liveGroup()), 'events.jsonl': events } })
  job(s.jobsDir, 'job-done', { files: { exit: '0', 'last.txt': 'All done.' }, exitAt: SECOND + 65 })
  job(s.jobsDir, 'job-failed', { files: { exit: '2', 'last.txt': '', 'stderr.txt': 'it broke\n' }, exitAt: SECOND + 5 })
  job(s.jobsDir, 'job-cancelled', { files: { exit: '124', cancel: 'cancelled' }, exitAt: SECOND + 5 })
  job(s.jobsDir, 'job-lost', { files: { pgid: String(await s.deadGroup()) } })
  const server = s.start()

  const live = await server.get('job-live')
  assert.equal(live.status, 'working')
  assert.match(live.statusMessage, /^codex · fixture-model · msg Reading the files · 1m0\ds$/)
  const done = await server.get('job-done')
  assert.deepEqual([done.status, done.result.isError], ['completed', false])
  assert.ok(done.result.content[0].text.startsWith('All done.\n\n— orq · manual'))
  assert.match(done.statusMessage, /finished · 1m05s$/)
  const failed = await server.get('job-failed')
  assert.deepEqual([failed.status, failed.result.isError], ['completed', true], 'a worker that fails is completed with isError, never failed')
  assert.equal(failed.result.content[0].text, 'orq: job-failed failed (exit 2)\nit broke')
  const cancelled = await server.get('job-cancelled')
  assert.equal(cancelled.status, 'cancelled')
  assert.match(cancelled.statusMessage, /cancelled/)
  const lost = await server.get('job-lost')
  assert.deepEqual([lost.status, lost.result.isError], ['completed', true])
  assert.match(lost.result.content[0].text, /was interrupted: its supervisor is gone/)
})

test('a second tasks/cancel gives a second empty ack, and the worker is stopped', async (t) => {
  const s = scene({ bin: { claude: FAKE_HELD_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const { task } = await server.call('delegate', REQUEST(repo))
  const first = await server.cancel(task.taskId)
  const second = await server.cancel(task.taskId)
  for (const answer of [first, second]) {
    assert.equal(answer.error, undefined)
    const { _meta, ...ack } = answer.result
    assert.deepEqual(ack, { resultType: 'complete' }, 'an empty ack')
  }
  assert.ok(['working', 'cancelled'].includes((await server.get(task.taskId)).status), 'it may stay working until the supervisor has stopped it')
  const ended = await until(server, task.taskId)
  assert.equal(ended.status, 'cancelled')
  assert.equal(readFileSync(join(s.jobsDir, task.taskId, 'exit'), 'utf8').trim(), '124')
  const third = await server.cancel(task.taskId)
  assert.equal(third.error, undefined, 'cancelling a task that has ended is acked too')
})

test('an unknown id gives -32602, a call without the extension gives -32021 even for an unknown id, and tasks/result and tasks/list give -32601', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  job(s.jobsDir, 'job-real', { files: { exit: '0', 'last.txt': 'ok' }, exitAt: SECOND + 1 })
  const server = s.start()
  for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
    for (const taskId of ['task-unknown', '../../etc/passwd']) {
      const answer = await server.request(method, { taskId, ...modern() })
      assert.equal(answer.error.code, -32602, `${method} ${taskId}`)
      assert.equal(answer.error.message, `Failed to ${{ 'tasks/get': 'retrieve', 'tasks/update': 'update', 'tasks/cancel': 'cancel' }[method]} task: Task not found`)
    }
    for (const taskId of ['task-unknown', 'job-real']) {
      const answer = await server.request(method, { taskId, ...modern({ elicitation: { form: {} } }) })
      assert.equal(answer.error.code, -32021, `${method} ${taskId}`)
      assert.deepEqual(answer.error.data, { requiredCapabilities: { extensions: { [TASKS]: {} } } })
    }
  }
  for (const method of ['tasks/result', 'tasks/list']) {
    const answer = await server.request(method, { taskId: 'job-real', ...modern() })
    assert.equal(answer.error.code, -32601, method)
  }
})

test('a request without the extension gets the synchronous answer, byte for byte the answer of 44c3ea7, and no task record', async (t) => {
  const s = scene({ bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const answer = await server.call('delegate', REQUEST(repo), NO_TASKS)
  const [taskId] = jobDirs(s)
  const text = JSON.stringify(JSON.stringify({ taskId, status: 'running' }))
  const serverInfo = `{"io.modelcontextprotocol/serverInfo":{"name":"cc-orq","version":"${VERSION}"}}`
  const id = JSON.parse(answer.frame).id
  assert.equal(answer.frame, `{"result":{"content":[{"type":"text","text":${text}}],"resultType":"complete","_meta":${serverInfo}},"jsonrpc":"2.0","id":${id}}`)
  assert.equal(existsSync(join(s.jobsDir, '.tasks')), false, 'no task was recorded')
  assert.equal((await until(server, taskId, ['working'])).status, 'completed', 'the job runs, and the same id reads as a task')

  const forms = await server.call('delegate', REQUEST(repo), { elicitation: { form: {} } })
  assert.deepEqual(forms.json.status, 'running', 'forms without tasks do not make a task')
  const other = await server.call('delegate', REQUEST(repo), { extensions: { 'other/extension': {} } })
  assert.equal(other.json.status, 'running', 'another extension does not either')
})

test('a legacy session, which sends no envelope, gets the synchronous answer', async (t) => {
  const s = scene({ bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  await server.request('initialize', { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'legacy', version: '0' } })
  const answer = await server.request('tools/call', { name: 'delegate', arguments: REQUEST(repo) })
  assert.equal(answer.result.resultType, undefined)
  assert.equal(JSON.parse(answer.result.content[0].text).status, 'running')
  assert.equal(existsSync(join(s.jobsDir, '.tasks')), false)
})

test('a request above the ceiling opens a form: the task is created working, the first tasks/get is input_required, and accepting launches at the asked level', async (t) => {
  const s = scene({ bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const above = REQUEST(repo, { runtime: 'auto', sessionMode: 'default' })

  const answer = await server.call('delegate', above, WITH_FORMS)
  const { taskId } = answer.task
  assert.equal(answer.task.status, 'working', 'a task is created working, as the published diagram has it')
  assert.deepEqual(jobDirs(s), [], 'no job while the form is open')

  const open = await server.get(taskId)
  assert.equal(open.status, 'input_required')
  assert.deepEqual(Object.keys(open.inputRequests), ['approve'])
  const lines = open.inputRequests.approve.params.message.split('\n')
  assert.deepEqual(lines, ['A task asks for more than your ceiling allows: runtime auto.', 'It runs in its own worktree.', `Worker "claudeAgent", model "haiku", directory "${repo}".`])
  const field = open.inputRequests.approve.params.requestedSchema.properties.approve
  assert.equal(field.title, 'Allow in its own worktree, this task only')
  assert.equal(field.description, "runtime auto is above ceiling.runtime auto-accept-edits and the session's permission mode approval-required.")
  assert.deepEqual((await server.get(taskId)).inputRequests, open.inputRequests, 'the same key shows on the next poll until it is answered')

  const ack = await server.update(taskId, { approve: { action: 'accept', content: { approve: true } } })
  assert.equal(ack.error, undefined)
  assert.deepEqual(jobDirs(s), [taskId], 'the job runs under the id of the task')
  assert.equal(readFileSync(join(s.jobsDir, taskId, 'flags'), 'utf8'), '--permission-mode\nauto\n', 'at the level that the user allowed')
  const done = await until(server, taskId)
  assert.equal(done.status, 'completed')
  assert.ok(done.result.content[0].text.startsWith('FAKE-WORKER'))
  const again = await server.update(taskId, { approve: { action: 'accept' } })
  assert.equal(again.error, undefined, 'an answer to a form that was answered is acked and ignored')
  assert.deepEqual(jobDirs(s), [taskId])
})

test('declining the form ends the task with the escalation error and starts no worker; a client without forms is refused at once', async (t) => {
  const s = scene({ bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const above = REQUEST(repo, { runtime: 'auto', sessionMode: 'default' })

  const { task } = await server.call('delegate', above, WITH_FORMS)
  await server.update(task.taskId, { approve: { action: 'decline' } })
  const declined = await server.get(task.taskId)
  assert.equal(declined.status, 'completed')
  assert.equal(declined.result.isError, true)
  assert.equal(JSON.parse(declined.result.content[0].text).error.code, 'runtime_mode_escalation_denied')

  const escaped = await server.call('delegate', above, WITH_FORMS)
  await server.update(escaped.task.taskId, { approve: { action: 'cancel' } })
  assert.equal((await server.get(escaped.task.taskId)).result.isError, true, 'Esc is a refusal')

  const noForm = await server.call('delegate', above, { extensions: { [TASKS]: {} } })
  assert.equal(noForm.isError, true)
  assert.equal(noForm.json.error.code, 'runtime_mode_escalation_denied', 'tasks without forms cannot ask, so the request is refused as before')
  assert.deepEqual(jobDirs(s), [])
})

test('cancelling a task whose form is open cancels it, and the answer that comes after launches nothing', async (t) => {
  const s = scene({ bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const { task } = await server.call('delegate', REQUEST(repo, { runtime: 'auto', sessionMode: 'default' }), WITH_FORMS)
  assert.equal((await server.cancel(task.taskId)).error, undefined)
  assert.equal((await server.cancel(task.taskId)).error, undefined)
  const cancelled = await server.get(task.taskId)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(typeof cancelled.statusMessage, 'string', 'Claude Code shows the message of a cancelled task, and clears one that is missing')
  await server.update(task.taskId, { approve: { action: 'accept' } })
  assert.deepEqual(jobDirs(s), [])
})

test('tasks/update acks a key that was never issued and a request that carries no answers, and changes nothing', async (t) => {
  const s = scene({ bin: { claude: FAKE_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const { task } = await server.call('delegate', REQUEST(repo, { runtime: 'auto', sessionMode: 'default' }), WITH_FORMS)
  for (const responses of [{ 'unknown-key': { ignored: true } }, { approve: { ignored: true } }, { approve: 'accept' }, {}, undefined]) {
    const answer = await server.update(task.taskId, responses)
    assert.equal(answer.error, undefined, JSON.stringify(responses))
  }
  assert.equal((await server.get(task.taskId)).status, 'input_required', 'the form is still open')
  assert.deepEqual(jobDirs(s), [])
})

test('a server that starts after the old one stopped answers for the same task, and the worker has kept running', async (t) => {
  const s = scene({ bin: { claude: FAKE_HELD_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const first = s.startIn(session)
  const { task } = await first.call('delegate', REQUEST(repo))
  const form = await first.call('delegate', REQUEST(repo, { runtime: 'auto', sessionMode: 'default' }), WITH_FORMS)
  await first.close()

  const second = s.startIn(session)
  assert.equal((await second.get(task.taskId)).status, 'working', 'the worker outlived the server that started it')
  assert.equal((await second.get(form.task.taskId)).status, 'input_required', 'and so did the form')
  release(s, task.taskId)
  assert.equal((await until(second, task.taskId)).status, 'completed')
  await second.update(form.task.taskId, { approve: { action: 'accept' } })
  assert.ok(existsSync(join(s.jobsDir, form.task.taskId, 'meta.json')), 'the new server launched what the old one had asked about')
  release(s, form.task.taskId)
  assert.equal((await until(second, form.task.taskId)).status, 'completed')
})
