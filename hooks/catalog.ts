// Provider catalog behind `mcp__cc-orq__capabilities`: parsing and assembly.
//
// Pure module: no `$` here. `scripts/catalog.py` runs the CLIs and prints `ProviderInstance[]`.
// This module parses each source format, so the parsers stay unit-testable, and turns instances
// into `ProviderCapability[]` the way T3's `capabilities` does, with `constraints` worded as T3's
// `providerConstraints`. Every parser takes untrusted text and returns only validated values.

import { EFFORT_OPTION, type CatalogModel, type DriverKind, type OptionChoice, type OptionDescriptor, type ProviderCapability, type ProviderInstance } from './contract.ts'
import { isRecord } from './types.ts'

/** Aliases `claude -p --model` accepts, mirroring T3's ClaudeModelCatalog. */
export const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus'] as const

export type ReasoningLevel = { effort: string; description?: string }

export function buildEffortDescriptor(
  levels: ReasoningLevel[],
  def: string | null,
): OptionDescriptor | null {
  const options: OptionChoice[] = levels
    .filter((l) => l.effort.length > 0)
    .map((l) => ({
      id: l.effort,
      label: l.effort,
      ...(l.description ? { description: l.description } : {}),
      ...(def !== null && l.effort === def ? { isDefault: true } : {}),
    }))
  if (options.length === 0) return null
  return {
    id: EFFORT_OPTION,
    label: 'Reasoning effort',
    type: 'select',
    options,
    ...(def !== null ? { currentValue: def } : {}),
  }
}

/** The reasoning levels of a Codex model, from its `supported_reasoning_levels` entries. */
function parseLevels(raw: unknown): ReasoningLevel[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((l) => {
    if (!isRecord(l) || typeof l.effort !== 'string') return []
    return [{ effort: l.effort, ...(typeof l.description === 'string' ? { description: l.description } : {}) }]
  })
}

/** Parse `codex debug models` output, keeping `visibility == "list"` as T3 does. */
export function parseCodexModels(text: string): CatalogModel[] {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  const raw = isRecord(doc) ? doc.models : undefined
  if (!Array.isArray(raw)) return []
  const out: CatalogModel[] = []
  for (const m of raw) {
    if (!isRecord(m) || m.visibility !== 'list') continue
    if (typeof m.slug !== 'string' || m.slug.length === 0) continue
    const def = typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null
    const desc = buildEffortDescriptor(parseLevels(m.supported_reasoning_levels), def)
    out.push({
      id: m.slug,
      label: typeof m.display_name === 'string' ? m.display_name : null,
      ...(desc !== null ? { options: [desc] } : {}),
    })
  }
  return out
}

/** Provider ids from `opencode auth list --format json`. Only the ids are read. */
export function parseOpencodeAuthIds(text: string): string[] {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(doc)) return []
  return doc.flatMap((e) => (isRecord(e) && typeof e.id === 'string' ? [e.id] : []))
}

/** Parse `opencode models` lines (`provider/model`), keeping the logged-in providers. */
export function parseOpencodeModels(text: string, loggedIn: readonly string[]): CatalogModel[] {
  const allowed = new Set(loggedIn)
  const out: CatalogModel[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.includes('/')) continue
    const slash = trimmed.indexOf('/')
    const provider = trimmed.slice(0, slash)
    const name = trimmed.slice(slash + 1)
    if (!allowed.has(provider) || name.length === 0) continue
    out.push({ id: trimmed, label: name })
  }
  return out
}

/** Parse `agy models`: tab-separated id and label; effort stays in the id. */
export function parseAgyModels(text: string): CatalogModel[] {
  const out: CatalogModel[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const [rawId = '', rawLabel] = line.split('\t')
    const id = rawId.trim()
    if (id.length === 0) continue
    const label = rawLabel !== undefined && rawLabel.trim().length > 0 ? rawLabel.trim() : null
    out.push({ id, label })
  }
  return out
}

export function claudeAliasModels(): CatalogModel[] {
  return CLAUDE_ALIASES.map((a) => ({ id: a, label: null }))
}

