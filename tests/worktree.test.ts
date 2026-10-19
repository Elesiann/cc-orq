import { expect, test } from 'claude-code/testing'

import {
  branchFor,
  isAncestorArgv,
  isSafeTaskId,
  mergeAbortArgv,
  mergeArgv,
  revParseHeadArgv,
  revParseToplevelArgv,
  statusArgv,
  unmergedFilesArgv,
  worktreeAddArgv,
  worktreePathFor,
} from '../hooks/worktree.ts'
import { parseJobMeta } from '../hooks/types.ts'

const JOBS = '/srv/example/jobs'
const CHECKOUT = '/srv/example/checkout'
const TASK = 'manual-2000000-manual-k3j9x2a1'

test('the worktree sits beside its checkout as REPO_NAME-wt/TASK_ID, on branch orq/TASK_ID', () => {
  expect(worktreePathFor(CHECKOUT, TASK)).toBe(`/srv/example/checkout-wt/${TASK}`)
  expect(worktreePathFor('/checkout', TASK)).toBe(`/checkout-wt/${TASK}`)
  expect(branchFor(TASK)).toBe(`orq/${TASK}`)
})

test('the git argv of each step names the checkout with -C and passes no shell string', () => {
  expect(revParseToplevelArgv('/srv/example/work')).toEqual(['git', '-C', '/srv/example/work', 'rev-parse', '--show-toplevel'])
  expect(revParseHeadArgv(CHECKOUT)).toEqual(['git', '-C', CHECKOUT, 'rev-parse', 'HEAD'])
  expect(worktreeAddArgv(CHECKOUT, `/srv/example/checkout-wt/${TASK}`, `orq/${TASK}`, 'abc123')).toEqual([
    'git',
    '-C',
    CHECKOUT,
    'worktree',
    'add',
    `/srv/example/checkout-wt/${TASK}`,
    '-b',
    `orq/${TASK}`,
    'abc123',
  ])
  expect(statusArgv(CHECKOUT)).toEqual(['git', '-C', CHECKOUT, 'status', '--porcelain'])
  expect(isAncestorArgv(CHECKOUT, `orq/${TASK}`)).toEqual(['git', '-C', CHECKOUT, 'merge-base', '--is-ancestor', `orq/${TASK}`, 'HEAD'])
  expect(unmergedFilesArgv(CHECKOUT)).toEqual(['git', '-C', CHECKOUT, 'diff', '--name-only', '--diff-filter=U'])
  expect(mergeAbortArgv(CHECKOUT)).toEqual(['git', '-C', CHECKOUT, 'merge', '--abort'])
})

test('ff-only and merge differ only in their flags, and neither forces', () => {
  expect(mergeArgv(CHECKOUT, `orq/${TASK}`, 'ff-only')).toEqual(['git', '-C', CHECKOUT, 'merge', '--ff-only', `orq/${TASK}`])
  expect(mergeArgv(CHECKOUT, `orq/${TASK}`, 'merge')).toEqual([
    'git',
    '-C',
    CHECKOUT,
    'merge',
    '--no-ff',
    '--no-edit',
    `orq/${TASK}`,
  ])
  for (const strategy of ['ff-only', 'merge'] as const) {
    expect(mergeArgv(CHECKOUT, `orq/${TASK}`, strategy).includes('--force')).toBe(false)
  }
})

test('a task id is usable as a branch and a directory name, and nothing else', () => {
  expect(isSafeTaskId(TASK)).toBe(true)
  for (const bad of ['../x', '-x', 'a/b', 'a.lock', 'end.', '', 'a..b']) {
    expect(isSafeTaskId(bad)).toBe(false)
  }
})

test('the worktree meta fields are read when present and ignored when malformed', () => {
  const meta = {
    id: TASK,
    kind: 'manual',
    agentId: 'manual',
    cwd: `/srv/example/checkout-wt/${TASK}`,
    startedAt: 2000000,
    repo: CHECKOUT,
    baseSha: 'abc123',
    branch: `orq/${TASK}`,
    worktree: `/srv/example/checkout-wt/${TASK}`,
  }
  expect(parseJobMeta(meta, JOBS, TASK)).toMatchObject({
    cwd: `/srv/example/checkout-wt/${TASK}`,
    repo: CHECKOUT,
    baseSha: 'abc123',
    branch: `orq/${TASK}`,
    worktree: `/srv/example/checkout-wt/${TASK}`,
  })
  const malformed = parseJobMeta({ ...meta, repo: 5, baseSha: '', branch: null, worktree: {} }, JOBS, TASK)
  expect(malformed).not.toBe(null)
  expect(malformed?.repo).toBe(undefined)
  expect(malformed?.baseSha).toBe(undefined)
  expect(malformed?.branch).toBe(undefined)
  expect(malformed?.worktree).toBe(undefined)
  expect(parseJobMeta({ id: TASK, kind: 'manual', agentId: 'manual', cwd: CHECKOUT, startedAt: 1 }, JOBS, TASK)?.branch).toBe(
    undefined,
  )
})
