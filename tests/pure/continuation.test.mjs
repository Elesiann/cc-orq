// answer: the worker that stopped on a question resumes its own session in a new job, on the same branch. The tests drive
// the real server over stdio and a fake claude that asks on its first run and quotes what it is told when it is resumed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { NO_TASKS, SECOND, WITH_FORMS, checkout, git, job, jobDirs, scene, until } from './support/harness.mjs'

const QUESTION = 'Which environment, staging or production?'

/** Asks on its first run. Resumed (`--resume` in its argv), it answers with the first line of the prompt it was given. */
const QUESTION_WORKER = [
  '#!/bin/bash',
  'printf "%s\\n" "$@" > "$ORQ_JOB_DIR/argv.txt"',
  'pwd -P > "$ORQ_JOB_DIR/cwd.txt"',
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

/** What the server records of an approved form, the way job-tasks writes it. */
function approve(s, id, { tool = 'delegate', approval, request = {} } = {}) {
  const dir = join(s.jobsDir, '.tasks', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'task.json'), JSON.stringify({ taskId: id, createdAt: new Date(Date.now() - 60000).toISOString(), tool, questions: 'parent', request, ...(approval !== undefined ? { approval } : {}) }))
  if (approval !== undefined) writeFileSync(join(dir, 'approved'), 'now\n')
}
const approved = (repo, more = {}) => ({
  target: 'claudeAgent',
  model: 'haiku',
  cwd: repo,
  isolation: 'shared',
  launch: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
  config: { runtimeMode: 'approval-required', interactionMode: 'default' },
  session: null,
  refusal: { error: { code: 'runtime_mode_escalation_denied', message: 'above the ceiling' } },
  ...more,
})

test('the continuation is held to the ceiling again, and an earlier approval counts only from the server records of its own chain and plan', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const edits = { repo, isolation: 'shared', runtimeMode: 'auto-accept-edits' }
  blockedJob(s, 'job-none', edits)
  blockedJob(s, 'job-approved', edits)
  blockedJob(s, 'job-forged', { ...edits, parent: 'job-approved' })
  blockedJob(s, 'job-other-model', edits)
  blockedJob(s, 'job-chained', { ...edits, parent: 'job-approved' })
  approve(s, 'job-approved', { approval: approved(repo), request: { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'x' } })
  approve(s, 'job-other-model', { approval: approved(repo, { model: 'sonnet' }), request: { target: 'claudeAgent', model: 'sonnet', cwd: repo, prompt: 'x' } })
  approve(s, 'job-chained', { tool: 'answer', request: { taskId: 'job-approved', answer: 'Production.' } })
  const server = s.startIn(session)
  const ask = (taskId) => server.call('answer', { taskId, answer: 'Production.', sessionMode: 'default' })

  const none = await ask('job-none')
  assert.equal(code(none), 'runtime_mode_escalation_denied', 'with no approval on record the ceiling decides, and the client has no forms')
  assert.match(none.json.error.message, /ran with runtime mode auto-accept-edits/)
  assert.equal(code(await ask('job-forged')), 'runtime_mode_escalation_denied', 'a meta.json whose parent names an approved job of another chain gives no approval')
  assert.equal(code(await ask('job-other-model')), 'runtime_mode_escalation_denied', 'an approval for another model does not cover this worker')
  assert.equal(existsSync(join(s.jobsDir, 'job-forged', 'next')), false, 'a refusal does not claim the question')

  const allowed = await ask('job-approved')
  assert.ok(allowed.task !== undefined, allowed.text)
  const done = await until(server, allowed.task.taskId)
  assert.equal(done.result.content[0].text.split('\n')[0], 'RESUMED: Production.')
  assert.equal(meta(s, allowed.task.taskId).runtimeMode, 'auto-accept-edits', 'the continuation runs at the level its worker had, no higher')
  assert.ok(read(s, allowed.task.taskId, 'flags').includes('acceptEdits'), 'and its flags say so')

  const chained = await ask('job-chained')
  assert.ok(chained.task !== undefined, 'the task records link a continuation to the approval of the task it continues')
  await until(server, chained.task.taskId)
})

