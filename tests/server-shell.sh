#!/bin/bash
# The whole answer flow through the real server, supervisor and git, with a fake claude that asks on its first run and is
# resumed on its second: delegate, a worker that stops on a question, answer, the same worker resuming its session in the same
# worktree and on the same branch, a second answer refused, and integrate merging what both runs committed. The server is
# started as Claude Code starts it, over stdio, by a client that declares no MCP tasks, so every call answers at once and the
# driver reads the jobs with status. Git reads no global or system config here.
# Usage: bash tests/server-shell.sh
set -e -o pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T="$ROOT/.ref/tmp/server-shell-$(date +%s)-$$"
mkdir -p "$T/home/.config/orq" "$T/bin" "$T/session"
trap 'rm -rf "$T"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CEILING_DIRECTORIES="$T" HOME="$T/home"
export GIT_AUTHOR_NAME=orq-test GIT_AUTHOR_EMAIL=orq-test@example.invalid
export GIT_COMMITTER_NAME=orq-test GIT_COMMITTER_EMAIL=orq-test@example.invalid

REPO="$T/session/repo"
git init -q -b main "$REPO"
# A job started through systemd-run gets a fresh environment, so the identity also lives in the repository the worktrees share.
git -C "$REPO" config user.name orq-test
git -C "$REPO" config user.email orq-test@example.invalid
printf 'base\n' > "$REPO/shared.txt"
git -C "$REPO" add shared.txt
git -C "$REPO" commit -q -m base

printf '{"jobsDir":"%s","instances":[{"id":"claudeAgent","driver":"claudeAgent"}]}\n' "$T/jobs" > "$T/home/.config/orq/config.json"

cat > "$T/bin/claude" <<'EOF'
#!/bin/bash
printf '%s\n' "$@" > "$ORQ_JOB_DIR/argv.txt"
for last; do :; done
if printf '%s\n' "$@" | grep -qx -e --resume; then
  first=$(printf '%s' "$last" | head -n 1)
  printf '%s\n' "$first" > answered.txt
  git add answered.txt
  git commit -q -m "the worker used the answer"
  printf '%s\n' '{"type":"system","subtype":"init","session_id":"ses-shell-1"}'
  printf '{"type":"result","subtype":"success","is_error":false,"session_id":"ses-shell-1","result":"RESUMED: %s","usage":{"input_tokens":3,"output_tokens":2},"modelUsage":{"fake-model":{}}}\n' "$first"
  exit 0
fi
printf 'draft\n' > draft.txt
git add draft.txt
git commit -q -m "the worker drafted"
printf '%s\n' 'Which environment, staging or production?' > "$ORQ_JOB_DIR/question.txt"
printf '%s\n' '{"type":"system","subtype":"init","session_id":"ses-shell-1"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"ses-shell-1","result":"BLOCKED: Which environment, staging or production?","usage":{"input_tokens":3,"output_tokens":2},"modelUsage":{"fake-model":{}}}'
exit 0
EOF
chmod +x "$T/bin/claude"

cat > "$T/driver.mjs" <<'JS'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

const [root, tmp] = process.argv.slice(2)
const jobsDir = `${tmp}/jobs`
const repo = `${tmp}/session/repo`
const env = { ...process.env, PATH: `${tmp}/bin:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: `${tmp}/session`, CLAUDE_CODE_SESSION_ID: 'sess-0123456789' }
delete env.CLAUDE_PLUGIN_ROOT

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`ok: ${label}`)
  } else {
    failed += 1
    console.log(`FAIL: ${label}${detail === '' ? '' : ` (${detail})`}`)
  }
}

const server = spawn(process.execPath, [`${root}/server/main.mjs`], { env, stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let buffer = ''
let nextId = 1
server.stdout.setEncoding('utf8')
server.stdout.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    pending.get(message.id)?.(message)
  }
})
const NO_TASKS = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'server-shell', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
/** One tools/call as a client without tasks makes it: the answer is the JSON in the text block. */
function call(name, args) {
  return new Promise((done, fail) => {
    const id = nextId++
    const timer = setTimeout(() => fail(new Error(`no answer to ${name}`)), 30000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error !== undefined) return fail(new Error(JSON.stringify(message.error)))
      const [{ text }] = message.result.content
      done({ isError: message.result.isError === true, text, json: text.startsWith('{') ? JSON.parse(text) : undefined })
    })
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: NO_TASKS } })}\n`)
  })
}
async function ended(taskId) {
  for (let wait = 0; wait < 200; wait += 1) {
    const { json } = await call('status', { taskId })
    if (json.status !== 'running' && json.status !== 'waiting') return json
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`${taskId} did not end`)
}
const read = (id, name) => readFileSync(`${jobsDir}/${id}/${name}`, 'utf8')
const meta = (id) => JSON.parse(read(id, 'meta.json'))

