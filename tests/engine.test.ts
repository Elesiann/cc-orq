import { expect, test } from 'claude-code/testing'

import { parseLaunch } from '../hooks/engine.ts'
import {
  buildFooter,
  failureSnippet,
  formatDuration,
  isSafeJobId,
  redactSecrets,
  renderTable,
  shellWord,
} from '../hooks/types.ts'

// The job directory, the config file and the CODEX_HOME an instance overrides.
const JOBS = '/srv/example/jobs'
const CODEX_HOME = '/srv/example/codex-home'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({
  jobsDir: JOBS,
  instances: [
    { id: 'codex', driver: 'codex' },
    { id: 'codex-lane', driver: 'codex', env: { CODEX_HOME } },
    { id: 'claudeAgent', driver: 'claudeAgent' },
  ],
})

type State = {
  now: number
  files: Map<string, string>
  writes: { path: string; text: string }[]
  dirEntries: { name: string; kind: string }[]
  mkdirScripts: string[]
  startScripts: string[]
  probeScripts: string[]
  commands: { name: string }[]
  mkdirExit: number
  startExit: number
  stderrTail: string
  extractFail: boolean
  extractSummary: { tid: string; in: number; out: number; error: boolean; model?: string }
  rolloutPath: string
}

function fresh(o: Partial<State> = {}): State {
  return {
    now: 1000000,
    files: new Map([[CONFIG_PATH, CONFIG]]),
    writes: [],
    dirEntries: [],
    mkdirScripts: [],
    startScripts: [],
    probeScripts: [],
    commands: [],
    mkdirExit: 0,
    startExit: 0,
    stderrTail: '',
    extractFail: false,
    extractSummary: { tid: '', in: 0, out: 0, error: false },
    rolloutPath: '',
    ...o,
  }
}

const result = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

