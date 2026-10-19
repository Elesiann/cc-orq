import { expect, test } from 'claude-code/testing'

// The child-question paths need only launch, list and result, so this file carries a trimmed copy of
// the engine.test.ts harness. Shared helpers wait until the O3 and O4 tests settle.

const JOBS = '/srv/example/jobs'
const CODEX_HOME = '/srv/example/codex-home'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({
  jobsDir: JOBS,
  instances: [
    { id: 'codex', driver: 'codex' },
    { id: 'codex-work', driver: 'codex', env: { CODEX_HOME } },
  ],
})

type State = {
  now: number
  files: Map<string, string>
  writes: { path: string; text: string }[]
  dirEntries: { name: string; kind: string }[]
  startScripts: string[]
  commands: { name: string }[]
  mtimes: Map<string, number>
}

function fresh(o: Partial<State> = {}): State {
  return {
    now: 1000000,
    files: new Map([[CONFIG_PATH, CONFIG]]),
    writes: [],
    dirEntries: [],
    startScripts: [],
    commands: [],
    mtimes: new Map(),
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
  on('fs.stat', (_$: unknown, e: any) => {
    if (!s.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 0, mtimeMs: s.mtimes.get(e.path) ?? s.now, isLink: false } }
  })
  on('process.run', (_$: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'python3') return result(1)
    const script = argv[2] ?? ''
    if (script.includes('# orq:mkdir')) return result(0)
    if (script.includes('# orq:start')) {
      s.startScripts.push(script)
      return result(0)
    }
    if (script.includes('# orq:liveness')) return result(11)
    throw new Error(`unexpected process.run: ${script.slice(0, 80)}`)
  })
}

async function orq($: any, args: string): Promise<string> {
  const r = await $.command.run({ command: 'orq', args })
  return r.text ?? ''
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

function launchedId(text: string): string {
  const prefix = 'orq: launched '
  expect(text.startsWith(prefix)).toBe(true)
  return text.slice(prefix.length)
}

test('the job directory reaches every CLI as ORQ_JOB_DIR, through the systemd unit and the setsid fallback', async ($, on) => {
  const s = fresh({ now: 2000000 })
  stubs(on, s)
  await start($)
  const withEnv = launchedId(await orq($, 'launch codex-work fixture-model -- ask if blocked'))
  const withEnvDir = `${JOBS}/${withEnv}`
  expect(s.startScripts[0]).toContain(`--setenv=ORQ_JOB_DIR=${withEnvDir}`)
  expect(s.startScripts[0]).toContain(`setsid env CODEX_HOME=${CODEX_HOME} ORQ_JOB_DIR=${withEnvDir} bash`)
  const plain = launchedId(await orq($, 'launch codex fixture-model -- no env'))
  expect(s.startScripts[1]).toContain(`--setenv=ORQ_JOB_DIR=${JOBS}/${plain}`)
  expect(s.startScripts[1]).toContain(`setsid env ORQ_JOB_DIR=${JOBS}/${plain} bash`)
})
