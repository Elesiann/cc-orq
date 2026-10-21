import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { REFRESH_MS, clearCardState } from '../hooks/card.ts'

type Kit = Parameters<TestBody>[0]

const JOBS = '/srv/example/jobs'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({ jobsDir: JOBS })
const T0 = 1000000
const NOW = 4600000
const REFRESH_AT = NOW + REFRESH_MS
const RUNNING_LINE = 'codex · fixture-model · running · msg hello there · 60m02s'

type State = {
  files: Map<string, string>
  mtimes: Map<string, number>
  dirEntries: { name: string; kind: 'dir' }[]
  tails: Map<string, string>
  lists: number
  stats: number
  reads: number
  exists: number
  runs: number
  hangLists: number
  invalidates: number
  card: unknown
  cardVersion: number
  stateWrites: number
  statuses: (string | undefined)[]
  extractSummary: { tid: string; in: number; out: number; error: boolean }
}

function fresh(): State {
  return {
    files: new Map([[CONFIG_PATH, CONFIG]]),
    mtimes: new Map(),
    dirEntries: [],
    tails: new Map(),
    lists: 0,
    stats: 0,
    reads: 0,
    exists: 0,
    runs: 0,
    hangLists: 0,
    invalidates: 0,
    card: undefined,
    cardVersion: 0,
    stateWrites: 0,
    statuses: [],
    extractSummary: { tid: 'thread-1', in: 1, out: 1, error: false },
  }
}

/** The file and process calls so far. A band drawn from memory adds none. */
function io(s: State): Pick<State, 'lists' | 'stats' | 'reads' | 'exists' | 'runs'> {
  return { lists: s.lists, stats: s.stats, reads: s.reads, exists: s.exists, runs: s.runs }
}

const result = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

function stubs(on: On, s: State): void {
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', () => ({ sessionId: 'session-1' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => {
    s.invalidates += 1
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    s.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: s.card, version: s.cardVersion } }))
  on('state.set', (_$, e) => {
    s.stateWrites += 1
    s.card = e.value
    s.cardVersion += 1
    return { value: { isSet: true, version: s.cardVersion } }
  })
  // The kit fails a mount that no hook beneath the plugins answers ("no implementation for ui.render").
  // What the lower plugin draws stays under the card, so a test can check both survive.
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [Text({ children: 'other plugin' })] })
  })
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', (_$, e) => {
    s.exists += 1
    return { value: s.files.has(e.path) }
  })
  on('fs.read', (_$, e) => {
    s.reads += 1
    const text = s.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.list', async (_$, e) => {
    if (e.path !== JOBS) throw new Error(`ENOENT: ${e.path}`)
    s.lists += 1
    if (s.hangLists > 0) {
      s.hangLists -= 1
      await new Promise<never>(() => {})
    }
    return { value: s.dirEntries.map((d) => ({ name: d.name, kind: d.kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_$, e) => {
    s.stats += 1
    if (!s.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 0, mtimeMs: s.mtimes.get(e.path) ?? REFRESH_AT, isLink: false } }
  })
  on('process.run', (_$, e) => {
    const argv = e.argv
    s.runs += 1
    if (argv[0] === 'python3') return result(0, `${JSON.stringify(s.extractSummary)}\n`)
    const script = argv[2] ?? ''
    if (script.includes('# orq:liveness')) return result(11)
    if (script.includes('# orq-panel:tail')) {
      const id = [...s.tails.keys()].find((job) => script.includes(`${JOBS}/${job}/events.jsonl`))
      return result(0, id === undefined ? '' : (s.tails.get(id) ?? ''))
    }
    throw new Error(`unexpected process.run: ${script.slice(0, 80)}`)
  })
}

async function start($: Kit): Promise<void> {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

async function band($: Kit, surface: 'terminal' | 'desktop', props: { hasSurvey?: boolean; maxRows?: number } = {}): Promise<string> {
  const mounted = await $.ui.mount({
    plugin: 'orq',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 6,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 6 },
      view: {},
      ...props,
    },
  })
  return JSON.stringify(await mounted.drawn())
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function seedJob(s: State, id: string, startedAt: number, tail?: string): void {
  s.dirEntries.push({ name: id, kind: 'dir' })
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
    }),
  )
  if (tail !== undefined) s.tails.set(id, tail)
}

