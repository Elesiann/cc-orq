import { fail } from './contract.ts'
import type { CoreEngine } from './engine.ts'
import type { OrqConfig } from './config.ts'
import { isWithin, refusalText, TASK_REFUSAL } from './types.ts'

type ScopeEngine = Pick<CoreEngine, 'fs' | 'process'>

async function resolvePath($: ScopeEngine, path: string, mode: '-e' | '-m'): Promise<string | null> {
  try {
    const r = await $.process.run(['realpath', mode, '--', path], { timeoutMs: 10000 })
    const resolved = r.stdout.trim()
    return r.exitCode === 0 && resolved.startsWith('/') ? resolved : null
  } catch {
    return null
  }
}

async function scopeRoots($: ScopeEngine, config: OrqConfig, sessionDir: string): Promise<string[]> {
  const roots: string[] = []
  for (const candidate of [sessionDir, ...config.allowedRoots]) {
    if (candidate === '') continue
    const resolved = await resolvePath($, candidate, '-m')
    if (resolved !== null) roots.push(resolved)
  }
  return roots
}

/**
 * The directory a task runs in, resolved through symlinks. It must lie inside the session's directory or an
 * allowedRoots entry; a path that does not exist, or is not a directory, is refused too.
 */
export async function scopedCwd(
  $: ScopeEngine,
  config: OrqConfig,
  sessionDir: string,
  requested: string,
): Promise<{ cwd: string; roots: string[] } | { refusal: string }> {
  const cwd = await resolvePath($, requested, '-e')
  if (cwd === null) return { refusal: `${TASK_REFUSAL}: directory does not exist: ${requested}` }
  const roots = await scopeRoots($, config, sessionDir)
  if (!roots.some((root) => isWithin(cwd, root))) {
    const named = roots.length > 0 ? roots.join(', ') : 'none'
    return {
      refusal: refusalText(fail('cwd_out_of_scope', `cwd ${cwd} is outside the session directory and the allowed roots (${named}).`)),
    }
  }
  const kind = await $.fs.stat(cwd).then((info) => info.kind, () => null)
  if (kind === 'dir') return { cwd, roots }
  return { refusal: `${TASK_REFUSAL}: not a directory: ${cwd}` }
}
