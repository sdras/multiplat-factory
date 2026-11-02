import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'pathe'
import {
  defaultModelsFor,
  hasKnownPrice,
  modelFitness,
  resolveLlm,
  type ModelConfig,
  type ModelOverrides,
  type OpenAiCompatibleLlm,
  type ResolvedLlm,
  type ToolchainCheck,
} from '@mpf/core'
import { tryOutput, which } from '../../exec.ts'
import { type CheckContext, type CheckFn, missing, ok, warn } from '../types.ts'

const ID = 'llm'
const LABEL = 'Model access'
const AFFECTS = ['llm']
const ROLES = ['generate', 'critic', 'cheap'] as const
const PROBE_TIMEOUT_MS = 5_000
const LISTED_IDS_SHOWN = 10

/**
 * Which model backend can run here, resolved from the config's `llm` settings:
 *  - Claude through the Agent SDK (`version` `messages` with ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
 *    an `ant auth login` profile, `agent-sdk` with a Claude Code login)
 *  - an OpenAI-compatible server (`version` `openai-compatible`): the key is present, every role
 *    has a model, and `GET <baseUrl>/models` lists the models the factory would use.
 * Never prints a key.
 */
export const llmCheck: CheckFn = async (ctx) => {
  let llm: ResolvedLlm
  try {
    llm = resolveLlm(ctx.llm, ctx.env)
  } catch (err) {
    return missing(ID, LABEL, (err as Error).message, {
      affects: AFFECTS,
      version: 'none',
      fix: { manual: 'set llm.baseUrl in ~/.mpf/config.json or MPF_LLM_BASE_URL' },
    })
  }
  if (llm.backend === 'agent-sdk') return claudeCheck(ctx.env)
  return openAiCompatibleCheck(llm, ctx)
}

async function claudeCheck(env: NodeJS.ProcessEnv): Promise<ToolchainCheck> {
  const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)
  const profileDir = join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'anthropic')
  const hasProfile = existsSync(profileDir)
  const claude = await which('claude', env)
  let claudeLoggedIn: boolean
  let via = 'Claude Code login'
  if (claude) {
    const status = await tryOutput(claude, ['auth', 'status'], env, 20_000)
    claudeLoggedIn = parseLoggedIn(status)
  } else {
    // The Agent SDK bundles its own runtime, so a login counts even when the `claude` binary is not on PATH.
    claudeLoggedIn = await storedClaudeCredentials(env)
    if (claudeLoggedIn)
      via = 'Claude Code credentials (stored login; claude binary not on PATH in this shell)'
  }
  if (hasKey || hasProfile) {
    const via = hasKey ? 'API key in environment' : 'ant auth profile'
    const extra = claudeLoggedIn ? '; Claude Code login also available for workers' : ''
    return ok(ID, LABEL, `Claude: ${via}${extra}`, {
      affects: AFFECTS,
      // encode backend choice for the doctor summary
      version: 'messages',
    })
  }
  if (claudeLoggedIn) {
    return ok(ID, LABEL, `Claude: ${via} (Agent SDK backend for workers and critic)`, {
      affects: AFFECTS,
      version: 'agent-sdk',
    })
  }
  if (claude) {
    return warn(
      ID,
      LABEL,
      'Claude: Claude Code found but login could not be confirmed; run `claude` once to log in, or set ANTHROPIC_API_KEY',
      {
        affects: AFFECTS,
        version: 'agent-sdk',
        fix: { manual: 'claude   # then /login' },
      },
    )
  }
  return missing(ID, LABEL, 'Claude: no API key, no ant profile, no Claude Code login', {
    affects: AFFECTS,
    version: 'none',
    fix: {
      manual:
        'export ANTHROPIC_API_KEY=...  or  npm i -g @anthropic-ai/claude-code && claude  or  set llm.provider (openai, gemini, ollama, openrouter, custom) in ~/.mpf/config.json',
    },
  })
}

async function openAiCompatibleCheck(
  llm: OpenAiCompatibleLlm,
  ctx: CheckContext,
): Promise<ToolchainCheck> {
  const extra = { affects: AFFECTS, version: 'openai-compatible' }
  if (!llm.local && !llm.apiKey) {
    return missing(ID, LABEL, `${llm.label}: no API key; set ${llm.apiKeyEnv}`, {
      ...extra,
      fix: { manual: `export ${llm.apiKeyEnv}=...` },
    })
  }
  const models = usedModels(llm, ctx.models)
  const unset = ROLES.filter((role) => !models[role])
  if (unset.length > 0) {
    return missing(ID, LABEL, `${llm.label}: no model configured for ${unset.join(', ')}`, {
      ...extra,
      fix: {
        manual:
          'add "models": { "generate": "...", "critic": "...", "cheap": "..." } to ~/.mpf/config.json',
      },
    })
  }
  const used = models as ModelConfig
  const summary = describeModels(used)
  const fitness = ROLES.map((role) => modelFitness(used[role], role))
  const fitnessLevel = fitness.some((f) => f.level === 'error')
    ? 'error'
    : fitness.some((f) => f.level === 'warn')
      ? 'warn'
      : 'ok'
  const fitnessNote =
    fitnessLevel === 'ok'
      ? ''
      : `; ${distinct(fitness.flatMap((f) => f.reasons)).join('. ')} (mpf doctor --probe measures it; a run refuses a model the probe or the size rule rejects unless llm.probe is false)`
  const price = (llm.local ? '' : unknownPriceNote(used, llm.pricing)) + fitnessNote

  const probe = await listModels(llm, ctx.fetch ?? globalThis.fetch)
  if (probe.kind === 'unauthorized') {
    return missing(ID, LABEL, `${llm.label}: authentication failed; check ${llm.apiKeyEnv}`, {
      ...extra,
      fix: { manual: `export ${llm.apiKeyEnv}=...` },
    })
  }
  if (probe.kind === 'unreachable') {
    return warn(
      ID,
      LABEL,
      `${llm.label}: server could not be reached (${probe.reason}); would use ${summary}${price}`,
      extra,
    )
  }
  if (probe.kind === 'no-list') {
    return warn(
      ID,
      LABEL,
      `${llm.label}: server listed no models (${probe.reason}); would use ${summary}${price}`,
      extra,
    )
  }
  const absent = distinct(Object.values(used)).filter((model) => !offers(probe.ids, model))
  if (absent.length > 0) {
    const shown = probe.ids.slice(0, LISTED_IDS_SHOWN).join(', ')
    const more = probe.ids.length > LISTED_IDS_SHOWN ? `, … ${probe.ids.length} in all` : ''
    return warn(
      ID,
      LABEL,
      `${llm.label}: ${absent.join(', ')} not among the models the server lists (${shown}${more}); would use ${summary}${price}`,
      extra,
    )
  }
  if (fitnessLevel !== 'ok') return warn(ID, LABEL, `${llm.label}: ${summary}${price}`, extra)
  return ok(ID, LABEL, `${llm.label}: ${summary}${price}`, extra)
}