test('a continuation above the ceiling opens the approval form for a client with forms, and accepting resumes the worker', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  blockedJob(s, 'job-form', { repo, isolation: 'shared', runtimeMode: 'auto-accept-edits' })
  const server = s.startIn(session)

  const { task } = await server.call('answer', { taskId: 'job-form', answer: 'Production.', sessionMode: 'default' }, WITH_FORMS)
  const form = await server.get(task.taskId)
  assert.equal(form.status, 'input_required')
  assert.match(form.inputRequests.approve.params.message, /more than your ceiling allows: runtime auto-accept-edits/)
  assert.equal(existsSync(join(s.jobsDir, 'job-form', 'next')), false, 'nothing was claimed while the form is open')

  await server.update(task.taskId, { approve: { action: 'accept', content: { approve: true } } })
  const done = await until(server, task.taskId, ['working', 'input_required'])
  assert.equal(done.result.content[0].text.split('\n')[0], 'RESUMED: Production.')
  assert.equal(JSON.parse(read(s, 'job-form', 'next')).jobId, task.taskId, 'the task has the id of the job that was reserved for it')
  assert.ok(existsSync(join(s.jobsDir, '.tasks', task.taskId, 'approved')))

  blockedJob(s, 'job-declined', { repo, isolation: 'shared', runtimeMode: 'auto-accept-edits' })
  const declined = (await server.call('answer', { taskId: 'job-declined', answer: 'Production.', sessionMode: 'default' }, WITH_FORMS)).task.taskId
  await server.update(declined, { approve: { action: 'decline' } })
  const ended = await server.get(declined)
  assert.equal(ended.status, 'completed')
  assert.equal(ended.result.isError, true)
  assert.equal(JSON.parse(ended.result.content[0].text).error.code, 'runtime_mode_escalation_denied')
  assert.equal(existsSync(join(s.jobsDir, 'job-declined', 'next')), false, 'a declined form leaves the question to be answered again')
})

test('the continuation is scoped like a launch, and a worktree that git does not list for the task is locked like a shared one', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const outside = join(s.root, 'outside')
  mkdirSync(outside)
  job(s.jobsDir, 'job-live', { meta: { cwd: repo }, files: { pgid: String(s.liveGroup()) } })
  const worktree = { repo, baseSha: 'abc', branch: 'orq/job-forged-wt', worktree: repo }
  blockedJob(s, 'job-forged-wt', worktree)
  blockedJob(s, 'job-outside', { repo: outside })
  const server = s.startIn(session)

  const busy = await server.call('answer', { taskId: 'job-forged-wt', answer: 'Production.' })
  assert.equal(code(busy), 'worktree_busy', 'a path that only the job record calls its worktree does not skip the lock of the checkout it is')
  assert.ok(busy.json.error.message.includes('job-live'), busy.text)
  assert.equal(existsSync(join(s.jobsDir, 'job-forged-wt', 'next')), false, 'a launch that did not start gives the claim back')

  const scoped = await server.call('answer', { taskId: 'job-outside', answer: 'Production.' })
  assert.equal(code(scoped), 'cwd_out_of_scope', 'a directory outside the session directory and the allowed roots is not resumed in')
}
)

