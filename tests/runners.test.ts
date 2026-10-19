import { expect, test } from 'claude-code/testing'

// Contract suite for the four runner argv shapes and the new stream fields.
//
// The `claude plugin test` sandbox cannot execute scripts: test files may
// import only relative paths and 'claude-code', and $ carries hook doubles
// only (no process/fs). So the REAL coverage — fake agy/claude/codex/
// opencode binaries on PATH recording argv, extraction of the committed
// fixtures, dash-led prompts, cwd, last.txt and cancel->124 — lives in the
// companion integration harness tests/runners-shell.sh.
//
// What this file pins, self-contained: the argv shapes scripts/supervise.sh
// must build per runner with and without a flags file, the dash-led prompt
// rule, and the field map scripts/extract.py implements for both captures.
// The inline lines below are sanitized, schema-preserving excerpts from the
// S3 captures. Session IDs and irrelevant payloads are replaced or removed;
// tests/fixtures contains the JSONL inputs used against the real extractor.

// --- agy capture: init carries conversation_id + init.init.model,
// --- result carries response + usage; status names failure.
const AGY_INIT = '{"event":"init","conversation_id":"fixture-agy-session","init":{"model":"fixture-model-agy"}}'
const AGY_RESULT =
  '{"event":"result","result":{"conversation_id":"fixture-agy-session","status":"SUCCESS","response":"OK\\n","usage":{"input_tokens":14298,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":14299}}}'

// --- claude capture: every event carries session_id; the result event
// --- carries result text, usage and modelUsage.
const CLAUDE_INIT = '{"type":"system","subtype":"init","session_id":"fixture-claude-session"}'
const CLAUDE_RESULT =
  '{"type":"result","subtype":"success","is_error":false,"session_id":"fixture-claude-session","result":"OK","usage":{"input_tokens":44,"cache_creation_input_tokens":30992,"cache_read_input_tokens":217386,"output_tokens":3670},"modelUsage":{"fixture-model-claude":{"inputTokens":44,"outputTokens":3670}}}'

type Summary = { tid: string; in: number; out: number; error: boolean; model?: string }

// Mirror of scripts/extract.py for runner 'agy'.
function summarizeAgy(lines: string[]): Summary {
  let tid = ''
  let model = ''
  let inTok = 0
  let outTok = 0
  let error = false
  for (const line of lines) {
    const o = JSON.parse(line) as Record<string, unknown>
    if (!tid && typeof o['conversation_id'] === 'string') tid = o['conversation_id'] as string
    if (o['event'] === 'init') {
      const init = o['init'] as Record<string, unknown> | undefined
      if (!model && init && typeof init['model'] === 'string') model = init['model'] as string
    }
    if (o['event'] === 'result') {
      const r = o['result'] as Record<string, unknown>
      if (!tid && typeof r['conversation_id'] === 'string') tid = r['conversation_id'] as string
      const u = r['usage'] as Record<string, unknown>
      inTok = u['input_tokens'] as number
      outTok = u['output_tokens'] as number
      if (r['error']) error = true
      if (typeof r['status'] === 'string' && (r['status'] as string).toUpperCase() !== 'SUCCESS') error = true
    }
  }
  return { tid, in: inTok, out: outTok, error, ...(model ? { model } : {}) }
}

// Mirror of scripts/extract.py for runner 'claude'.
function summarizeClaude(lines: string[]): Summary {
  let tid = ''
  let model = ''
  let inTok = 0
  let outTok = 0
  let error = false
  for (const line of lines) {
    const o = JSON.parse(line) as Record<string, unknown>
    if (!tid && typeof o['session_id'] === 'string') tid = o['session_id'] as string
    if (o['type'] === 'result') {
      if (o['is_error'] === true) error = true
      if (typeof o['subtype'] === 'string' && o['subtype'] && o['subtype'].toLowerCase() !== 'success') error = true
      const u = o['usage'] as Record<string, unknown>
      inTok = u['input_tokens'] as number
      outTok = u['output_tokens'] as number
      const mu = o['modelUsage'] as Record<string, unknown>
      if (!model && mu) model = Object.keys(mu)[0] ?? ''
    }
  }
  return { tid, in: inTok, out: outTok, error, ...(model ? { model } : {}) }
}

type Runner = 'codex' | 'opencode' | 'agy' | 'claude'

