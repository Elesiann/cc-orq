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
}

export const CONFIG_PATH = '.config/orq/config.json'

export const DEFAULT_INSTANCES: InstanceConfig[] = [
  { id: 'codex', driver: 'codex' },
  { id: 'opencode', driver: 'opencode' },
  { id: 'claudeAgent', driver: 'claudeAgent' },
]

const DRIVERS: DriverKind[] = ['codex', 'opencode', 'antigravity', 'claudeAgent']

export function defaultConfig(home: string): OrqConfig {
  return { jobsDir: `${home}/.cache/orq/jobs`, instances: DEFAULT_INSTANCES.map((i) => ({ ...i })), waitSeconds: 120 }
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
  } catch (err) {
    return { config: base, source: 'defaults', warning: `config: invalid JSON, using defaults (${String(err)})` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: base, source: 'defaults', warning: 'config: not an object, using defaults' }
  }
  const obj = raw as Record<string, unknown>
  const config: OrqConfig = { ...base }
  if (typeof obj.jobsDir === 'string' && obj.jobsDir.trim() !== '') config.jobsDir = expandHome(obj.jobsDir.trim(), home)
  if (typeof obj.waitSeconds === 'number' && Number.isFinite(obj.waitSeconds) && obj.waitSeconds >= 10) {
    config.waitSeconds = Math.floor(obj.waitSeconds)
  }
  if (Array.isArray(obj.instances)) {
    const instances: InstanceConfig[] = []
    for (const item of obj.instances) {
      if (typeof item !== 'object' || item === null) continue
      const inst = item as Record<string, unknown>
      if (typeof inst.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(inst.id)) continue
      if (typeof inst.driver !== 'string' || !DRIVERS.includes(inst.driver as DriverKind)) continue
      const env: Record<string, string> = {}
      if (typeof inst.env === 'object' && inst.env !== null) {
        for (const [k, v] of Object.entries(inst.env as Record<string, unknown>)) {
          if (/^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === 'string') env[k] = expandHome(v, home)
        }
      }
      instances.push(Object.keys(env).length > 0 ? { id: inst.id, driver: inst.driver as DriverKind, env } : { id: inst.id, driver: inst.driver as DriverKind })
    }
    if (instances.length > 0) config.instances = instances
  }
  return { config, source: 'file' }
}

export async function loadConfig($: Pick<EngineInterface, 'fs' | 'env'>): Promise<ParsedConfig> {
  const home = (await $.env.get('HOME')) ?? '/root'
  const path = `${home}/${CONFIG_PATH}`
  let text: string | null = null
  try {
    if (await $.fs.exists(path)) text = String(await $.fs.read(path))
  } catch (err) {
    return { ...parseConfig(null, home), warning: `config: cannot read ${path} (${String(err)})` }
  }
  return parseConfig(text, home)
}