test('a meta.json whose cwd or worktree points elsewhere does not move the worker out of its own worktree, or into one that another job holds', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const { id } = await asked(s, server, repo)
  const first = meta(s, id)
  const rewrite = (fields) => writeFileSync(join(s.jobsDir, id, 'meta.json'), JSON.stringify({ ...first, ...fields }))

  // A link inside the worktree that leads to the user's own checkout: the path starts in the worktree and ends outside it.
  symlinkSync(repo, join(first.worktree, 'escape'))
  rewrite({ cwd: join(first.worktree, 'escape') })
  const escaped = await server.call('answer', { taskId: id, answer: 'Production.', sessionMode: 'acceptEdits' })
  assert.equal(code(escaped), 'runtime_mode_escalation_denied', 'a directory that is not in the worktree runs as a shared task, and a shared task is held to the shared ceiling')
  assert.equal(jobDirs(s).length, 1, 'no worker was resumed in the checkout')
  assert.equal(existsSync(join(s.jobsDir, id, 'next')), false)

  // The worktree and the branch of a task that is still running, named by a job that is not its own.
  const wt = join(session, 'repo-wt', 'job-held')
  git(repo, ['worktree', 'add', '-q', wt, '-b', 'orq/job-held'])
  job(s.jobsDir, 'job-held', { meta: { cwd: wt, repo, baseSha: git(repo, ['rev-parse', 'HEAD']), branch: 'orq/job-held', worktree: wt }, files: { pgid: String(s.liveGroup()) } })
  rewrite({ cwd: wt, repo, branch: 'orq/job-held', worktree: wt, runtimeMode: 'approval-required' })
  const held = await server.call('answer', { taskId: id, answer: 'Production.', sessionMode: 'acceptEdits' })
  assert.equal(code(held), 'worktree_busy', 'the worktree that another job holds is locked like a shared one')
  assert.ok(held.json.error.message.includes('job-held'), held.text)
  assert.deepEqual(jobDirs(s).filter((dir) => existsSync(join(s.jobsDir, dir, 'argv.txt'))), [id], 'no worker has run but the one that asked')
  assert.equal(existsSync(join(s.jobsDir, id, 'next')), false, 'a launch that did not start gives the claim back')

  // The same task, untouched, resumes in its own worktree.
  rewrite({})
  const own = await server.call('answer', { taskId: id, answer: 'Production.', sessionMode: 'acceptEdits' })
  assert.ok(own.task !== undefined, own.text)
  await until(server, own.task.taskId)
  assert.equal(read(s, own.task.taskId, 'cwd.txt').trim(), realpathSync(first.worktree), 'it ran in the worktree the server made for the task')
  assert.equal(spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '', 'and the checkout is as it was')
})

test('a link inside the worktree that leads out of it does not take the resumed worker with it', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'sub', 'keep.txt'), 'kept\n')
  git(repo, ['add', 'sub/keep.txt'])
  git(repo, ['commit', '-q', '-m', 'a subdirectory'])
  const server = s.startIn(session)
  const started = await server.call('delegate', REQUEST(join(repo, 'sub'), { sessionMode: 'acceptEdits' }))
  const id = started.task.taskId
  await until(server, id)
  const first = meta(s, id)
  assert.equal(first.cwd, join(first.worktree, 'sub'), 'the task ran in the subdirectory of its worktree')

  const outside = join(s.root, 'outside')
  mkdirSync(outside)
  rmSync(first.cwd, { recursive: true, force: true })
  symlinkSync(outside, first.cwd)
  const escaped = await server.call('answer', { taskId: id, answer: 'Production.', sessionMode: 'acceptEdits' })
  assert.equal(code(escaped), 'cwd_out_of_scope', 'the directory that the link leads to is outside the session directory')
  assert.deepEqual(jobDirs(s).filter((dir) => existsSync(join(s.jobsDir, dir, 'argv.txt'))), [id], 'no worker was resumed there')
  assert.equal(existsSync(join(s.jobsDir, id, 'next')), false)
})

