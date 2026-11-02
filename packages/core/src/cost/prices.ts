import prices from './prices.json' with { type: 'json' }
import type { ModelPrice } from '../schemas/llm.ts'

/** Shape shared by the Messages API `usage` and the Agent SDK result usage (nullable cache fields). */
export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export interface PriceOptions {
  /** Per-model prices from the user's config; they win over the built-in table. */
  overrides?: Record<string, ModelPrice>
  /** Price for a model the table does not know (a local server costs nothing). */
  fallback?: ModelPrice
}

/** The dearest tier in the table: an unknown paid model is charged at this rate so budgets stay safe. */
const DEAREST: ModelPrice = { input: 10, output: 50 }

/**
 * USD per 1M tokens. Exact names first, then the longest family prefix (`gpt-5-mini` before
 * `gpt-5`); a vendor prefix such as OpenRouter's `openai/gpt-5.1` is dropped before the lookup.
 */
export function pricePerMillion(model: string, opts: PriceOptions = {}): ModelPrice {
  const table = prices.models as Record<string, ModelPrice>
  const candidates = [model, model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model]
  for (const source of [opts.overrides ?? {}, table]) {
    for (const name of candidates) {
      const exact = source[name]
      if (exact) return exact
    }
    for (const name of candidates) {
      const family = Object.keys(source)
        .filter((k) => name.startsWith(k))
        .sort((a, b) => b.length - a.length)[0]
      if (family) return source[family]!
    }
  }
  return opts.fallback ?? DEAREST
}

export function estimateCostUsd(model: string, usage: Usage, opts: PriceOptions = {}): number {
  const p = pricePerMillion(model, opts)
  const m = 1_000_000
  const input = (usage.input_tokens / m) * p.input
  const output = (usage.output_tokens / m) * p.output
  const cacheWrite =
    ((usage.cache_creation_input_tokens ?? 0) / m) * p.input * prices.cacheWriteMultiplier
  const cacheRead =
    ((usage.cache_read_input_tokens ?? 0) / m) * p.input * prices.cacheReadMultiplier
  return round(input + output + cacheWrite + cacheRead)
}

/** Whether the table (or the overrides) know this model's price, as opposed to a fallback. */
export function hasKnownPrice(model: string, overrides: Record<string, ModelPrice> = {}): boolean {
  const probe = pricePerMillion(model, { overrides, fallback: { input: -1, output: -1 } })
  return probe.input >= 0
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}
