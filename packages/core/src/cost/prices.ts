import prices from './prices.json' with { type: 'json' }

/** Shape shared by the Messages API `usage` and the Agent SDK result usage (nullable cache fields). */
export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

/** USD per 1M tokens. Unknown models fall back to the most expensive tier so budgets stay safe. */
export function pricePerMillion(model: string): { input: number; output: number } {
  const table = prices.models as Record<string, { input: number; output: number }>
  const exact = table[model]
  if (exact) return exact
  const family = Object.keys(table).find((k) => model.startsWith(k))
  return family ? table[family]! : { input: 10, output: 50 }
}

export function estimateCostUsd(model: string, usage: Usage): number {
  const p = pricePerMillion(model)
  const m = 1_000_000
  const input = (usage.input_tokens / m) * p.input
  const output = (usage.output_tokens / m) * p.output
  const cacheWrite =
    ((usage.cache_creation_input_tokens ?? 0) / m) * p.input * prices.cacheWriteMultiplier
  const cacheRead =
    ((usage.cache_read_input_tokens ?? 0) / m) * p.input * prices.cacheReadMultiplier
  return round(input + output + cacheWrite + cacheRead)
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}
