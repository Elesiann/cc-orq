import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultConfig } from '../../hooks/config.ts'
import { isFailure } from '../../hooks/contract.ts'
import { composeAnswer, jobView, launchTaskFromHeader, newJobId, readJobStatus, readMeta } from '../../hooks/engine.ts'
import { parseTaskHeader } from '../../hooks/task-header.ts'
import { parentRuntimeModeFromPermissionMode } from '../../hooks/target.ts'
import { parseJobMeta } from '../../hooks/types.ts'
import { nodeEngine } from '../../server/node-engine.ts'

const AUTHOR = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'orq test',
  GIT_AUTHOR_EMAIL: 'orq@example.invalid',
  GIT_COMMITTER_NAME: 'orq test',
  GIT_COMMITTER_EMAIL: 'orq@example.invalid',
}
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CEILING = parentRuntimeModeFromPermissionMode('acceptEdits')
const WAIT_MS = 20000

function writeFakeClaude(bin) {
  mkdirSync(bin, { recursive: true })
  const file = join(bin, 'claude')
  writeFileSync(
    file,
    [
      '#!/bin/bash',
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"ses-fake"}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"ses-fake","result":"FAKE-CLAUDE","usage":{"input_tokens":11,"output_tokens":4},"modelUsage":{"fake-claude-model":{}}}'`,
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(file, 0o755)
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orq-launch-')))
  const bin = join(root, 'bin')
  writeFakeClaude(bin)
  const engine = nodeEngine({
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...AUTHOR },
    pluginRoot: REPO,
  })
  const config = { ...defaultConfig(root), jobsDir: join(root, 'jobs') }
  const session = join(root, 'session')
  mkdirSync(session)
  return { root, session, engine, config }
}

function headerFor(cwd, isolation, { target = 'claudeAgent haiku', role } = {}) {
  const roleLine = role === undefined ? '' : `role: ${role}\n`
  const header = parseTaskHeader(`target: ${target}\n${roleLine}cwd: ${cwd}\nisolation: ${isolation}\n\nsay PONG`)
  assert.equal(isFailure(header), false, JSON.stringify(header))
  return header
}