function stubs(on: any, s: State) {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', (_$: unknown, e: any) => {
    s.commands.push(e)
    return { value: { command: e.name } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/test' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('clock.now', () => ({ value: s.now }))
  on('fs.exists', (_$: unknown, e: any) => ({ value: s.files.has(e.path) }))
  on('fs.read', (_$: unknown, e: any) => {
    if (s.files.has(e.path)) return { value: s.files.get(e.path) }
    if (String(e.path).endsWith('/pgid')) return { value: '4242\n' }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', (_$: unknown, e: any) => {
    s.writes.push({ path: e.path, text: e.text })
    s.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_$: unknown, e: any) => {
    if (e.path !== JOBS) throw new Error(`ENOENT: ${e.path}`)
    return { value: s.dirEntries.map((d) => ({ name: d.name, kind: d.kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_$: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'python3') {
      if (s.extractFail) return result(1)
      return result(0, JSON.stringify(s.extractSummary) + '\n')
    }
    const script = argv[2] ?? ''
    if (script.includes('# orq:mkdir')) {
      s.mkdirScripts.push(script)
      return result(s.mkdirExit)
    }
    if (script.includes('# orq:start')) {
      s.startScripts.push(script)
      return result(s.startExit)
    }
    if (script.includes('# orq:rollout')) {
      s.probeScripts.push(script)
      return result(0, s.rolloutPath ? `${s.rolloutPath}\n` : '\n')
    }
    if (script.includes('# orq:stderr')) return result(0, s.stderrTail)
    throw new Error(`unexpected process.run: ${script.slice(0, 80)}`)
  })
}

// The kit's command.run also takes the origin and presentation the engine sets; a test sends the name and args only.
async function orq($: any, args: string): Promise<string> {
  const r = await $.command.run({ command: 'orq', args })
  return r.text ?? ''
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

function seedJob(s: State, id: string, extra: Record<string, unknown> = {}, startedAt = 1000000) {
  s.files.set(
    `${JOBS}/${id}/meta.json`,
    JSON.stringify({
      id,
      kind: 'manual',
      agentId: 'manual',
      cwd: '/work',
      startedAt,
      startedAtIso: new Date(startedAt).toISOString(),
      runner: 'codex',
      model: 'fixture-model',
      instanceId: 'codex',
      driver: 'codex',
      ...extra,
    }),
  )
}

function launchedId(text: string): string {
  const prefix = 'orq: launched '
  expect(text.startsWith(prefix)).toBe(true)
  return text.slice(prefix.length)
}

test('session.start declares /orq in the typeahead', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect(s.commands.map((c) => c.name)).toEqual(['orq'])
})

test('launch prints the job id, writes meta.json and prompt.txt, and creates the directory atomically', async ($, on) => {
  const s = fresh({ now: 2000000 })
  stubs(on, s)
  await start($)
  const r = await orq($, 'launch codex fixture-model -- Do the thing')
  const id = launchedId(r)
  expect(id.startsWith('manual-2000000-manual-')).toBe(true)
  expect(s.mkdirScripts.length).toBe(1)
  expect(s.mkdirScripts[0]).toContain(`mkdir -p ${JOBS}`)
  expect(s.mkdirScripts[0]).toContain(`mkdir ${JOBS}/${id}`)
  const meta = JSON.parse(s.writes.find((w) => w.path.endsWith('/meta.json'))?.text ?? 'null')
  expect(meta).toEqual({
    id,
    kind: 'manual',
    agentId: 'manual',
    cwd: '/work',
    startedAt: 2000000,
    startedAtIso: new Date(2000000).toISOString(),
    runner: 'codex',
    model: 'fixture-model',
    instanceId: 'codex',
    driver: 'codex',
  })
  expect(s.writes.find((w) => w.path.endsWith('/prompt.txt'))?.text).toBe('Do the thing')
  expect(s.startScripts.length).toBe(1)
})

test('two launches in the same millisecond get different job ids', async ($, on) => {
  const s = fresh({ now: 2100000 })
  stubs(on, s)
  await start($)
  const a = launchedId((await orq($, 'launch codex fixture-model -- one')))
  const b = launchedId((await orq($, 'launch codex fixture-model -- two')))
  expect(a === b).toBe(false)
})

test('a failed mkdir refuses the launch, and a name clash retries once', async ($, on) => {
  const clash = fresh({ mkdirExit: 7 })
  stubs(on, clash)
  await start($)
  const refused = await orq($, 'launch codex fixture-model -- go')
  expect(refused).toContain('could not create its job directory (exit 7)')
  expect(clash.mkdirScripts.length).toBe(2)
  expect(clash.startScripts.length).toBe(0)
})

test('a supervisor that never reports refuses the launch and records exit 125', async ($, on) => {
  const s = fresh({ startExit: 11 })
  stubs(on, s)
  await start($)
  const r = await orq($, 'launch codex fixture-model -- go')
  expect(r).toContain('did not report within 5 s')
  expect(s.writes.find((w) => w.path.endsWith('/exit'))?.text).toBe('125')
})

test('the instance env reaches the systemd unit and the setsid fallback', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  await orq($, 'launch codex-lane fixture-model -- with env')
  const withEnv = s.startScripts[0] ?? ''
  expect(withEnv).toContain(`--setenv=CODEX_HOME=${CODEX_HOME}`)
  expect(withEnv).toContain(`setsid env CODEX_HOME=${CODEX_HOME} bash`)
  await orq($, 'launch codex fixture-model -- no env')
  expect(s.startScripts[1]?.includes('CODEX_HOME')).toBe(false)
  expect(s.startScripts[1]).toContain('--unit=orq-manual-')
})

test('refused launches say what is wrong', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect((await orq($, 'launch nope fixture-model -- go'))).toContain(
    'unknown instance nope (configured: codex, codex-lane, claudeAgent)',
  )
  expect((await orq($, 'launch codex fixture-model --'))).toBe(
    'orq: the prompt after -- is empty',
  )
  expect((await orq($, 'launch codex -x -- go'))).toBe(
    'orq: the model must not start with "-"',
  )
  expect((await orq($, 'launch codex fixture-model go'))).toBe(
    'orq: usage: /orq launch INSTANCE MODEL -- PROMPT',
  )
  expect(s.mkdirScripts.length).toBe(0)
})

test('list shows the newest jobs with running, cancelling, done, failed and cancelled status', async ($, on) => {
  const s = fresh({ now: 4600000 })
  s.dirEntries = [
    { name: 'job-running', kind: 'dir' },
    { name: 'job-cancelling', kind: 'dir' },
    { name: 'job-done', kind: 'dir' },
    { name: 'job-failed', kind: 'dir' },
    { name: 'job-cancelled', kind: 'dir' },
    { name: 'stray.txt', kind: 'file' },
  ]
  seedJob(s, 'job-running', {}, 4000000)
  seedJob(s, 'job-cancelling', {}, 3000000)
  s.files.set(`${JOBS}/job-cancelling/cancel`, 'cancelled at now\n')
  seedJob(s, 'job-done', {}, 2000000)
  s.files.set(`${JOBS}/job-done/exit`, '0')
  s.files.set(`${JOBS}/job-done/last.txt`, 'OK')
  seedJob(s, 'job-failed', {}, 1500000)
  s.files.set(`${JOBS}/job-failed/exit`, '1')
  seedJob(s, 'job-cancelled', {}, 1200000)
  s.files.set(`${JOBS}/job-cancelled/exit`, '124')
  stubs(on, s)
  await start($)
  const text = (await orq($, 'list'))
  const lines = text.split('\n')
  expect(lines.length).toBe(6)
  expect(lines[0]).toMatch(/^id\s+kind\s+status\s+elapsed\s+cwd$/)
  const statusOf = (id: string) => lines.find((l) => l.startsWith(id))?.split(/\s+/)[2]
  expect(lines.map((l) => l.split(/\s+/)[0])).toEqual([
    'id',
    'job-running',
    'job-cancelling',
    'job-done',
    'job-failed',
    'job-cancelled',
  ])
  expect(statusOf('job-running')).toBe('running')
  expect(statusOf('job-cancelling')).toBe('cancelling')
  expect(statusOf('job-done')).toBe('done')
  expect(statusOf('job-failed')).toBe('failed')
  expect(statusOf('job-cancelled')).toBe('cancelled')
})

test('list reads a job whose meta.json has only the required fields', async ($, on) => {
  const s = fresh({ now: 1000900 })
  s.dirEntries = [{ name: 'job-min', kind: 'dir' }]
  s.files.set(`${JOBS}/job-min/meta.json`, JSON.stringify({ id: 'job-min', kind: 'manual', agentId: 'manual', cwd: '/w', startedAt: 1000000 }))
  stubs(on, s)
  await start($)
  const lines = (await orq($, 'list')).split('\n')
  expect(lines[1]?.split(/\s+/)).toEqual(['job-min', 'manual', 'running', '0s', '/w'])
})

test('list with no job directories says so', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect((await orq($, 'list'))).toBe('orq: no jobs yet')
})

test('cancel writes the cancel file for a known job and refuses any other id', async ($, on) => {
  const s = fresh()
  seedJob(s, 'job-a')
  stubs(on, s)
  await start($)
  expect((await orq($, 'cancel job-a'))).toBe('orq: cancel requested for job-a')
  expect(s.writes.some((w) => w.path === `${JOBS}/job-a/cancel`)).toBe(true)
  expect((await orq($, 'cancel ../x'))).toBe('orq: unknown job ../x')
  expect((await orq($, 'cancel'))).toBe('orq: unknown job (missing)')
})

test('parseLaunch splits at the first -- and refuses what cannot run', () => {
  expect(parseLaunch('codex fixture-model -- do -- it')).toEqual({ instance: 'codex', model: 'fixture-model', prompt: 'do -- it' })
  expect(parseLaunch('codex fixture-model -- -dash prompt')).toEqual({ instance: 'codex', model: 'fixture-model', prompt: '-dash prompt' })
  expect(parseLaunch('codex fixture-model --')).toEqual({ error: 'the prompt after -- is empty' })
  expect(parseLaunch('codex -- go')).toEqual({ error: 'usage: /orq launch INSTANCE MODEL -- PROMPT' })
})

test('shell words, footer, duration, job ids and redaction keep their contracts', () => {
  expect(shellWord('/srv/a.b-c_d:e@f')).toBe('/srv/a.b-c_d:e@f')
  expect(shellWord("it's a b")).toBe(`'it'\\''s a b'`)
  expect(shellWord('')).toBe(`''`)
  expect(formatDuration(45000)).toBe('45s')
  expect(formatDuration(725000)).toBe('12m05s')
  expect(
    buildFooter({ kind: 'manual', model: 'm', effort: 'n/a', durationMs: 60000, inTokens: null, outTokens: null, session: 's' }),
  ).toBe('— orq · manual · m · effort n/a · 1m · tokens unknown · session s')
  expect(isSafeJobId('manual-1-a1b2c3d4-xyz')).toBe(true)
  expect(isSafeJobId('../evil')).toBe(false)
  expect(isSafeJobId('a/b')).toBe(false)
  expect(renderTable([{ id: 'a', kind: 'manual', status: 'running', elapsed: '6m', cwd: '/work' }])).toContain('running')
  const prose = 'exit 1: command not found: codex\nno credentials here, just words'
  expect(redactSecrets(prose)).toBe(prose)
  expect(failureSnippet(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')).split('\n').length).toBe(20)
})