test('a branch that meta.json names is the task\'s own only when the claims of the server lead from that task to this job', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const { id } = await asked(s, server, repo)
  const first = meta(s, id)

  const wt = join(session, 'repo-wt', 'job-other')
  git(repo, ['worktree', 'add', '-q', wt, '-b', 'orq/job-other'])
  job(s.jobsDir, 'job-other', { meta: { cwd: wt, repo, baseSha: first.baseSha, branch: 'orq/job-other', worktree: wt }, files: { exit: '0', 'last.txt': 'done' }, exitAt: SECOND + 4 })
  writeFileSync(join(s.jobsDir, id, 'meta.json'), JSON.stringify({ ...first, cwd: wt, branch: 'orq/job-other', worktree: wt, runtimeMode: 'approval-required' }))
  const forged = await server.call('answer', { taskId: id, answer: 'Production.', sessionMode: 'acceptEdits' })
  assert.ok(forged.task !== undefined, forged.text)
  await until(server, forged.task.taskId)
  assert.equal(meta(s, forged.task.taskId).branch, undefined, 'the worker of another job\'s worktree runs as a shared task, with no branch of its own')

  const again = await asked(s, server, repo)
  const c1 = (await server.call('answer', { taskId: again.id, answer: 'Production.', sessionMode: 'acceptEdits' })).task.taskId
  await until(server, c1)
  writeFileSync(join(s.jobsDir, c1, 'question.txt'), 'Which tag?\n')
  const c2 = (await server.call('answer', { taskId: c1, answer: 'v2.', sessionMode: 'acceptEdits' })).task.taskId
  await until(server, c2)
  assert.equal(meta(s, c2).branch, meta(s, again.id).branch, 'a task whose claims lead to this job keeps its branch through a second answer')
  assert.equal(meta(s, c2).parent, c1)
})

const FORM = (task) => Object.entries(task.inputRequests ?? {})

test('questions: human shows the question in a form, and the answer resumes the worker inside the same task', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)

  const refused = await server.call('delegate', REQUEST(repo, { questions: 'human', sessionMode: 'acceptEdits' }), NO_TASKS)
  assert.equal(code(refused), 'invalid_request', 'a client without tasks and forms cannot be asked')
  assert.match(refused.json.error.message, /questions: human/)

  const { task } = await server.call('delegate', REQUEST(repo, { questions: 'human', sessionMode: 'acceptEdits' }), WITH_FORMS)
  const id = task.taskId
  const open = await until(server, id, ['working'])
  assert.equal(open.status, 'input_required', 'the worker asked, and the task waits for the form instead of ending')
  const [[key, request]] = FORM(open)
  assert.equal(key, `q-${id}`, 'the key names the job that asked')
  assert.match(request.params.message, new RegExp(QUESTION.replace('?', '\\?')))
  assert.equal(request.params.requestedSchema.properties.answer.type, 'string')
  assert.deepEqual(request.params.requestedSchema.required, ['answer'])

  const early = await server.call('answer', { taskId: id, answer: 'Production.' }, WITH_FORMS)
  assert.equal(code(early), 'awaiting_form', 'while the form is open it is the way to answer')
  assert.equal(existsSync(join(s.jobsDir, id, 'next')), false)

  await server.update(id, { [key]: { action: 'accept', content: { answer: 'Production, and tag it v2.' } } })
  const done = await until(server, id, ['working', 'input_required'])
  assert.equal(done.status, 'completed', 'the same task ends, with the result of the resumed worker')
  const [{ text }] = done.result.content
  assert.ok(text.startsWith('RESUMED: Production, and tag it v2.'), text)
  const claim = JSON.parse(read(s, id, 'next'))
  assert.equal(claim.via, 'form')
  assert.equal(meta(s, claim.jobId).questions, 'human')
  assert.equal(meta(s, claim.jobId).branch, meta(s, id).branch)
  assert.ok(text.includes(`Branch orq/${id}.`) && text.includes(claim.jobId), 'the merge hint names the job that finished')
  assert.equal(existsSync(join(s.jobsDir, '.tasks', claim.jobId)), false, 'the answer through the form is no new task')
})

