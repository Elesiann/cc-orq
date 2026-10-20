import type { EngineInterface } from 'claude-code'

export type DriverKind = 'codex' | 'opencode' | 'antigravity' | 'claudeAgent'

export type InstanceConfig = {
  id: string
  driver: DriverKind
  env?: Record<string, string>
}

export type OrqConfig = {
  jobsDir: string
  instances: InstanceConfig[]
  waitSeconds: number
  /** Absolute directories, besides the session's own, that an orq:task may run in. */
  allowedRoots: string[]
}

export const CONFIG_PATH = '.config/orq/config.json'

export const DEFAULT_INSTANCES: InstanceConfig[] = [
  { id: 'codex', driver: 'codex' },
  { id: 'opencode', driver: 'opencode' },
  { id: 'claudeAgent', driver: 'claudeAgent' },
]

const DRIVERS: DriverKind[] = ['codex', 'opencode', 'antigravity', 'claudeAgent']

export function defaultConfig(home: string): OrqConfig {
  return {
    jobsDir: `${home}/.cache/orq/jobs`,
    instances: DEFAULT_INSTANCES.map((i) => ({ ...i })),
    waitSeconds: 120,
    allowedRoots: [],
  }
}

export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}/${path.slice(2)}` : path
}

export type ParsedConfig = { config: OrqConfig; source: 'defaults' | 'file'; warning?: string }

export function parseConfig(text: string | null, home: string): ParsedConfig {
  const base = defaultConfig(home)
  if (text === null) return { config: base, source: 'defaults' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { config: base, source: 'defaults', warning: 'config: invalid JSON, using defaults' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: base, source: 'defaults', warning: 'config: root is not an object, using defaults' }
  }
  const obj = raw as Record<string, unknown>
  const config: OrqConfig = { ...base }
  const warnings: string[] = []
  if (obj.jobsDir !== undefined) {
    const dir = typeof obj.jobsDir === 'string' ? expandHome(obj.jobsDir.trim(), home) : ''
    if (dir.startsWith('/')) config.jobsDir = dir
    else warnings.push('jobsDir must be an absolute path or start with ~/, keeping the default')
  }
  if (obj.allowedRoots !== undefined) {
    if (!Array.isArray(obj.allowedRoots)) {
      warnings.push('allowedRoots must be an array of absolute paths, keeping none')
    } else {
      const roots: string[] = []
      obj.allowedRoots.forEach((item: unknown, index) => {
        const dir = typeof item === 'string' ? expandHome(item.trim(), home) : ''
        if (dir.startsWith('/')) roots.push(dir)
        else warnings.push(`allowedRoots[${index}] must be an absolute path or start with ~/, dropped`)
      })
      config.allowedRoots = roots
    }
  }
  if (obj.waitSeconds !== undefined) {
    const w = obj.waitSeconds
    if (typeof w === 'number' && Number.isFinite(w) && w >= 10 && w <= 600) config.waitSeconds = Math.floor(w)
    else warnings.push('waitSeconds must be a number between 10 and 600, keeping the default')
  }
  if (obj.instances !== undefined) {
    if (!Array.isArray(obj.instances)) {
      warnings.push('instances must be an array, keeping the defaults')
    } else {
      const instances: InstanceConfig[] = []
      const seen = new Set<string>()
      obj.instances.forEach((item, index) => {
        const label = `instances[${index}]`
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          warnings.push(`${label} is not an object, dropped`)
          return
        }
        const inst = item as Record<string, unknown>
        if (typeof inst.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(inst.id)) {
          warnings.push(`${label} has no valid id (letters, digits, _ . -, up to 64 chars), dropped`)
          return
        }
        if (typeof inst.driver !== 'string' || !DRIVERS.includes(inst.driver as DriverKind)) {
          warnings.push(`${label} (${inst.id}) has an unknown driver, expected one of ${DRIVERS.join(', ')}, dropped`)
          return
        }
        if (seen.has(inst.id)) {
          warnings.push(`${label} repeats the id ${inst.id}, dropped`)
          return
        }
        seen.add(inst.id)
        const env: Record<string, string> = {}
        if (inst.env !== undefined) {
          if (typeof inst.env !== 'object' || inst.env === null || Array.isArray(inst.env)) {
            warnings.push(`${label} (${inst.id}) env is not an object, ignored`)
          } else {
            for (const [k, v] of Object.entries(inst.env as Record<string, unknown>)) {
              if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) warnings.push(`${label} (${inst.id}) env key ${k} must be UPPER_CASE, dropped`)
              else if (typeof v !== 'string') warnings.push(`${label} (${inst.id}) env ${k} must be a string, dropped`)
              else env[k] = expandHome(v, home)
            }
          }
        }
        instances.push(Object.keys(env).length > 0 ? { id: inst.id, driver: inst.driver as DriverKind, env } : { id: inst.id, driver: inst.driver as DriverKind })
      })
      if (instances.length > 0) config.instances = instances
      else warnings.push('instances has no valid entry, keeping the defaults')
    }
  }
  const result: ParsedConfig = { config, source: 'file' }
  if (warnings.length > 0) result.warning = `config: ${warnings.join('; ')}`
  return result
}

export async function loadConfig($: Pick<EngineInterface, 'fs' | 'env'>): Promise<ParsedConfig> {
  const home = ((await $.env.get('HOME')) ?? '').trim()
  if (home === '') {
    return { ...parseConfig(null, '/root'), warning: 'config: HOME is not set, using defaults under /root' }
  }
  const path = `${home}/${CONFIG_PATH}`
  let text: string | null = null
  try {
    if (await $.fs.exists(path)) text = String(await $.fs.read(path))
  } catch (err) {
    return { ...parseConfig(null, home), warning: `config: cannot read ${path} (${String(err)})` }
  }
  return parseConfig(text, home)
}
