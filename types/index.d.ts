// The orq plugin's state contract: the task card's rows, which the card's refresh writes and its render reads.
// The validator wants this file self-contained, so `status` is the job status as text.

export type OrqCardRow = { id: string; instance: string; model: string; status: string; lastAction: string; durationMs: number }

declare module 'claude-code' {
  interface PluginState {
    orq: { card: OrqCardRow[] }
  }
}
