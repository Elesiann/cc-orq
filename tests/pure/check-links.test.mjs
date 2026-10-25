import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'check-links.mjs')

function gitRepoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-links-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '--all'], { cwd: dir })
  return dir
}

function check(dir) {
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' })
  return { status: run.status, output: run.stdout + run.stderr }
}

test('links to existing files and anchors resolve, including duplicate headings', () => {
  const dir = gitRepoWith({
    'README.md': [
      '# Title',
      '',
      '[guide](docs/guide.md#setup-steps) and [again](docs/guide.md#notes-1)',
      '[top](#title) and [external](https://example.com/#x)',
      '<img src="docs/logo.png" alt="logo">',
      '',
      '```md',
      '[inside a code block](missing.md)',
      '```',
      '',
    ].join('\n'),
    'docs/guide.md': '## Setup steps\n\n## Notes\n\n## Notes\n',
    'docs/logo.png': '',
  })
  const result = check(dir)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /: 0 broken/)
})

test('a link to a missing file fails the check and names the file and the target', () => {
  const dir = gitRepoWith({ 'README.md': '[gone](docs/missing.md)\n' })
  const result = check(dir)
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /README\.md:1: broken link "docs\/missing\.md": no such file or directory/)
})

test('an anchor that matches no heading fails the check and names the anchor', () => {
  const dir = gitRepoWith({
    'README.md': '[bad anchor](docs/guide.md#no-such-heading)\n',
    'docs/guide.md': '## Setup steps\n',
  })
  const result = check(dir)
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /broken link "docs\/guide\.md#no-such-heading": no heading or id "#no-such-heading"/)
})

test('the repository\'s own Markdown links and anchors resolve', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
})
