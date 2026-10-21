import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On, UiPane } from 'claude-code'

import {
  PANEL_COMMAND,
  PANEL_ID,
  PANEL_TITLE,
  clearPanelSelection,
  renderEventLine,
  renderTail,
} from '../hooks/panel.ts'

type Kit = Parameters<TestBody>[0]

const JOBS = '/srv/example/jobs'
const CONFIG_PATH = '/home/test/.config/orq/config.json'
const CONFIG = JSON.stringify({ jobsDir: JOBS })
const T0 = 1000000
const EXIT_AT = 2000000
const NOW = 4600000

type State = {
  files: Map<string, string>
  writes: { path: string; text: string }[]
  dirEntries: { name: string; kind: 'dir' }[]
  goneJobs: Set<string>
  tails: Map<string, string>
  commands: { name: string; description: string }[]
  opens: unknown[]
  invalidates: unknown[]
  panes: UiPane[]
  panesCalls: number
  closes: string[]
  logs: string[]
  extracts: number
  unreadable: Set<string>
  extractSummary: { tid: string; in: number; out: number; error: boolean }
}

function fresh(): State {
  return {
    files: new Map([[CONFIG_PATH, CONFIG]]),
    writes: [],
    dirEntries: [],
    goneJobs: new Set(),
    tails: new Map(),
    commands: [],
    opens: [],
    invalidates: [],
    panes: [],
    panesCalls: 0,
    closes: [],
    logs: [],
    extracts: 0,
    unreadable: new Set(),
    extractSummary: { tid: 'thread-1', in: 1, out: 1, error: false },
  }
}

const result = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

