import { isRecord } from './types.ts'

const TAIL_LINES = 30

function shortText(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function clockOf(o: Record<string, unknown>): string {
  const ts = o.timestamp
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const ms = ts < 1e12 ? ts * 1000 : ts
    return new Date(ms).toISOString().slice(11, 19)
  }
  return ''
}

function usageText(usage: unknown): string | null {
  if (!isRecord(usage)) return null
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : null
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : null
  if (input === null && output === null) return null
  return `tokens ${input ?? '?'} in / ${output ?? '?'} out`
}

function lastContentItem(o: Record<string, unknown>): Record<string, unknown> | null {
  const content: unknown[] = isRecord(o.message) && Array.isArray(o.message.content) ? o.message.content : []
  const last: unknown = content[content.length - 1]
  return isRecord(last) ? last : null
}

/** One compact line per event JSONL row: `HH:MM:SS kind text`. Null when the row carries nothing to show. */
export function renderEventLine(raw: string): string | null {
  const t = raw.trim()
  if (!t || !t.startsWith('{')) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(t) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const clock = clockOf(o)
  const pre = clock ? `${clock} ` : ''

  // Codex `codex exec --json` rows.
  if (typeof o.type === 'string') {
    if (o.type === 'thread.started' && typeof o.thread_id === 'string') {
      return `${pre}start thread ${o.thread_id.slice(0, 8)}`
    }
    if (o.type === 'item.completed') {
      const item = o.item as Record<string, unknown> | undefined
      const kind = item && typeof item.type === 'string' ? item.type : 'item'
      if (item && item.type === 'agent_message' && typeof item.text === 'string') {
        return `${pre}msg ${shortText(item.text, 160)}`
      }
      if (item && item.type === 'error' && typeof item.message === 'string') {
        return `${pre}error ${shortText(item.message, 160)}`
      }
      return `${pre}${shortText(kind, 24)}`
    }
    if (o.type === 'turn.completed') {
      const usage = o.usage as Record<string, unknown> | undefined
      const input = usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : null
      const output = usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : null
      if (input !== null || output !== null) {
        return `${pre}tokens ${input ?? '?'} in / ${output ?? '?'} out`
      }
      return `${pre}turn done`
    }
  }

  // Claude `claude -p --output-format stream-json` rows.
  if (o.type === 'system' && o.subtype === 'init') return `${pre}start`
  if (o.type === 'assistant') {
    const item = lastContentItem(o)
    if (item?.type === 'text' && typeof item.text === 'string') return `${pre}msg ${shortText(item.text, 160)}`
    if (item?.type === 'tool_use') return `${pre}tool ${shortText(typeof item.name === 'string' ? item.name : 'tool', 60)}`
    return null
  }
  if (o.type === 'result') return `${pre}${usageText(o.usage) ?? 'result'}`
  if (o.type === 'user') return null

  // OpenCode `opencode run --format json` rows.
  const part = o.part as Record<string, unknown> | undefined
  if (part && typeof part === 'object') {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      return `${pre}msg ${shortText(part.text, 160)}`
    }
    if (part.type === 'tool') {
      const name =
        typeof part.name === 'string'
          ? part.name
          : typeof part.title === 'string'
            ? part.title
            : typeof part.tool === 'string'
              ? part.tool
              : 'tool'
      return `${pre}tool ${shortText(name, 60)}`
    }
    if (part.type === 'step-finish') {
      const tokens = part.tokens as Record<string, unknown> | undefined
      const input = tokens && typeof tokens.input === 'number' ? tokens.input : null
      const output = tokens && typeof tokens.output === 'number' ? tokens.output : null
      if (input !== null || output !== null) {
        return `${pre}tokens ${input ?? '?'} in / ${output ?? '?'} out`
      }
      return `${pre}step done`
    }
  }

  // Antigravity (`agy`) stream rows.
  if (o.event === 'init') return `${pre}start`
  if (o.event === 'step_update') {
    const update = isRecord(o.step_update) ? o.step_update : null
    if (update && typeof update.step_type === 'string') return `${pre}step ${shortText(update.step_type, 24)}`
    return null
  }
  if (o.event === 'result') return `${pre}${usageText(isRecord(o.result) ? o.result.usage : undefined) ?? 'result'}`
  return null
}

export function renderTail(text: string, maxLines = TAIL_LINES): string[] {
  const lines = text
    .split('\n')
    .map((raw) => renderEventLine(raw))
    .filter((line): line is string => line !== null)
  return lines.slice(-maxLines)
}
