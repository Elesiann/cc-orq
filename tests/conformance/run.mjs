// Runs the tasks scenarios of the MCP conformance suite against the test HTTP entry, one `server --url URL --scenario NAME`
// per scenario, and gates on each exit code: `--requirements 2026-07-28` runs them too, but lists them as not scored.
//
//   node tests/conformance/run.mjs [--out DIR] [scenario ...]
//
// CONFORMANCE_CMD says how to start the suite, as words split on spaces; the default is the published build below.
// Each scenario's results, its checks.json included, go under DIR (default: a new temporary directory).

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { startEntry } from './server.mjs'

const DEFAULT_SUITE = 'npx --yes @modelcontextprotocol/conformance@0.2.0-alpha.12'

const SCENARIOS = [
  'tasks-lifecycle',
  'tasks-capability-negotiation',
  'tasks-wire-fields',
  'tasks-request-state-removal',
  'tasks-mrtr-input',
  'tasks-request-headers',
  'tasks-dispatch-and-envelope',
  'tasks-status-notifications',
  'tasks-required-task-error',
  'tasks-mrtr-composition',
]
// The suite's harness still reads the SSE of `tools/call` where the spec has `subscriptions/listen`, so it skips this one.
const SKIPPED_BY_THE_SUITE = new Set(['tasks-status-notifications'])

function runSuite(words, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(words[0], [...words.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

// The suite writes <dir>/server-<scenario>-<time>/checks.json, and nothing when it cannot start.
function savedChecks(dir) {
  const file = readdirSync(dir)
    .filter((name) => !name.endsWith('.log'))
    .map((name) => join(dir, name, 'checks.json'))
    .find((path) => existsSync(path))
  return file === undefined ? [] : JSON.parse(readFileSync(file, 'utf8'))
}

function whyNot(name, code, checks) {
  if (code !== 0) return `the suite exited ${code}`
  if (SKIPPED_BY_THE_SUITE.has(name)) return checks.length > 0 && checks.every((check) => check.status === 'SKIPPED') ? null : 'it was expected to be skipped by the suite'
  if (checks.some((check) => check.status === 'FAILURE')) return 'a check failed'
  if (!checks.some((check) => check.status === 'SUCCESS')) return 'no check passed'
  if (checks.some((check) => check.status === 'SKIPPED')) return 'the suite skipped a check'
  return null
}

const count = (checks, status) => checks.filter((check) => check.status === status).length

async function main() {
  const { values, positionals } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true })
  const names = positionals.length > 0 ? positionals : SCENARIOS
  const out = values.out ?? mkdtempSync(join(tmpdir(), 'orq-conformance-'))
  mkdirSync(out, { recursive: true })
  const words = (process.env.CONFORMANCE_CMD ?? DEFAULT_SUITE).split(/\s+/).filter(Boolean)
  const github = process.env.GITHUB_ACTIONS === 'true'

  const entry = await startEntry()
  const rows = []
  try {
    for (const name of names) {
      const dir = join(out, name)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      if (github) console.log(`::group::${name}`)
      const { code, output } = await runSuite(words, ['server', '--url', entry.url, '--scenario', name, '--output-dir', dir])
      writeFileSync(join(dir, `${name}.log`), output)
      const checks = savedChecks(dir)
      const problem = whyNot(name, code, checks)
      console.log(output.trimEnd())
      if (github) console.log('::endgroup::')
      for (const check of checks.filter((c) => c.status === 'FAILURE')) console.log(`FAILURE ${check.id}: ${check.errorMessage ?? ''}`)
      rows.push({ name, code, checks, problem })
    }
  } finally {
    await entry.close()
  }

  const lines = [`${'scenario'.padEnd(32)} result`]
  for (const { name, code, checks, problem } of rows) {
    const tally = `${count(checks, 'SUCCESS')} passed, ${count(checks, 'FAILURE')} failed, ${count(checks, 'SKIPPED')} skipped`
    lines.push(`${name.padEnd(32)} ${problem === null ? 'ok' : `FAIL (${problem})`} - exit ${code}, ${tally}`)
  }
  console.log(`\n${lines.join('\n')}\nresults: ${out}`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    const table = rows.map(({ name, code, checks, problem }) => `| ${name} | ${problem === null ? 'pass' : `FAIL: ${problem}`} | ${code} | ${count(checks, 'SUCCESS')} | ${count(checks, 'FAILURE')} | ${count(checks, 'SKIPPED')} |`)
    appendFileSync(summary, `| scenario | result | exit | passed | failed | skipped |\n|---|---|---|---|---|---|\n${table.join('\n')}\n`)
  }
  process.exitCode = rows.some((row) => row.problem !== null) ? 1 : 0
}

await main()
