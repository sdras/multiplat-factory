import { z } from 'zod'

/** USD per million tokens. */
export const ModelPrice = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
})
export type ModelPrice = z.infer<typeof ModelPrice>

export const LlmProvider = z.enum([
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'openrouter',
  'custom',
])
export type LlmProvider = z.infer<typeof LlmProvider>

const fields = {
  provider: z.enum(['auto', ...LlmProvider.options]),
  /** Chat-completions base URL (usually ending in `/v1`). Required for `custom`; overrides a preset. */
  baseUrl: z.string(),
  /** Name of the environment variable that holds the API key (each preset has its own default). */
  apiKeyEnv: z.string(),
  /** Send a reasoning-effort parameter. `auto` follows the preset (on for openai, gemini, openrouter). */
  reasoning: z.enum(['auto', 'on', 'off']),
  /** Extra HTTP headers on every request. */
  headers: z.record(z.string(), z.string()),
  /** Prices per model (USD per million tokens) used for budgets. */
  pricing: z.record(z.string(), ModelPrice),
  /**
   * Probe a non-Claude model with a short tool task before a run's first worker and refuse models
   * that fail it or answer too slowly; `false` also turns the size rule into a warning.
   */
  probe: z.boolean(),
}

/**
 * Which model provider runs the factory's workers and reviews. `anthropic` uses the Claude Agent
 * SDK (a Claude Code login or ANTHROPIC_API_KEY); every other provider speaks the OpenAI-compatible
 * chat-completions protocol through the factory's own agent loop. `auto` picks whatever
 * credentials the machine has, Claude first. API keys are read from the environment and never
 * stored in a config file or a run.
 */
export const LlmSettings = z.object({
  provider: fields.provider.default('auto'),
  baseUrl: fields.baseUrl.optional(),
  apiKeyEnv: fields.apiKeyEnv.optional(),
  reasoning: fields.reasoning.default('auto'),
  headers: fields.headers.default({}),
  pricing: fields.pricing.default({}),
  probe: fields.probe.default(true),
})
export type LlmSettings = z.infer<typeof LlmSettings>

/** The same settings as a client sends them: nothing filled in, so a config's values survive a merge. */
export const LlmSettingsInput = z.object(fields).partial()
export type LlmSettingsInput = z.infer<typeof LlmSettingsInput>
