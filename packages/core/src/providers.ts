import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'pathe'
import type { PriceOptions } from './cost/prices.ts'
import type { LlmProvider, LlmSettings, ModelPrice } from './schemas/llm.ts'
import { ModelConfig, type Effort } from './schemas/run.ts'

/** Providers that speak the OpenAI-compatible chat-completions protocol. */
export type OpenAiProvider = Exclude<LlmProvider, 'anthropic'>

export interface ProviderPreset {
  label: string
  baseUrl?: string
  /** Environment variable that holds the key; `apiKeyEnvAliases` are read when it is unset. */
  apiKeyEnv?: string
  apiKeyEnvAliases?: string[]
  /** Whether the server accepts a `reasoning_effort` parameter. */
  reasoning: boolean
  /** A server on this machine: no key needed and tokens cost nothing unless priced in config. */
  local: boolean
  /** Models used when the config names none. A preset without them needs `models` in the config. */
  models?: ModelConfig
  headers?: Record<string, string>
}

export const PROVIDER_PRESETS: Record<OpenAiProvider, ProviderPreset> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    reasoning: true,
    local: false,
    models: { generate: 'gpt-5.1', critic: 'gpt-5.1', cheap: 'gpt-5-mini' },
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    apiKeyEnvAliases: ['GOOGLE_API_KEY'],
    reasoning: true,
    local: false,
    models: { generate: 'gemini-2.5-pro', critic: 'gemini-2.5-pro', cheap: 'gemini-2.5-flash' },
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    reasoning: false,
    local: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    reasoning: true,
    local: false,
    models: { generate: 'openai/gpt-5.1', critic: 'openai/gpt-5.1', cheap: 'openai/gpt-5-mini' },
    headers: {
      'HTTP-Referer': 'https://github.com/sdras/multiplat-factory',
      'X-Title': 'multiplat-factory',
    },
  },
  custom: {
    label: 'OpenAI-compatible server',
    apiKeyEnv: 'MPF_LLM_API_KEY',
    reasoning: false,
    local: false,
  },
}

export interface AgentSdkLlm {
  backend: 'agent-sdk'
  provider: 'anthropic'
  label: string
}

export interface OpenAiCompatibleLlm {
  backend: 'openai-compatible'
  provider: OpenAiProvider
  label: string
  /** Without a trailing slash; requests go to `${baseUrl}/chat/completions` and `${baseUrl}/models`. */
  baseUrl: string
  apiKey?: string
  apiKeyEnv: string
  headers: Record<string, string>
  reasoning: boolean
  local: boolean
  pricing: Record<string, ModelPrice>
  defaultModels?: ModelConfig
}

export type ResolvedLlm = AgentSdkLlm | OpenAiCompatibleLlm

export type ClaudeAccess = 'messages' | 'agent-sdk' | 'none'

/**
 * Which Claude access a plain Node process has: `messages` with an API key or an `ant auth login`
 * profile, `agent-sdk` through a Claude Code login. `mpf doctor` confirms the login itself.
 */
export function detectClaudeAccess(env: NodeJS.ProcessEnv = process.env): ClaudeAccess {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'messages'
  const profileDir = join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'anthropic')
  if (existsSync(profileDir)) return 'messages'
  if (existsSync(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))) return 'agent-sdk'
  return 'none'
}

/**
 * Turn the settings (config or a run's options) into a concrete backend. `auto` takes an explicit
 * base URL as a custom server, then Claude when the machine has it, then whichever provider has a
 * key in the environment, and Claude as the last resort so the usual "no login" message appears.
 */