test('a declined form, Esc, a cancel and 24 hours end the task with BLOCKED, and then the answer tool works', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const ask = async () => {
    const { task } = await server.call('delegate', REQUEST(repo, { questions: 'human', sessionMode: 'acceptEdits' }), WITH_FORMS)
    const open = await until(server, task.taskId, ['working'])
    return { id: task.taskId, key: FORM(open)[0][0] }
  }

  const declined = await ask()
  await server.update(declined.id, { [declined.key]: { action: 'decline' } })
  const ended = await server.get(declined.id)
  assert.equal(ended.status, 'completed')
  assert.equal(ended.result.isError, false)
  assert.match(ended.result.content[0].text, /^BLOCKED on a question .*Answer it with the answer tool/s)
  const viaTool = await server.call('answer', { taskId: declined.id, answer: 'Production.' }, WITH_FORMS)
  assert.ok(viaTool.task !== undefined, 'a declined form frees the answer tool')
  await until(server, viaTool.task.taskId)

  const escaped = await ask()
  await server.update(escaped.id, { [escaped.key]: { action: 'cancel' } })
  assert.equal((await server.get(escaped.id)).status, 'completed')

  const cancelled = await ask()
  await server.cancel(cancelled.id)
  assert.equal((await server.get(cancelled.id)).status, 'cancelled', 'x in /tasks on an open form cancels the task')
  const freed = await server.call('answer', { taskId: cancelled.id, answer: 'Production.' }, WITH_FORMS)
  assert.ok(freed.task !== undefined, 'a cancelled task frees the answer tool')
  await until(server, freed.task.taskId)

  const stale = await ask()
  const day = (Date.now() - 25 * 3600 * 1000) / 1000
  utimesSync(join(s.jobsDir, stale.id, 'exit'), day, day)
  const lapsed = await server.get(stale.id)
  assert.equal(lapsed.status, 'completed', 'after 24 hours the form is gone and the task ends with BLOCKED')
  assert.match(lapsed.result.content[0].text, /^BLOCKED on a question/)
  const late = await server.call('answer', { taskId: stale.id, answer: 'Production.' }, WITH_FORMS)
  assert.ok(late.task !== undefined, 'and the answer tool can answer it')
  await until(server, late.task.taskId)
})

test('a form answer is held to the ceiling again: a session mode that was lowered closes the form instead of resuming the worker', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const { task } = await server.call('delegate', REQUEST(repo, { questions: 'human', sessionMode: 'acceptEdits' }), WITH_FORMS)
  const id = task.taskId
  const [[key]] = FORM(await until(server, id, ['working']))

  // tasks/update carries no session mode; the next call of a tool that the hook serves does, and the server keeps the last one it saw.
  await server.call('answer', { taskId: 'job-nope', answer: 'x', sessionMode: 'default' })
  await server.update(id, { [key]: { action: 'accept', content: { answer: 'Production.' } } })
  const ended = await server.get(id)
  assert.equal(ended.status, 'completed', 'the form is closed, not left open')
  assert.match(ended.result.content[0].text, /^BLOCKED on a question/)
  assert.equal(existsSync(join(s.jobsDir, id, 'next')), false, 'no worker was resumed')
  assert.match(read(s, id, 'declined'), /above the ceiling now/, 'the file says why the form was closed')
  assert.deepEqual(jobDirs(s), [id])
})

test('a continuation whose supervisor has not written its pid yet keeps the human task working, and a cancel then writes its own cancel file', async (t) => {
  const s = scene({ bin: { claude: QUESTION_WORKER } })
  t.after(() => s.cleanup())
  const { session, repo } = checkout(s)
  const server = s.startIn(session)
  const { task } = await server.call('delegate', REQUEST(repo, { questions: 'human', sessionMode: 'acceptEdits' }), WITH_FORMS)
  const id = task.taskId
  await until(server, id, ['working'])
  writeFileSync(join(s.jobsDir, id, 'next'), JSON.stringify({ jobId: 'job-cont', via: 'form' }))
  job(s.jobsDir, 'job-cont', { meta: { kind: 'mcp', parent: id, questions: 'human' } })

  const starting = await server.get(id)
  assert.equal(starting.status, 'working', 'a job between its meta.json and its pid is starting, not lost')
  assert.match(starting.statusMessage, /starting/)
  await server.cancel(id)
  assert.equal(existsSync(join(s.jobsDir, 'job-cont', 'cancel')), true, 'the cancel reaches the job the task stands at')
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