function finishWithAnswer(s: State, id: string, exitCode: string, endedAt: number): void {
  s.files.set(`${JOBS}/${id}/exit`, exitCode)
  s.mtimes.set(`${JOBS}/${id}/exit`, endedAt)
  s.files.set(`${JOBS}/${id}/last.txt`, 'The answer is 42.\n')
}

const HELLO = '{"type":"item.completed","item":{"type":"agent_message","text":"hello there"}}\n'

test('one running job draws one card line, the same on the terminal and the desktop', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(count(await band($, surface), RUNNING_LINE)).toBe(1)
  }
})

test('a survey holds the band, so the card yields and draws no card line', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  expect(count(await band($, 'terminal', { hasSurvey: true }), RUNNING_LINE)).toBe(0)
  expect(count(await band($, 'terminal'), RUNNING_LINE)).toBe(1)
})

test('maxRows 0 yields, so the card draws no card line', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  expect(count(await band($, 'terminal', { maxRows: 0 }), RUNNING_LINE)).toBe(0)
})

test('cardDisplay off draws nothing and starts no timer', { options: { cardDisplay: 'off' } }, async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  expect(s.lists).toBe(0)
  expect(s.invalidates).toBe(0)
  expect(s.statuses).toEqual([])
  expect(count(await band($, 'terminal'), RUNNING_LINE)).toBe(0)
})

test('cardDisplay status sends the line to the status line and leaves the band empty', { options: { cardDisplay: 'status' } }, async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  expect(s.statuses.at(-1)).toBe(RUNNING_LINE)
  expect(count(await band($, 'terminal'), RUNNING_LINE)).toBe(0)
})

test('five running jobs with maxRows 3 draw two card rows and a +3 more row', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  for (let i = 0; i < 5; i++) seedJob(s, `job-${i}`, T0 + i)
  await start($)
  await clock.advance(2000)
  const text = await band($, 'terminal', { maxRows: 3 })
  expect(count(text, ' · running · ')).toBe(2)
  expect(text.includes('+3 more')).toBe(true)
})

test('five running jobs with maxRows 2 draw one card row and a +4 more row', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  for (let i = 0; i < 5; i++) seedJob(s, `job-${i}`, T0 + i)
  await start($)
  await clock.advance(2000)
  const text = await band($, 'terminal', { maxRows: 2 })
  expect(count(text, ' · running · ')).toBe(1)
  expect(text.includes('"+4 more"')).toBe(true)
})

test('five running jobs with maxRows 1 draw the newest job on one row, the count first', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  for (let i = 0; i < 4; i++) seedJob(s, `job-${i}`, T0 + i)
  seedJob(s, 'job-newest', T0 + 4, HELLO)
  await start($)
  await clock.advance(2000)
  const text = await band($, 'terminal', { maxRows: 1 })
  expect(count(text, ' · running · ')).toBe(1)
  expect(count(text, '(+4 more) codex · fixture-model · running · msg hello there · ')).toBe(1)
  expect(text.includes('"+4 more"')).toBe(false)
})

test('a job whose exit file is 60 s old is dropped and one that ended 10 s ago is shown', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-old', T0, '{"type":"item.completed","item":{"type":"agent_message","text":"stale"}}\n')
  finishWithAnswer(s, 'job-old', '0', REFRESH_AT - 60000)
  seedJob(s, 'job-fresh', T0, '{"type":"item.completed","item":{"type":"agent_message","text":"wrapped up"}}\n')
  finishWithAnswer(s, 'job-fresh', '0', REFRESH_AT - 10000)
  await start($)
  await clock.advance(2000)
  const text = await band($, 'terminal')
  expect(count(text, ' · done · ')).toBe(1)
  expect(text.includes('codex · fixture-model · done · msg wrapped up · 59m52s')).toBe(true)
  expect(text.includes('stale')).toBe(false)
})