/** T3's `isProviderAvailable`: installed, enabled, no error and not unauthenticated. */
export function isProviderAvailable(instance: ProviderInstance): boolean {
  return (
    instance.installed &&
    instance.enabled &&
    instance.unavailableReason === null &&
    instance.authenticated !== false
  )
}

/** T3's `providerConstraints` wording (OrchestratorMcpService.ts). */
export function providerConstraints(instance: ProviderInstance): string[] {
  const constraints: string[] = []
  if (!instance.enabled) constraints.push('Provider instance is disabled.')
  if (!instance.installed) constraints.push('Provider executable is not installed.')
  if (!isProviderAvailable(instance)) {
    constraints.push(instance.unavailableReason ?? 'Provider driver is unavailable.')
  }
  if (instance.authenticated === false) constraints.push('Provider is not authenticated.')
  return constraints
}

/** One instance as T3's `capabilities` maps it. With no adapter registry here, every instance is capable. */
export function buildCapabilities(instances: ProviderInstance[]): ProviderCapability[] {
  return instances.map(toProviderCapability)
}

export function toProviderCapability(instance: ProviderInstance): ProviderCapability {
  const constraints = providerConstraints(instance)
  return {
    providerInstanceId: instance.instanceId,
    driverKind: instance.driver,
    displayName: instance.displayName,
    models: instance.models,
    canRunChildTask: constraints.length === 0,
    canRunCrossProviderChildTask: constraints.length === 0,
    constraints,
  }
}

const KNOWN_DRIVERS: readonly DriverKind[] = ['codex', 'opencode', 'antigravity', 'claudeAgent']

function isDriver(value: unknown): value is DriverKind {
  return typeof value === 'string' && (KNOWN_DRIVERS as readonly string[]).includes(value)
}

function parseChoice(raw: unknown): OptionChoice | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.label !== 'string') return null
  return {
    id: raw.id,
    label: raw.label,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(raw.isDefault === true ? { isDefault: true } : {}),
  }
}

function parseOption(raw: unknown): OptionDescriptor | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.label !== 'string') return null
  if (raw.type !== 'select' || !Array.isArray(raw.options)) return null
  const options = raw.options.flatMap((c) => {
    const choice = parseChoice(c)
    return choice === null ? [] : [choice]
  })
  return {
    id: raw.id,
    label: raw.label,
    type: 'select',
    options,
    ...(typeof raw.currentValue === 'string' ? { currentValue: raw.currentValue } : {}),
  }
}

function parseModels(raw: unknown): CatalogModel[] {
  if (!Array.isArray(raw)) return []
  const out: CatalogModel[] = []
  for (const m of raw) {
    if (!isRecord(m) || typeof m.id !== 'string' || m.id.length === 0) continue
    const options = Array.isArray(m.options)
      ? m.options.flatMap((o) => {
          const option = parseOption(o)
          return option === null ? [] : [option]
        })
      : undefined
    out.push({
      id: m.id,
      label: typeof m.label === 'string' ? m.label : null,
      ...(options !== undefined ? { options } : {}),
    })
  }
  return out
}

/**
 * Parse `scripts/catalog.py` stdout into `ProviderInstance[]`. The script prints no `env` values,
 * so none is carried here. Total: garbage in gives `[]` or a skipped entry, never a throw.
 */
export function parseCatalogInstances(text: string): ProviderInstance[] {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(doc)) return []
  const out: ProviderInstance[] = []
  for (const entry of doc) {
    if (!isRecord(entry) || typeof entry.instanceId !== 'string' || entry.instanceId.length === 0) continue
    if (!isDriver(entry.driver)) continue
    out.push({
      instanceId: entry.instanceId,
      driver: entry.driver,
      displayName: typeof entry.displayName === 'string' ? entry.displayName : null,
      enabled: entry.enabled === undefined ? true : entry.enabled === true,
      installed: entry.installed === true,
      authenticated: typeof entry.authenticated === 'boolean' ? entry.authenticated : null,
      unavailableReason: typeof entry.unavailableReason === 'string' ? entry.unavailableReason : null,
      models: parseModels(entry.models),
    })
  }
  return out
}