function stubs(on: On, s: State): void {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', (_$, e) => {
    s.commands.push({ name: e.name, description: e.description ?? '' })
    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    s.opens.push(e)
    s.panes = [...s.panes.filter((p) => p.id !== e.id), { id: e.id, title: e.title ?? e.id, isShown: true, isFocused: true, isPlaced: true }]
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    s.closes.push(e.id)
    s.panes = s.panes.filter((p) => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => {
    s.panesCalls += 1
    return { value: s.panes }
  })
  on('ui.invalidate', (_$, e) => {
    s.invalidates.push(e)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    s.logs.push(e.text)
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/home/test' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', (_$, e) => ({ value: s.files.has(e.path) }))
  on('fs.read', (_$, e) => {
    // A host that answers a number where it should answer text makes the engine's readQuestion throw.
    if (s.unreadable.has(e.path)) return { value: 42 as unknown as string }
    const text = s.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    s.writes.push({ path: e.path, text: e.text })
    s.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    if (e.path !== JOBS) throw new Error(`ENOENT: ${e.path}`)
    return { value: s.dirEntries.map((d) => ({ name: d.name, kind: d.kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_$, e) => {
    if (!s.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 0, mtimeMs: EXIT_AT, isLink: false } }
  })
  on('process.run', (_$, e) => {
    const argv = e.argv
    if (argv[0] === 'python3') {
      s.extracts += 1
      return result(0, `${JSON.stringify(s.extractSummary)}\n`)
    }
    const script = argv[2] ?? ''
    if (script.includes('# orq:liveness')) {
      const gone = [...s.goneJobs].some((id) => script.includes(`${JOBS}/${id}/pgid`))
      return result(gone ? 12 : 11)
    }
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

// The kit's command.run also takes the origin and presentation the engine sets; a test sends the name and args only.
async function panel($: any, args: string): Promise<string> {
  const r = await $.command.run({ command: PANEL_COMMAND, args })
  return r.text ?? ''
}

/** The pane as the engine draws it: the kit mounts it, and the panel's own render hook answers. */
async function mountPane($: Kit) {
  return $.ui.mount({
    plugin: 'orq',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANEL_ID,
    props: { title: PANEL_TITLE, isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
}

async function drawn($: Kit): Promise<string> {
  const mounted = await mountPane($)
  const text = JSON.stringify(await mounted.drawn())
  await mounted.unmount()
  return text
}

function seedJob(s: State, id: string, startedAt: number): void {
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
}

/** The job ended with this exit code and a final message, so a 0 exit reads as done. */
function finish(s: State, id: string, exitCode: string): void {
  s.files.set(`${JOBS}/${id}/exit`, exitCode)
  s.files.set(`${JOBS}/${id}/last.txt`, 'The answer is 42.\n')
}

test('session start declares /orq-panel as its own command beside /orq', async ($, on) => {
  const s = fresh()
  stubs(on, s)
  await start($)
  expect(s.commands.map((c) => c.name)).toEqual(['orq', PANEL_COMMAND])
  expect(s.commands[1]?.description.includes('orq')).toBe(true)
})

test('codex event lines render time, kind and short text', () => {
  expect(renderEventLine('{"type":"thread.started","thread_id":"abcdef123456"}')).toBe('start thread abcdef12')
  expect(
    renderEventLine('{"type":"item.completed","item":{"type":"agent_message","text":"  Fixed the bug\\nin two files  "}}'),
  ).toBe('msg Fixed the bug in two files')
  expect(renderEventLine('{"type":"item.completed","item":{"type":"command_execution"}}')).toBe('command_execution')
  expect(renderEventLine('{"type":"item.completed","item":{"type":"reasoning"}}')).toBe('reasoning')
  expect(renderEventLine('{"type":"item.completed","item":{"type":"error","message":"boom"}}')).toBe('error boom')
  expect(renderEventLine('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}')).toBe(
    'tokens 100 in / 5 out',
  )
  expect(renderEventLine('not json')).toBe(null)
  expect(renderEventLine('{"type":"session_meta","payload":{}}')).toBe(null)
})

test('opencode event lines render time, kind and short text', () => {
  expect(
    renderEventLine(
      '{"type":"step","timestamp":1791310425,"sessionID":"ses_1","part":{"type":"text","text":"mid work"}}',
    ),
  ).toBe('18:13:45 msg mid work')
  expect(renderEventLine('{"type":"step","sessionID":"ses_1","part":{"type":"tool","name":"read"}}')).toBe('tool read')
  expect(renderEventLine('{"type":"step","sessionID":"ses_1","part":{"type":"tool"}}')).toBe('tool tool')
  expect(
    renderEventLine(
      '{"type":"step","sessionID":"ses_1","part":{"type":"step-finish","reason":"stop","tokens":{"input":7,"output":3}}}',
    ),
  ).toBe('tokens 7 in / 3 out')
  expect(renderEventLine('')).toBe(null)
})

test('claude stream rows from the fixture render start, the reply and the tokens', () => {
  expect(renderEventLine('{"type":"system","subtype":"init","session_id":"fixture-claude-session"}')).toBe('start')
  expect(
    renderEventLine(
      '{"type":"assistant","session_id":"fixture-claude-session","message":{"content":[{"type":"text","text":"OK"}]}}',
    ),
  ).toBe('msg OK')
  expect(
    renderEventLine(
      '{"type":"result","subtype":"success","is_error":false,"session_id":"fixture-claude-session","result":"OK","usage":{"input_tokens":44,"cache_creation_input_tokens":30992,"cache_read_input_tokens":217386,"output_tokens":3670},"modelUsage":{"fixture-model-claude":{"inputTokens":44,"outputTokens":3670}}}',
    ),
  ).toBe('tokens 44 in / 3670 out')
})

test('claude rows name the last tool use, skip tool results, and fall back to result', () => {
  expect(
    renderEventLine(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading"},{"type":"tool_use","name":"Bash"}]}}',
    ),
  ).toBe('tool Bash')
  expect(renderEventLine('{"type":"assistant","message":{"content":[]}}')).toBe(null)
  expect(renderEventLine('{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}')).toBe(null)
  expect(renderEventLine('{"type":"result","subtype":"success"}')).toBe('result')
})

test('agy stream rows from the fixture render start, the step and the tokens', () => {
  expect(
    renderEventLine('{"event":"init","conversation_id":"fixture-agy-session","init":{"model":"fixture-model-agy"}}'),
  ).toBe('start')
  expect(
    renderEventLine(
      '{"event":"step_update","step_update":{"conversation_id":"fixture-agy-session","step_index":1,"state":"DONE","step_type":"agent_response"}}',
    ),
  ).toBe('step agent_response')
  expect(
    renderEventLine(
      '{"event":"result","result":{"conversation_id":"fixture-agy-session","status":"SUCCESS","response":"OK\\n","usage":{"input_tokens":14298,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":14299}}}',
    ),
  ).toBe('tokens 14298 in / 1 out')
  expect(renderEventLine('{"event":"step_update","step_update":{"state":"DONE"}}')).toBe(null)
})

test('the tail keeps the last rendered lines and drops rows with nothing to show', () => {
  const text =
    '{"type":"item.completed","item":{"type":"agent_message","text":"one"}}\n' +
    '{"type":"session_meta"}\n' +
    '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}\n'
  expect(renderTail(text)).toEqual(['msg one', 'tokens 100 in / 5 out'])
  expect(renderTail('{"type":"session_meta"}\n')).toEqual([])
  const many = Array.from({ length: 40 }, (_, i) => `{"type":"item.completed","item":{"type":"reasoning","n":${i}}}`).join(
    '\n',
  )
  expect(renderTail(many).length).toBe(30)
})

test('/orq-panel opens the pane from the slash command', async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  mock.clock(on, { now: NOW })
  await start($)
  expect(await panel($, '')).toBe('orq-panel: pane opened')
  expect(s.opens).toEqual([{ id: PANEL_ID, title: 'orq', focus: true }])
})

test('the open pane redraws on a two-second clock', { options: { cardDisplay: 'off' } }, async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await panel($, '')
  await clock.advance(2000)
  expect(s.invalidates.length > 0).toBe(true)
})

test('the refresh timer stops once the host no longer lists the pane', { options: { cardDisplay: 'off' } }, async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await panel($, '')
  await clock.advance(2000)
  expect(s.invalidates.length).toBe(1)
  s.panes = []
  await clock.advance(2000)
  const listed = s.panesCalls
  const drawnCount = s.invalidates.length
  await clock.advance(6000)
  expect(s.panesCalls).toBe(listed)
  expect(s.invalidates.length).toBe(drawnCount)
})

test('the close button closes the pane and stops its refresh timer', { options: { cardDisplay: 'off' } }, async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await panel($, '')
  await clock.advance(2000)
  const redrawnWhileOpen = s.invalidates.length
  await (await mountPane($)).press({ key: 'panel:close' })
  expect(s.closes).toEqual([PANEL_ID])
  await clock.advance(6000)
  expect(s.invalidates.length).toBe(redrawnWhileOpen)
})

test('the pane draws cancel for a running job only, and pressing it cancels that job', async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0)
  seedJob(s, 'job-done', T0)
  finish(s, 'job-done', '0')
  await start($)
  const pane = await mountPane($)
  expect(await pane.find({ key: 'cancel:job-run' })).toBeDefined()
  expect(await pane.find({ key: 'cancel:job-done' })).toBeUndefined()
  await pane.press({ key: 'cancel:job-run' })
  expect(s.writes.some((w) => w.path === `${JOBS}/job-run/cancel`)).toBe(true)
  expect(s.writes.some((w) => w.path === `${JOBS}/job-done/cancel`)).toBe(false)
})

test('a finished job is read once, across renders and refresh ticks', { options: { cardDisplay: 'off' } }, async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  const clock = mock.clock(on, { now: NOW })
  seedJob(s, 'job-done', T0)
  finish(s, 'job-done', '0')
  await start($)
  await panel($, '')
  expect(await drawn($)).toContain('✓ done ')
  expect(await drawn($)).toContain('✓ done ')
  await clock.advance(2000)
  await clock.advance(2000)
  expect(await drawn($)).toContain('✓ done ')
  expect(s.extracts).toBe(1)
})

test('a job whose view throws is logged by its id and left out, and the pane still draws the others', async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  mock.clock(on, { now: NOW })
  seedJob(s, 'job-bad', T0)
  seedJob(s, 'job-good', T0 + 1)
  s.unreadable.add(`${JOBS}/job-bad/question.txt`)
  await start($)
  const text = await drawn($)
  expect(text.includes('"job:job-good"')).toBe(true)
  expect(text.includes('"job:job-bad"')).toBe(false)
  expect(text.includes('could not read jobs')).toBe(false)
  expect(s.logs.some((line) => line.includes('job-bad') && line.includes('could not be read'))).toBe(true)
})

test('the pane shows each orq job status as jobView reads it', async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  mock.clock(on, { now: NOW })
  for (const id of ['job-running', 'job-cancelling', 'job-waiting', 'job-interrupted', 'job-done', 'job-failed', 'job-cancelled']) {
    seedJob(s, id, T0)
  }
  s.files.set(`${JOBS}/job-cancelling/cancel`, 'cancelled at 2026-10-06T00:00:00.000Z\n')
  s.files.set(`${JOBS}/job-waiting/question.txt`, 'Which branch?\n')
  s.goneJobs.add('job-interrupted')
  finish(s, 'job-done', '0')
  finish(s, 'job-failed', '1')
  finish(s, 'job-cancelled', '124')
  await start($)
  const text = await drawn($)
  expect(text.includes('● running ')).toBe(true)
  expect(text.includes('◌ cancelling ')).toBe(true)
  expect(text.includes('◐ waiting ')).toBe(true)
  expect(text.includes('? interrupted ')).toBe(true)
  expect(text.includes('✓ done ')).toBe(true)
  expect(text.includes('! failed ')).toBe(true)
  expect(text.includes('✕ cancelled ')).toBe(true)
})

test('the pane lists the newest job first, with its status', async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  mock.clock(on, { now: NOW })
  seedJob(s, 'job-old', T0)
  finish(s, 'job-old', '0')
  seedJob(s, 'job-run', 4300000)
  seedJob(s, 'job-gone', 4200000)
  s.goneJobs.add('job-gone')
  await start($)
  const text = await drawn($)
  const at = (id: string) => text.indexOf(`"job:${id}"`)
  expect(at('job-run') >= 0 && at('job-run') < at('job-gone')).toBe(true)
  expect(at('job-gone') < at('job-old')).toBe(true)
  expect(text.includes('● running ')).toBe(true)
  expect(text.includes('? interrupted ')).toBe(true)
  expect(text.includes('✓ done ')).toBe(true)
})

