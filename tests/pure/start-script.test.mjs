import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startScript } from '../../hooks/engine.ts'

const where = (name) => {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() : null
}
const PYTHON = where('python3')
const SETSID = where('setsid')

function launch({ systemdRun, setsid }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orq-start-')))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const tool of ['bash', 'env', 'seq', 'sleep', 'ps', 'tr']) symlinkSync(where(tool), join(bin, tool))
  const wrapper = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  wrapper('systemd-run', systemdRun ? 'while [[ "$1" == --* ]]; do shift; done\n"$@" &' : 'exit 1')
  wrapper('python3', `printf '%s\\n' "$*" > '${root}/python-args'\nexec '${PYTHON}' "$@"`)
  if (setsid) wrapper('setsid', `echo used > '${root}/setsid-used'\nexec '${SETSID}' "$@"`)

  const supervise = join(root, 'supervise.sh')
  writeFileSync(
    supervise,
    [
      '#!/bin/bash',
      'echo "${CODEX_HOME:-unset}" > "$1/codex-home"',
      'ps -o pgid= -p $$ | tr -d " " > "$1/group"',
      '/bin/sh -c \'kill -s PIPE $$; echo survived\' > "$1/sigpipe"',
      'echo $$ > "$1/pgid"',
      '',
    ].join('\n'),
  )
  const dir = join(root, 'job')
  mkdirSync(dir)
  const script = startScript({ id: 'start-test', dir, supervise, runner: 'codex', cwd: root, model: 'm', env: { CODEX_HOME: 'sentinel-home' } })
  const run = spawnSync('bash', ['-c', script], { env: { PATH: bin, HOME: root }, encoding: 'utf8', timeout: 20000 })
  const read = (name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : null)
  const inJob = (name) => readFileSync(join(dir, name), 'utf8').trim()
  return { root, run, read, inJob, ranPython: read('python-args') !== null, ranSetsid: read('setsid-used') !== null }
}

test('a working systemd-run starts the job, and neither setsid nor python3 runs', (t) => {
  const job = launch({ systemdRun: true, setsid: true })
  t.after(() => rmSync(job.root, { recursive: true, force: true }))
  assert.equal(job.run.status, 0, job.run.stderr)
  assert.equal(job.inJob('scope'), 'systemd')
  assert.equal(job.ranSetsid, false)
  assert.equal(job.ranPython, false)
})

test('with setsid on the PATH and no systemd-run, setsid starts the job and python3 does not run', { skip: SETSID === null && 'no setsid on this machine' }, (t) => {
  const job = launch({ systemdRun: false, setsid: true })
  t.after(() => rmSync(job.root, { recursive: true, force: true }))
  assert.equal(job.run.status, 0, job.run.stderr)
  assert.equal(job.inJob('scope'), 'setsid')
  assert.equal(job.ranSetsid, true)
  assert.equal(job.ranPython, false, 'python3 stood in for a setsid that was there')
  assert.equal(job.inJob('group'), job.inJob('pgid'), 'the supervisor does not lead its own process group')
})

test('with neither systemd-run nor setsid, python3 starts the job as the leader of a group of its own, with its signals and env', (t) => {
  const job = launch({ systemdRun: false, setsid: false })
  t.after(() => rmSync(job.root, { recursive: true, force: true }))
  assert.equal(job.run.status, 0, job.run.stderr)
  assert.equal(job.inJob('scope'), 'python-setsid')
  assert.equal(job.ranSetsid, false)
  assert.match(job.read('python-args') ?? '', /os\.setsid\(\)/)
  assert.equal(job.inJob('group'), job.inJob('pgid'), 'the supervisor does not lead its own process group')
  assert.equal(job.inJob('sigpipe'), '', 'SIGPIPE is still ignored in the supervisor, so it reaches every CLI ignored')
  assert.equal(job.inJob('codex-home'), 'sentinel-home')
})