test('session.end on /clear or a resume keeps the timer, and on any other reason stops it', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  expect(s.lists).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  await clock.advance(2000)
  expect(s.lists).toBe(2)
  await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-1' } })
  await clock.advance(2000)
  expect(s.lists).toBe(3)
  await $.session.end({ reason: 'other', sessionId: 'session-1', resume: { id: 'session-1' } })
  await clock.advance(2000)
  expect(s.lists).toBe(3)
})

test('the band keeps what the plugins beneath it draw, with the card line', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  const text = await band($, 'terminal')
  expect(text.includes('other plugin')).toBe(true)
  expect(count(text, RUNNING_LINE)).toBe(1)
})

test('drawing the band after a refresh reads no file and runs no process', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  const before = io(s)
  expect(before.lists > 0 && before.reads > 0 && before.runs > 0).toBe(true)
  expect(count(await band($, 'terminal'), RUNNING_LINE)).toBe(1)
  expect(count(await band($, 'desktop'), RUNNING_LINE)).toBe(1)
  expect(io(s)).toEqual(before)
})

test('a refresh stuck for over 60 s no longer blocks the next tick', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  s.hangLists = 1
  await start($)
  await clock.advance(2000)
  expect(s.lists).toBe(1)
  for (let i = 0; i < 29; i++) await clock.advance(2000)
  expect(s.lists).toBe(1)
  await clock.advance(2000)
  expect(s.lists).toBe(2)
  expect(count(await band($, 'terminal'), ' · running · ')).toBe(1)
})

test('an empty band writes no state and does not invalidate on each tick', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await clock.advance(6000)
  expect(s.lists).toBe(3)
  expect(s.stateWrites).toBe(0)
  expect(s.invalidates).toBe(0)
})

test('the band draws from session state, so a reloaded module draws the card before its first tick', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  expect(s.stateWrites).toBe(1)
  clearCardState()
  const before = io(s)
  expect(count(await band($, 'terminal'), RUNNING_LINE)).toBe(1)
  expect(io(s)).toEqual(before)
})

test('a session end for any reason but /clear or a resume empties the card', async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  expect(count(await band($, 'terminal'), RUNNING_LINE)).toBe(1)
  await $.session.end({ reason: 'other', sessionId: 'session-1', resume: { id: 'session-1' } })
  expect(s.card).toEqual([])
  expect(count(await band($, 'terminal'), RUNNING_LINE)).toBe(0)
})

test('starting in status mode empties band rows an earlier band session left in state', { options: { cardDisplay: 'status' } }, async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  mock.clock(on, { now: NOW })
  s.card = [{ id: 'job-old', instance: 'codex', model: 'fixture-model', status: 'running', lastAction: '—', durationMs: 1000 }]
  await start($)
  expect(s.card).toEqual([])
})

test('a session end in status mode clears the status line', { options: { cardDisplay: 'status' } }, async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0, HELLO)
  await start($)
  await clock.advance(2000)
  expect(s.statuses.at(-1)).toBe(RUNNING_LINE)
  await $.session.end({ reason: 'other', sessionId: 'session-1', resume: { id: 'session-1' } })
  expect(s.statuses.at(-1)).toBe(undefined)
})

test('status mode clears a status line an earlier instance left, once, on the first refresh with no rows', { options: { cardDisplay: 'status' } }, async ($, on) => {
  clearCardState()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await clock.advance(2000)
  await clock.advance(2000)
  expect(s.lists).toBe(2)
  expect(s.statuses).toEqual([undefined])
})