// Mirror of the argv construction in scripts/supervise.sh: flags (one per
// non-empty line of <dir>/flags) are appended before the prompt; codex
// reads the prompt from stdin (argv ends with '-'); opencode and claude
// separate it with '--'; agy takes it as the value of --print.
function argvFor(runner: Runner, model: string, flags: string[], prompt: string, cwd: string, lastTxt: string): string[] {
  const extra = flags.filter((f) => f !== '')
  if (runner === 'agy') {
    const args = ['--output-format', 'stream-json']
    if (model) args.push('--model', model)
    return [...args, ...extra, '--print', prompt]
  }
  if (runner === 'claude') {
    const args = ['-p', '--output-format', 'stream-json', '--verbose']
    if (model) args.push('--model', model)
    return [...args, ...extra, '--', prompt]
  }
  if (runner === 'opencode') return ['run', '--format', 'json', '-m', model, ...extra, '--', prompt]
  return [
    'exec',
    '--json',
    '-o',
    lastTxt,
    ...(model ? ['-m', model] : []),
    '-C',
    cwd,
    '--skip-git-repo-check',
    ...extra,
    '-',
  ]
}

test('agy argv without flags', () => {
  expect(argvFor('agy', 'm-agy', [], 'hello agy', '/work', '')).toEqual([
    '--output-format',
    'stream-json',
    '--model',
    'm-agy',
    '--print',
    'hello agy',
  ])
})

test('agy argv with flags, empty model, blank lines skipped', () => {
  expect(argvFor('agy', '', ['--effort', 'low', '', '--sandbox'], 'hello', '/work', '')).toEqual([
    '--output-format',
    'stream-json',
    '--effort',
    'low',
    '--sandbox',
    '--print',
    'hello',
  ])
})

test('claude argv with flags', () => {
  expect(argvFor('claude', 'm-claude', ['--permission-mode', 'plan'], 'hello claude', '/work', '')).toEqual([
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    'm-claude',
    '--permission-mode',
    'plan',
    '--',
    'hello claude',
  ])
})

test('claude argv without flags and empty model omits --model', () => {
  expect(argvFor('claude', '', [], 'hello claude', '/work', '')).toEqual([
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--',
    'hello claude',
  ])
})

test('codex argv without flags still ends with the stdin -', () => {
  const prompt = 'do it via codex'
  const argv = argvFor('codex', '', [], prompt, '/work', '/job/last.txt')
  expect(argv.slice(-2)).toEqual(['--skip-git-repo-check', '-'])
  expect(argv).not.toContain(prompt)
  expect(argv).not.toContain('-m')
})

test('opencode argv without flags keeps the -- prompt separator', () => {
  expect(argvFor('opencode', 'm2', [], 'do it via opencode', '/work', '')).toEqual([
    'run',
    '--format',
    'json',
    '-m',
    'm2',
    '--',
    'do it via opencode',
  ])
})

test('dash-led prompt stays one argv after -- (claude) and --print (agy)', () => {
  const prompt = '-danger do it'
  expect(argvFor('claude', 'm-claude', [], prompt, '/work', '').slice(-2)).toEqual(['--', prompt])
  expect(argvFor('agy', 'm', [], prompt, '/work', '').slice(-2)).toEqual(['--print', prompt])
})

test('codex argv keeps flags before the stdin - and the prompt off argv', () => {
  const prompt = 'do it via codex'
  const argv = argvFor('codex', 'm1', ['-c', 'foo=bar'], prompt, '/work', '/job/last.txt')
  expect(argv.slice(-2)).toEqual(['foo=bar', '-'])
  expect(argv).not.toContain(prompt)
  expect(argv).toContain('-C')
})

test('opencode argv keeps flags before the -- prompt separator', () => {
  expect(argvFor('opencode', 'm2', ['--agent', 'plan'], 'do it via opencode', '/work', '')).toEqual([
    'run',
    '--format',
    'json',
    '-m',
    'm2',
    '--agent',
    'plan',
    '--',
    'do it via opencode',
  ])
})

test('extract.py field map: agy capture gives tid, tokens and model', () => {
  expect(summarizeAgy([AGY_INIT, AGY_RESULT])).toEqual({
    tid: 'fixture-agy-session',
    in: 14298,
    out: 1,
    error: false,
    model: 'fixture-model-agy',
  })
})

test('extract.py field map: claude capture gives tid, tokens and model', () => {
  expect(summarizeClaude([CLAUDE_INIT, CLAUDE_RESULT])).toEqual({
    tid: 'fixture-claude-session',
    in: 44,
    out: 3670,
    error: false,
    model: 'fixture-model-claude',
  })
})

test('extract.py field map: failed results read as errors', () => {
  const agyErr =
    '{"event":"result","result":{"conversation_id":"c1","status":"FAILED","response":"x","usage":{"input_tokens":1,"output_tokens":2}}}'
  expect(summarizeAgy([agyErr])).toEqual({ tid: 'c1', in: 1, out: 2, error: true })
  const claudeErr =
    '{"type":"result","subtype":"error","is_error":true,"session_id":"s9","result":"bad","usage":{"input_tokens":7,"output_tokens":8},"modelUsage":{"m-x":{}}}'
  expect(summarizeClaude([claudeErr])).toEqual({ tid: 's9', in: 7, out: 8, error: true, model: 'm-x' })
})