test('showing a job adds its live tail to the pane', async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0)
  s.tails.set('job-run', '{"type":"item.completed","item":{"type":"agent_message","text":"hello there"}}\n')
  await start($)
  expect(await panel($, 'show job-run')).toBe('orq-panel: pane opened')
  const text = await drawn($)
  expect(text.includes('— job-run')).toBe(true)
  expect(text.includes('msg hello there')).toBe(true)
  expect(s.opens.length).toBe(1)
})

test('/orq-panel cancel writes the cancel file through writeCancel, and the job reads back as cancelling', async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  mock.clock(on, { now: NOW })
  seedJob(s, 'job-run', T0)
  await start($)
  expect(await panel($, 'cancel job-run')).toBe('orq-panel: cancel requested for job-run')
  const write = s.writes.find((w) => w.path === `${JOBS}/job-run/cancel`)
  expect(write?.text.startsWith('cancelled at ')).toBe(true)
  expect(await panel($, 'cancel ../x')).toBe('orq-panel: unknown job ../x')
  expect((await drawn($)).includes('◌ cancelling ')).toBe(true)
})

test('/orq-panel cancel also stops a job that is waiting on its question', async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  mock.clock(on, { now: NOW })
  seedJob(s, 'job-wait', T0)
  s.files.set(`${JOBS}/job-wait/question.txt`, 'Which branch?\n')
  await start($)
  expect(await panel($, 'cancel job-wait')).toBe('orq-panel: cancel requested for job-wait')
  expect(s.writes.some((w) => w.path === `${JOBS}/job-wait/cancel`)).toBe(true)
})

test('/orq-panel cancel leaves a finished job alone', async ($, on) => {
  clearPanelSelection()
  const s = fresh()
  stubs(on, s)
  mock.clock(on, { now: NOW })
  seedJob(s, 'job-done', T0)
  finish(s, 'job-done', '0')
  await start($)
  expect(await panel($, 'cancel job-done')).toBe('orq-panel: job-done already finished; nothing to cancel')
  expect(s.writes.some((w) => w.path === `${JOBS}/job-done/cancel`)).toBe(false)
})
