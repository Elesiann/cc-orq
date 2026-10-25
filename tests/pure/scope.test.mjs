import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../../hooks/config.ts'
import { scopedCwd } from '../../hooks/scope.ts'
import { nodeEngine } from '../../server/node-engine.ts'

const REFUSED = 'orq: task refused (taskId none)'

function inRealTree(body) {
  return async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orq-scope-')))
    try {
      await body(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function makeDirs(root, ...paths) {
  for (const path of paths) mkdirSync(join(root, path), { recursive: true })
}

test('a cwd inside the session directory resolves through symlinks and returns the roots', inRealTree(async (root) => {
  makeDirs(root, 'session/sub', 'extra')
  symlinkSync(join(root, 'session/sub'), join(root, 'session/link'))
  symlinkSync(join(root, 'extra'), join(root, 'extra-link'))
  const config = { ...defaultConfig(root), allowedRoots: [join(root, 'extra-link')] }
  const result = await scopedCwd(nodeEngine(), config, join(root, 'session'), join(root, 'session/link'))
  assert.deepEqual(result, {
    cwd: join(root, 'session/sub'),
    roots: [join(root, 'session'), join(root, 'extra')],
  })
}))

test('a cwd outside the session directory and the allowed roots is refused, naming the roots', inRealTree(async (root) => {
  makeDirs(root, 'session', 'elsewhere')
  const result = await scopedCwd(nodeEngine(), defaultConfig(root), join(root, 'session'), join(root, 'elsewhere'))
  assert.deepEqual(result, {
    refusal: `${REFUSED}: cwd_out_of_scope: cwd ${join(root, 'elsewhere')} is outside the session directory and the allowed roots (${join(root, 'session')}).`,
  })
}))

test('a missing directory is refused as not existing, with the requested path', inRealTree(async (root) => {
  makeDirs(root, 'session')
  const missing = join(root, 'session/missing')
  const result = await scopedCwd(nodeEngine(), defaultConfig(root), join(root, 'session'), missing)
  assert.deepEqual(result, { refusal: `${REFUSED}: directory does not exist: ${missing}` })
}))

test('a file inside the session directory is refused as not a directory', inRealTree(async (root) => {
  makeDirs(root, 'session')
  writeFileSync(join(root, 'session/notes.txt'), 'not a directory\n')
  const result = await scopedCwd(nodeEngine(), defaultConfig(root), join(root, 'session'), join(root, 'session/notes.txt'))
  assert.deepEqual(result, { refusal: `${REFUSED}: not a directory: ${join(root, 'session/notes.txt')}` })
}))

test('a symlink inside the session directory that points outside it is refused', inRealTree(async (root) => {
  makeDirs(root, 'session', 'elsewhere')
  symlinkSync(join(root, 'elsewhere'), join(root, 'session/escape'))
  const result = await scopedCwd(nodeEngine(), defaultConfig(root), join(root, 'session'), join(root, 'session/escape'))
  assert.deepEqual(result, {
    refusal: `${REFUSED}: cwd_out_of_scope: cwd ${join(root, 'elsewhere')} is outside the session directory and the allowed roots (${join(root, 'session')}).`,
  })
}))

test('an allowedRoots entry admits its subtree, and the roots list names every root', inRealTree(async (root) => {
  makeDirs(root, 'session', 'shared/deep/dir', 'elsewhere')
  const config = { ...defaultConfig(root), allowedRoots: [join(root, 'shared')] }
  const engine = nodeEngine()
  const admitted = await scopedCwd(engine, config, join(root, 'session'), join(root, 'shared/deep/dir'))
  assert.deepEqual(admitted, {
    cwd: join(root, 'shared/deep/dir'),
    roots: [join(root, 'session'), join(root, 'shared')],
  })
  const refused = await scopedCwd(engine, config, join(root, 'session'), join(root, 'elsewhere'))
  assert.deepEqual(refused, {
    refusal: `${REFUSED}: cwd_out_of_scope: cwd ${join(root, 'elsewhere')} is outside the session directory and the allowed roots (${join(root, 'session')}, ${join(root, 'shared')}).`,
  })
}))

test('an empty sessionDir leaves only the allowed roots, and none when there are none', inRealTree(async (root) => {
  makeDirs(root, 'session', 'shared/deep/dir')
  const withShared = { ...defaultConfig(root), allowedRoots: [join(root, 'shared')] }
  const engine = nodeEngine()
  const inSession = await scopedCwd(engine, withShared, '', join(root, 'session'))
  assert.deepEqual(inSession, {
    refusal: `${REFUSED}: cwd_out_of_scope: cwd ${join(root, 'session')} is outside the session directory and the allowed roots (${join(root, 'shared')}).`,
  })
  const inShared = await scopedCwd(engine, withShared, '', join(root, 'shared/deep/dir'))
  assert.deepEqual(inShared, { cwd: join(root, 'shared/deep/dir'), roots: [join(root, 'shared')] })
  const noRoots = await scopedCwd(engine, defaultConfig(root), '', join(root, 'session'))
  assert.deepEqual(noRoots, {
    refusal: `${REFUSED}: cwd_out_of_scope: cwd ${join(root, 'session')} is outside the session directory and the allowed roots (none).`,
  })
}))

test('an allowedRoots entry that does not exist is left out of the roots and admits nothing', inRealTree(async (root) => {
  makeDirs(root, 'session', 'elsewhere')
  const config = { ...defaultConfig(root), allowedRoots: [join(root, 'not-there')] }
  const engine = nodeEngine()
  const inSession = await scopedCwd(engine, config, join(root, 'session'), join(root, 'session'))
  assert.deepEqual(inSession, { cwd: join(root, 'session'), roots: [join(root, 'session')] })
  const refused = await scopedCwd(engine, config, join(root, 'session'), join(root, 'elsewhere'))
  assert.deepEqual(refused, {
    refusal: `${REFUSED}: cwd_out_of_scope: cwd ${join(root, 'elsewhere')} is outside the session directory and the allowed roots (${join(root, 'session')}).`,
  })
}))
