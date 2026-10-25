// answer: the worker that stopped on a question resumes its own session in a new job, on the same branch. The tests drive
// the real server over stdio and a fake claude that asks on its first run and quotes what it is told when it is resumed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { NO_TASKS, SECOND, checkout, job, jobDirs, scene, until } from './support/harness.mjs'

const QUESTION = 'Which environment, staging or production?'

/** Asks on its first run. Resumed (`--resume` in its argv), it answers with the first line of the prompt it was given. */
const QUESTION_WORKER = [
  '#!/bin/bash',
  'printf "%s\\n" "$@" > "$ORQ_JOB_DIR/argv.txt"',
  'pwd > "$ORQ_JOB_DIR/cwd.txt"',
  'for last; do :; done',
  'if printf "%s\\n" "$@" | grep -qx -e --resume; then',
  '  first=$(printf "%s" "$last" | head -n 1)',
  `  printf '%s\\n' '{"type":"system","subtype":"init","session_id":"ses-q1"}'`,
  `  printf '{"type":"result","subtype":"success","is_error":false,"session_id":"ses-q1","result":"RESUMED: %s","usage":{"input_tokens":3,"output_tokens":2},"modelUsage":{"fake-model":{}}}\\n' "$first"`,
  '  exit 0',
  'fi',
  `printf '%s\\n' '${QUESTION}' > "$ORQ_JOB_DIR/question.txt"`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"ses-q1"}'`,
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"ses-q1","result":"BLOCKED: ${QUESTION}","usage":{"input_tokens":3,"output_tokens":2},"modelUsage":{"fake-model":{}}}'`,
  'exit 0',
  '',
].join('\n')

