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
import { composeAnswer, jobView, launchTaskFromHeader, readJobStatus, readMeta } from '../../hooks/engine.ts'
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

function headerFor(cwd, isolation) {
  const header = parseTaskHeader(`target: claudeAgent haiku\ncwd: ${cwd}\nisolation: ${isolation}\n\nsay PONG`)
  assert.equal(isFailure(header), false, JSON.stringify(header))
  return header
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

test('a worktree task runs on its own branch under REPO-wt, and git runs with repository hooks off', async () => {
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