try {
  const started = await call('delegate', { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Deploy it.', sessionMode: 'acceptEdits' })
  check('delegate answers at once with the id of the job', started.json?.status === 'running', started.text)
  const first = started.json.taskId
  const asked = await ended(first)
  check('the worker stopped on its question, and the answer tool is the way out', asked.result.startsWith(`BLOCKED on a question (taskId ${first}): Which environment, staging or production?`) && asked.result.includes('Answer it with the answer tool'), asked.result)
  check('the supervisor recorded the session before the job ended', read(first, 'session') === 'ses-shell-1\n')

  const answered = await call('answer', { taskId: first, answer: 'Production, and tag it v2.', sessionMode: 'acceptEdits' })
  check('answer starts a continuation and answers at once with its id', answered.json?.status === 'running' && answered.json.taskId !== first, answered.text)
  const next = answered.json.taskId
  const done = await ended(next)
  check('the worker resumed and quoted the answer', done.status === 'completed' && done.result.startsWith('RESUMED: Production, and tag it v2.'), done.result)
  check('the continuation names its parent and the parent names the continuation', done.parent === first && (await call('status', { taskId: first })).json.next === next)
  check('the argv of the continuation resumes the recorded session', read(next, 'argv.txt').split('\n').slice(0, 3).join(' ') === '-p --resume ses-shell-1')
  check('child.log shows the resume argv with the recorded session id', read(next, 'child.log').includes('orq: resume: claude -p --resume ses-shell-1 --output-format stream-json --verbose --model haiku'), read(next, 'child.log'))
  const [one, two] = [meta(first), meta(next)]
  check('both jobs are on the same branch, in the same worktree and directory', one.branch !== undefined && one.branch === two.branch && one.worktree === two.worktree && one.cwd === two.cwd && one.baseSha === two.baseSha)
  check('the claim names the continuation', read(first, 'next') === JSON.stringify({ jobId: next, via: 'answer' }))

  const again = await call('answer', { taskId: first, answer: 'Staging.' })
  check('a second answer gets already_answered with the id of the continuation', again.isError && again.json?.error?.code === 'already_answered' && again.json.error.message.includes(next), again.text)

  const merged = await call('integrate', { taskId: next })
  check('integrate merges what both runs committed', merged.json?.ok === true, merged.text)
  check('the checkout has the file of the first run and the one of the second', existsSync(`${repo}/draft.txt`) && readFileSync(`${repo}/answered.txt`, 'utf8') === 'Production, and tag it v2.\n')

  const finished = await call('answer', { taskId: next, answer: 'More.' })
  check('a job that did not stop on a question is refused as input', finished.isError && finished.json?.error?.code === 'invalid_request', finished.text)

  const second = (await call('delegate', { target: 'claudeAgent', model: 'haiku', cwd: repo, prompt: 'Deploy it again.', sessionMode: 'acceptEdits' })).json.taskId
  await ended(second)
  rmSync(`${jobsDir}/${second}/session`)
  const lost = await call('answer', { taskId: second, answer: 'Production.' })
  check('a job without a session answers resume_unavailable and says to delegate anew', lost.isError && lost.json?.error?.code === 'resume_unavailable' && lost.json.error.message.includes('Delegate a new task'), lost.text)
  check('and its BLOCKED text no longer promises a resume', (await call('status', { taskId: second })).json.result.includes('cannot be resumed'))
  check('a refused answer leaves the question unclaimed', !existsSync(`${jobsDir}/${second}/next`))
} catch (err) {
  failed += 1
  console.log(`FAIL: the driver stopped: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  server.stdin.end()
}
console.log(`pass=${passed} fail=${failed}`)
process.exit(failed === 0 ? 0 : 1)
JS

node "$T/driver.mjs" "$ROOT" "$T"