const REQUEST = (repo, more = {}) => ({ target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Deploy it.', ...more })
const read = (s, id, name) => readFileSync(join(s.jobsDir, id, name), 'utf8')
const meta = (s, id) => JSON.parse(read(s, id, 'meta.json'))
const code = (answer) => answer.json?.error?.code

/** A worker that asked, started through the server, and the task it left behind. */
async function asked(s, server, repo) {
  const started = await server.call('delegate', REQUEST(repo, { sessionMode: 'acceptEdits' }))
  const id = started.task.taskId
  const done = await until(server, id)
  assert.equal(done.status, 'completed')
  return { id, done, text: done.result.content[0].text }
}

/** A job that ended on a question without a worker behind it. */
function blockedJob(s, id, { repo, files = {}, ...meta } = {}) {
  return job(s.jobsDir, id, {
    meta: { kind: 'mcp', agentId: 'sess', cwd: repo, runner: 'claude', driver: 'claudeAgent', instanceId: 'claudeAgent', model: 'haiku', runtimeMode: 'approval-required', interactionMode: 'default', ...meta },
    files: { exit: '0', 'last.txt': `BLOCKED: ${QUESTION}`, 'question.txt': `${QUESTION}\n`, session: 'ses-q1\n', ...files },
    exitAt: SECOND + 4,
  })
}

test('answer resumes the worker in its own session, worktree and branch, as a task of its own, and the first task keeps its text', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const { id, text } = await asked(s, server, repo)

  assert.equal(
    text.split('\n\n— orq')[0],
    `BLOCKED on a question (taskId ${id}): ${QUESTION}\n\nAnswer it with the answer tool; the same worker resumes its session.`,
    'the text points at the answer tool',
  )
  assert.equal(read(s, id, 'session'), 'ses-q1\n', 'the supervisor recorded the session before the job ended')

  const answered = await server.call('answer', { taskId: id, answer: 'Production, and tag it v2.\nThen stop.', sessionMode: 'acceptEdits' })
  const next = answered.task.taskId
  assert.notEqual(next, id, 'the continuation is a task of its own')
  const done = await until(server, next)
  assert.equal(done.status, 'completed')
  assert.equal(done.result.isError, false)
  const [{ text: final }] = done.result.content
  assert.ok(final.startsWith('RESUMED: Production, and tag it v2.\n\n— orq · mcp · '), final)
  assert.ok(final.endsWith(`Branch orq/${id}. Merge it with integrate: {"taskId": "${next}"}`), final)

  const argv = read(s, next, 'argv.txt').split('\n')
  assert.deepEqual(argv.slice(0, 5), ['-p', '--resume', 'ses-q1', '--output-format', 'stream-json'], 'the worker was resumed with the recorded session')
  assert.ok(argv.join('\n').includes('Production, and tag it v2.\nThen stop.'), 'the prompt is the answer, whole')
  const [first, second] = [meta(s, id), meta(s, next)]
  assert.equal(second.parent, id)
  assert.equal(second.kind, 'mcp')
  for (const field of ['branch', 'worktree', 'repo', 'baseSha', 'cwd', 'model', 'instanceId', 'runtimeMode']) assert.equal(second[field], first[field], field)
  assert.equal(read(s, next, 'cwd.txt'), read(s, id, 'cwd.txt'), 'the worker ran in the directory of the first job')
  assert.deepEqual(JSON.parse(read(s, id, 'next')), { jobId: next, via: 'answer' })
  assert.equal(read(s, next, 'session'), 'ses-q1\n')

  const again = await server.get(id)
  assert.equal(again.result.content[0].text, text, 'an answer never changes the task that asked')
  const status = (await server.call('status', { taskId: id })).json
  assert.equal(status.next, next, 'status says which job took the question over')
  assert.equal((await server.call('status', { taskId: next })).json.parent, id)
})

test('a second answer to the same job is refused with the id of the continuation, and two at once start one worker', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const { id } = await asked(s, server, repo)

  const [a, b] = await Promise.all([
    server.call('answer', { taskId: id, answer: 'Production.' }),
    server.call('answer', { taskId: id, answer: 'Staging.' }),
  ])
  const won = [a, b].filter((answer) => answer.task !== undefined)
  const lost = [a, b].filter((answer) => answer.task === undefined)
  assert.equal(won.length, 1, 'exactly one answer started a worker')
  assert.equal(lost[0].isError, true)
  assert.equal(code(lost[0]), 'already_answered')
  const next = won[0].task.taskId
  assert.ok(lost[0].json.error.message.includes(next), lost[0].text)
  assert.equal(jobDirs(s).length, 2, 'the job that asked and one continuation')

  const later = await server.call('answer', { taskId: id, answer: 'Production.' })
  assert.equal(code(later), 'already_answered')
  assert.ok(later.json.error.message.includes(next))
  await until(server, next)
})

test('a job that recorded no session, or whose instance changed, answers resume_unavailable and says what to do', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  blockedJob(s, 'job-old', { repo, files: { session: '' } })
  blockedJob(s, 'job-moved', { repo, codexHome: '/home/someone/.codex-lane' })
  blockedJob(s, 'job-gone', { repo: join(s.root, 'not-there') })
  const server = s.startIn(session)

  for (const id of ['job-old', 'job-moved', 'job-gone']) {
    const answer = await server.call('answer', { taskId: id, answer: 'Production.' })
    assert.equal(answer.isError, true, id)
    assert.equal(code(answer), 'resume_unavailable', id)
    assert.ok(answer.json.error.message.includes('Delegate a new task that carries the brief and the answer'), answer.text)
  }
  assert.equal(existsSync(join(s.jobsDir, 'job-old', 'next')), false, 'a refusal does not claim the question')
  const old = (await server.call('status', { taskId: 'job-old' })).json
  assert.ok(old.result.includes('cannot be resumed'), 'the BLOCKED text of a job without a session says so, and not that the answer tool resumes it')
})