function readJobDir(job) {
  const read = (name) => readFileSync(join(job.dir, name), 'utf8')
  return {
    meta: JSON.parse(read('meta.json')),
    flags: existsSync(join(job.dir, 'flags')) ? read('flags') : null,
    prompt: read('prompt.txt'),
  }
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...AUTHOR } })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function untilEnded(engine, job) {
  const stopAt = Date.now() + WAIT_MS
  for (;;) {
    const view = await jobView(engine, job)
    if (!['running', 'cancelling', 'waiting'].includes(view.status)) return view
    assert.ok(Date.now() < stopAt, `job ${job.id} is still ${view.status} after ${WAIT_MS} ms`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

test('a shared task launches with no session host and reads back as completed', async () => {
  const { root, session, engine, config } = setup()
  try {
    const work = join(session, 'work')
    mkdirSync(work)
    const launched = await launchTaskFromHeader(engine, config, {
      agentId: 'agent-shared',
      header: headerFor(work, 'shared'),
      ceiling: CEILING,
      sessionDir: session,
    })
    assert.ok('job' in launched, JSON.stringify(launched))
    const { job } = launched
    const view = await untilEnded(engine, job)

    const meta = await readMeta(engine, config.jobsDir, job.id)
    assert.equal(meta?.id, job.id)
    assert.equal(meta?.dir, job.dir)
    assert.equal(meta?.cwd, work)
    const parsed = parseJobMeta(JSON.parse(readFileSync(join(job.dir, 'meta.json'), 'utf8')), config.jobsDir, job.id)
    assert.equal(parsed?.id, job.id)

    assert.equal(readFileSync(join(job.dir, 'exit'), 'utf8').trim(), '0')
    assert.equal(view.status, 'done')

    const status = await readJobStatus(engine, config, job.id)
    assert.equal(status?.status, 'completed')
    assert.equal(status?.result, 'FAKE-CLAUDE')

    const answer = await composeAnswer(engine, config, job)
    assert.ok(answer.includes('FAKE-CLAUDE'), answer)
    assert.ok(answer.includes(`taskId ${job.id}`), answer)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the job directory holds the model, instance, modes, flags, role and task that the header and the ceiling resolve to', async () => {
  const { root, session, engine, config } = setup()
  try {
    const work = join(session, 'work')
    mkdirSync(work)
    const launched = await launchTaskFromHeader(engine, config, {
      agentId: 'agent-resolved',
      header: headerFor(work, 'shared', { target: 'claudeAgent fixture-model-7 effort=high runtime=approval-required', role: 'review' }),
      ceiling: CEILING,
      sessionDir: session,
    })
    assert.ok('job' in launched, JSON.stringify(launched))
    await untilEnded(engine, launched.job)

    const { meta, flags, prompt } = readJobDir(launched.job)
    assert.equal(meta.model, 'fixture-model-7')
    assert.equal(meta.instanceId, 'claudeAgent')
    assert.equal(meta.runtimeMode, 'approval-required')
    assert.equal(meta.interactionMode, 'default')
    assert.equal(meta.effort, 'high')
    assert.equal(flags, '--permission-mode\nmanual\n--effort\nhigh\n')
    assert.ok(prompt.startsWith('Act as the review sub-agent for this task.\n\nsay PONG'), prompt)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const { permissionMode, runtimeMode, interactionMode, flags } of [
  { permissionMode: 'acceptEdits', runtimeMode: 'auto-accept-edits', interactionMode: 'default', flags: '--permission-mode\nacceptEdits\n' },
  { permissionMode: 'plan', runtimeMode: 'approval-required', interactionMode: 'plan', flags: '--permission-mode\nplan\n' },
]) {
  test(`a header that sets no mode runs under the ceiling of a parent in ${permissionMode} mode`, async () => {
    const { root, session, engine, config } = setup()
    try {
      const work = join(session, 'work')
      mkdirSync(work)
      const launched = await launchTaskFromHeader(engine, config, {
        agentId: 'agent-inherits',
        header: headerFor(work, 'shared'),
        ceiling: parentRuntimeModeFromPermissionMode(permissionMode),
        sessionDir: session,
      })
      assert.ok('job' in launched, JSON.stringify(launched))
      await untilEnded(engine, launched.job)

      const job = readJobDir(launched.job)
      assert.equal(job.meta.runtimeMode, runtimeMode)
      assert.equal(job.meta.interactionMode, interactionMode)
      assert.equal(job.flags, flags)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('a worktree task runs on its own branch under REPO-wt, and its launch runs no repository hook', async () => {
  const { root, session, engine, config } = setup()
  const repo = join(session, 'repo')
  let worktree = null
  try {
    mkdirSync(repo)
    writeFileSync(join(repo, 'README.md'), 'orq launch test\n')
    git(repo, ['init', '-q'])
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-q', '-m', 'Initial commit'])

    const marker = join(root, 'post-checkout-ran')
    const hook = join(repo, '.git', 'hooks', 'post-checkout')
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`)
    chmodSync(hook, 0o755)

    const control = join(session, 'control')
    git(repo, ['worktree', 'add', '-q', '-b', 'control', control, 'HEAD'])
    assert.equal(existsSync(marker), true, 'control: a plain git worktree add must run post-checkout, or the absent marker proves nothing')
    rmSync(marker)
    git(repo, ['worktree', 'remove', '--force', control])
    git(repo, ['branch', '-D', 'control'])

    const launched = await launchTaskFromHeader(engine, config, {
      agentId: 'agent-worktree',
      header: headerFor(repo, 'worktree'),
      ceiling: CEILING,
      sessionDir: session,
    })
    assert.ok('job' in launched, JSON.stringify(launched))
    const { job } = launched
    worktree = join(session, 'repo-wt', job.id)
    const view = await untilEnded(engine, job)

    assert.equal(view.status, 'done')
    const meta = await readMeta(engine, config.jobsDir, job.id)
    assert.equal(meta?.worktree, worktree)
    assert.equal(meta?.branch, `orq/${job.id}`)
    assert.equal(meta?.cwd, worktree)
    assert.equal(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), `orq/${job.id}`)
    assert.equal(existsSync(marker), false, 'the post-checkout hook ran during the job launch')
  } finally {
    if (worktree !== null) spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree], { env: { ...process.env, ...AUTHOR } })
    rmSync(root, { recursive: true, force: true })
  }
})

test('a cwd outside the session directory is refused as text, and no job directory is made', async () => {
  const { root, session, engine, config } = setup()
  try {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const launched = await launchTaskFromHeader(engine, config, {
      agentId: 'agent-refused',
      header: headerFor(outside, 'shared'),
      ceiling: CEILING,
      sessionDir: session,
    })
    assert.ok('refusal' in launched, JSON.stringify(launched))
    assert.equal(
      launched.refusal,
      `orq: task refused (taskId none): cwd_out_of_scope: cwd ${outside} is outside the session directory and the allowed roots (${session}).`,
    )
    assert.deepEqual(existsSync(config.jobsDir) ? readdirSync(config.jobsDir) : [], [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a header that asks for more than the ceiling allows is refused as text, and no job directory is made', async () => {
  const { root, session, engine, config } = setup()
  try {
    const work = join(session, 'work')
    mkdirSync(work)
    const launched = await launchTaskFromHeader(engine, config, {
      agentId: 'agent-escalates',
      header: headerFor(work, 'shared', { target: 'claudeAgent haiku runtime=full-access' }),
      ceiling: CEILING,
      sessionDir: session,
    })
    assert.ok('refusal' in launched, JSON.stringify(launched))
    assert.equal(
      launched.refusal,
      'orq: task refused (taskId none): runtime_mode_escalation_denied: Child runtime mode full-access is broader than parent mode auto-accept-edits.',
    )
    assert.deepEqual(existsSync(config.jobsDir) ? readdirSync(config.jobsDir) : [], [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('newJobId joins the kind, the clock, the last eight characters of the agent id and six random characters', () => {
  assert.match(newJobId('mcp', 1700000000000, 'session-0123456789'), /^mcp-1700000000000-23456789-[0-9a-z]{6}$/)
  assert.match(newJobId('task', 5, 'mcp'), /^task-5-mcp-[0-9a-z]{6}$/)
  assert.notEqual(newJobId('mcp', 1, 'a'), newJobId('mcp', 1, 'a'))
})

test('a launch that is given an id runs the job under it, and a taken id is refused and is not replaced by another', async () => {
  const { root, session, engine, config } = setup()
  try {
    const work = join(session, 'work')
    mkdirSync(work)
    const id = newJobId('mcp', Date.now(), 'agent-reserved')
    const launch = () =>
      launchTaskFromHeader(engine, config, { agentId: 'agent-reserved', header: headerFor(work, 'shared'), ceiling: CEILING, sessionDir: session, kind: 'mcp', reservedId: id })
    const first = await launch()
    assert.ok('job' in first, JSON.stringify(first))
    assert.equal(first.job.id, id)
    assert.equal(first.job.dir, join(config.jobsDir, id))
    assert.equal(JSON.parse(readFileSync(join(first.job.dir, 'meta.json'), 'utf8')).id, id)
    await untilEnded(engine, first.job)

    const second = await launch()
    assert.ok('refusal' in second, JSON.stringify(second))
    assert.match(second.refusal, /could not create its job directory \(exit 7\)/)
    assert.deepEqual(readdirSync(config.jobsDir).filter((name) => !name.startsWith('.')), [id], 'no other job directory was made for the taken id')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