/** The per-role models the factory would run with: the config's overrides over the provider's defaults. */
function usedModels(llm: ResolvedLlm, overrides: ModelOverrides): Partial<ModelConfig> {
  const set: Partial<ModelConfig> = {}
  for (const role of ROLES) {
    const model = overrides[role] ?? defaultModelsFor(llm)?.[role]
    if (model) set[role] = model
  }
  return set
}

/** `gpt-5.1 (generate, critic), gpt-5-mini (cheap)` */
function describeModels(models: ModelConfig): string {
  const roles = new Map<string, string[]>()
  for (const role of ROLES) {
    const model = models[role]
    roles.set(model, [...(roles.get(model) ?? []), role])
  }
  return [...roles].map(([model, names]) => `${model} (${names.join(', ')})`).join(', ')
}

function unknownPriceNote(models: ModelConfig, pricing: OpenAiCompatibleLlm['pricing']): string {
  const unpriced = distinct(Object.values(models)).filter((m) => !hasKnownPrice(m, pricing))
  if (unpriced.length === 0) return ''
  return `; no price on file for ${unpriced.join(', ')} (budgets charge the dearest tier; set llm.pricing)`
}

/**
 * Whether a listed id names the configured model. Exact first; then with a vendor prefix dropped
 * on either side, because OpenRouter configures `openai/gpt-5.1` where a plain server lists
 * `gpt-5.1`, and Gemini's endpoint lists `models/gemini-2.5-pro` for a configured `gemini-2.5-pro`.
 */
function offers(ids: string[], model: string): boolean {
  if (ids.includes(model)) return true
  const bare = bareName(model)
  return ids.some((id) => bareName(id) === bare)
}

function bareName(model: string): string {
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
}

function distinct(values: string[]): string[] {
  return [...new Set(values)]
}

type ModelListing =
  | { kind: 'listed'; ids: string[] }
  | { kind: 'unauthorized' }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'no-list'; reason: string }

/** `GET <baseUrl>/models`, the one OpenAI-compatible endpoint every server has; five seconds at most. */
async function listModels(
  llm: OpenAiCompatibleLlm,
  fetchFn: typeof globalThis.fetch,
): Promise<ModelListing> {
  const headers: Record<string, string> = { ...llm.headers }
  if (llm.apiKey) headers.Authorization = `Bearer ${llm.apiKey}`
  let response: Response
  try {
    response = await fetchFn(`${llm.baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (err) {
    return { kind: 'unreachable', reason: errorReason(err) }
  }
  if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' }
  if (!response.ok)
    return { kind: 'unreachable', reason: `GET /models returned ${response.status}` }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: 'no-list', reason: 'the response was not JSON' }
  }
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return { kind: 'no-list', reason: 'the response has no data array' }
  const ids = data
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string')
  return { kind: 'listed', ids }
}

/** The underlying cause when fetch wraps it (`fetch failed` over ECONNREFUSED), never a header or a key. */
function errorReason(err: unknown): string {
  const error = err as { name?: string; message?: string; cause?: { message?: string } }
  if (error?.name === 'TimeoutError') return `no answer within ${PROBE_TIMEOUT_MS / 1000} s`
  const text = error?.cause?.message || error?.message || String(err)
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/** Claude Code keeps OAuth credentials in the macOS keychain or in ~/.claude/.credentials.json elsewhere. Never reads the secret. */
async function storedClaudeCredentials(env: NodeJS.ProcessEnv): Promise<boolean> {
  const home = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  if (existsSync(join(home, '.credentials.json'))) return true
  if (process.platform === 'darwin') {
    const found = await tryOutput(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      env,
      10_000,
    )
    return found !== undefined
  }
  return false
}

/** `claude auth status` prints JSON with `loggedIn`; older builds print prose. */
function parseLoggedIn(output: string | undefined): boolean {
  if (!output) return false
  try {
    const json = JSON.parse(output) as { loggedIn?: boolean }
    if (typeof json.loggedIn === 'boolean') return json.loggedIn
  } catch {
    /* not JSON */
  }
  return !/not logged in|no credentials|logged out/i.test(output)
}