test('answer refuses an id that is unknown, a job that did not stop on a question, and input that is not valid', async (t) => {
  const s = scene()
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  job(s.jobsDir, 'job-fine', { meta: { cwd: repo }, files: { exit: '0', 'last.txt': 'All done.' }, exitAt: SECOND + 4 })
  job(s.jobsDir, 'job-live', { meta: { cwd: repo }, files: { pgid: String(s.liveGroup()) } })
  const server = s.startIn(session)

  assert.equal(code(await server.call('answer', { taskId: 'job-nope', answer: 'x' })), 'task_not_found')
  for (const id of ['job-fine', 'job-live']) {
    const answer = await server.call('answer', { taskId: id, answer: 'x' })
    assert.equal(code(answer), 'invalid_request', id)
    assert.match(answer.json.error.message, /not stopped on a question|did not stop on a question/, id)
  }
  const bad = [
    [{ answer: 'x' }, /taskId/],
    [{ taskId: 'job-fine' }, /answer/],
    [{ taskId: 'job-fine', answer: '   ' }, /blank/],
    [{ taskId: 'job-fine', answer: 'x'.repeat(20001) }, /20000/],
    [{ taskId: 'job-fine', answer: 'x', extra: 1 }, /no field "extra"/],
    [{ taskId: 'job-fine', answer: 7 }, /answer must be text/],
  ]
  for (const [args, pattern] of bad) {
    const answer = await server.call('answer', args)
    assert.equal(code(answer), 'invalid_request', JSON.stringify(args).slice(0, 60))
    assert.match(answer.json.error.message, pattern)
  }
  assert.equal(jobDirs(s).length, 2, 'nothing started')
})

test('the worker is held to the ceiling again, unless the user allowed its level in a form for its task', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  blockedJob(s, 'job-edits', { repo, runtimeMode: 'auto-accept-edits' })
  const server = s.startIn(session)

  const refused = await server.call('answer', { taskId: 'job-edits', answer: 'Production.', sessionMode: 'default' })
  assert.equal(code(refused), 'runtime_mode_escalation_denied', 'the session now allows approval-required, the worker ran at auto-accept-edits')
  assert.match(refused.json.error.message, /ran with runtime mode auto-accept-edits/)
  assert.equal(existsSync(join(s.jobsDir, 'job-edits', 'next')), false)

  mkdirSync(join(s.jobsDir, '.tasks', 'job-edits'), { recursive: true })
  writeFileSync(join(s.jobsDir, '.tasks', 'job-edits', 'approved'), 'now\n')
  const allowed = await server.call('answer', { taskId: 'job-edits', answer: 'Production.', sessionMode: 'default' })
  assert.ok(allowed.task !== undefined, allowed.text)
  const done = await until(server, allowed.task.taskId)
  assert.equal(done.result.content[0].text.split('\n')[0], 'RESUMED: Production.')
  assert.equal(meta(s, allowed.task.taskId).runtimeMode, 'auto-accept-edits', 'the continuation runs at the level its worker had, no higher')
  assert.ok(read(s, allowed.task.taskId, 'flags').includes('acceptEdits'), 'and its flags say so')
})

test('a client without tasks gets the id of the continuation at once and reads it with status', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const first = await server.call('delegate', REQUEST(repo, { sessionMode: 'acceptEdits' }), NO_TASKS)
  const id = first.json.taskId
  for (let wait = 0; wait < 100 && !existsSync(join(s.jobsDir, id, 'exit')); wait += 1) await new Promise((done) => setTimeout(done, 100))

  const answered = await server.call('answer', { taskId: id, answer: 'Production.' }, NO_TASKS)
  assert.equal(answered.isError, false, answered.text)
  assert.equal(answered.json.status, 'running')
  const next = answered.json.taskId
  assert.ok(existsSync(join(s.jobsDir, next, 'meta.json')))
  assert.equal(existsSync(join(s.jobsDir, '.tasks', next)), false, 'no task record for a client that has no tasks')
  for (let wait = 0; wait < 100 && !existsSync(join(s.jobsDir, next, 'exit')); wait += 1) await new Promise((done) => setTimeout(done, 100))
  const status = (await server.call('status', { taskId: next }, NO_TASKS)).json
  assert.equal(status.status, 'completed')
  assert.equal(status.result.split('\n')[0], 'RESUMED: Production.')
})