export function resolveLlm(
  settings: Partial<LlmSettings> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedLlm {
  const provider =
    settings.provider && settings.provider !== 'auto'
      ? settings.provider
      : autoProvider(settings, env)
  if (provider === 'anthropic')
    return { backend: 'agent-sdk', provider, label: 'Claude through the Agent SDK' }
  const preset = PROVIDER_PRESETS[provider]
  const baseUrl = (settings.baseUrl ?? preset.baseUrl)?.replace(/\/+$/, '')
  if (!baseUrl)
    throw new Error(
      `llm.provider is "${provider}" but llm.baseUrl is not set (the chat-completions URL, usually ending in /v1)`,
    )
  const apiKeyEnv = settings.apiKeyEnv ?? preset.apiKeyEnv ?? 'MPF_LLM_API_KEY'
  const apiKey = firstSet(env, [apiKeyEnv, ...(preset.apiKeyEnvAliases ?? []), 'MPF_LLM_API_KEY'])
  const local = preset.local || isLocalUrl(baseUrl)
  const reasoning =
    settings.reasoning === 'on' ? true : settings.reasoning === 'off' ? false : preset.reasoning
  return {
    backend: 'openai-compatible',
    provider,
    label: `${preset.label} at ${baseUrl}`,
    baseUrl,
    apiKey,
    apiKeyEnv,
    headers: { ...preset.headers, ...settings.headers },
    reasoning,
    local,
    pricing: settings.pricing ?? {},
    defaultModels: preset.models,
  }
}

function autoProvider(settings: Partial<LlmSettings>, env: NodeJS.ProcessEnv): LlmProvider {
  if (settings.baseUrl) return 'custom'
  if (detectClaudeAccess(env) !== 'none') return 'anthropic'
  if (env.OPENAI_API_KEY) return 'openai'
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return 'gemini'
  if (env.OPENROUTER_API_KEY) return 'openrouter'
  return 'anthropic'
}

/** The per-role models a provider uses when the config names none; `undefined` means it must be configured. */
export function defaultModelsFor(llm: ResolvedLlm): ModelConfig | undefined {
  return llm.backend === 'agent-sdk' ? ModelConfig.parse({}) : llm.defaultModels
}

/** The factory's effort levels on the OpenAI-style `reasoning_effort` scale. */
export function reasoningEffortFor(effort: Effort | undefined): 'low' | 'medium' | 'high' {
  if (effort === 'low' || effort === 'medium') return effort
  return 'high'
}

/** Price lookup options for a backend: the config's prices win, and a local server costs nothing. */
export function priceOptionsFor(llm: ResolvedLlm): PriceOptions {
  if (llm.backend === 'agent-sdk') return {}
  return { overrides: llm.pricing, fallback: llm.local ? { input: 0, output: 0 } : undefined }
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
  } catch {
    return false
  }
}

function firstSet(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const v = env[name]
    if (v) return v
  }
  return undefined
}

export type FitnessLevel = 'ok' | 'warn' | 'error'

export interface ModelFitness {
  level: FitnessLevel
  reasons: string[]
  /** Billions of parameters when the model id says so. */
  parameterCount?: number
  /** A frontier model the factory trusts without a live probe. */
  trusted: boolean
}

/** Frontier tiers that pass without a probe: Claude, OpenAI's full-size GPT-5 and o-series, Gemini Pro. */
const TRUSTED_MODELS = [
  /^claude-(opus|sonnet|fable)/i,
  /^gpt-5(?![\w.-]*(?:mini|nano))/i,
  /^gpt-4\.1(?!-(?:mini|nano))/i,
  /^o3(?:-pro)?$/i,
  /^gemini-\d+(?:\.\d+)?-pro/i,
]

/** Whether a model is a known frontier tier (a vendor prefix such as OpenRouter's is ignored). */
export function isTrustedModel(model: string): boolean {
  const name = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  return TRUSTED_MODELS.some((re) => re.test(name))
}

/** The smallest model size that has managed a port; everything under it is refused by default. */
export const MIN_PARAMETERS_B = 30
/** Below this a model is mid-size: allowed, with a warning. */
export const MID_PARAMETERS_B = 70

/** Parameters in billions when the model id says so (`qwen2.5-coder:7b`, `Llama-3.1-70B-Instruct`). */
export function parameterCount(model: string): number | undefined {
  const name = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  const m = /(?:^|[^a-z0-9])(\d{1,3}(?:\.\d+)?)b(?![a-z0-9])/i.exec(name)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const SMALL_TIERS = /(?:^|[-_:/ .])(nano|mini|lite|tiny|small|haiku|flash-lite)(?=$|[-_:/ .])/i

/**
 * What a model's name says about its fitness for a role. A parameter count under 30B is an error
 * (such models have not managed a port: the first spec attempt of a 7B coder edited the source
 * instead), 30B to 70B a warning, and a small cloud tier (`mini`, `nano`, `lite`, `haiku`) a
 * warning for generation and review. The live probe in `@mpf/llm` measures what the name cannot.
 */
export function modelFitness(model: string, role: keyof ModelConfig = 'generate'): ModelFitness {
  const reasons: string[] = []
  let level: FitnessLevel = 'ok'
  const trusted = isTrustedModel(model)
  if (trusted) return { level, reasons, trusted }
  const params = parameterCount(model)
  if (params !== undefined && params < MIN_PARAMETERS_B) {
    level = 'error'
    reasons.push(
      `${model} has about ${params}B parameters; the factory's workers need strong tool use and code generation, and models this small have not managed a port (use ${MIN_PARAMETERS_B}B or larger, or a hosted model)`,
    )
  } else if (params !== undefined && params < MID_PARAMETERS_B) {
    level = 'warn'
    reasons.push(
      `${model} is a mid-size model (${params}B); expect weaker ports and more fix rounds`,
    )
  }
  if (role !== 'cheap' && SMALL_TIERS.test(model)) {
    if (level === 'ok') level = 'warn'
    reasons.push(
      `${model} is a small tier; fine for the cheap role, weak for ${role === 'critic' ? 'review' : 'generation'}`,
    )
  }
  return { level, reasons, parameterCount: params, trusted }
}
