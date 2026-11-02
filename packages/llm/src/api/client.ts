import { reasoningEffortFor, type Effort, type OpenAiCompatibleLlm } from '@mpf/core'
import type { ChatRequest, ChatResponse } from './types.ts'

/** The server answered with an HTTP error that retrying would not change. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

/** 401 or 403: the key is missing or wrong. */
export class ApiAuthError extends ApiRequestError {
  constructor(llm: OpenAiCompatibleLlm, status: number, body: string) {
    super(`authentication failed for ${llm.label}: set ${llm.apiKeyEnv}`, status, body)
    this.name = 'ApiAuthError'
  }
}

/** The caller's signal fired. */
export class ApiAbortError extends Error {
  constructor() {
    super('aborted')
    this.name = 'ApiAbortError'
  }
}

export interface RequestOptions {
  signal?: AbortSignal
  /** Per-request timeout; a request that takes longer counts as a network failure and is retried. */
  timeoutMs?: number
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const DEFAULT_DELAYS_MS = [1000, 4000, 10000]
export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

/** Backoff between retries, overridable for tests (`MPF_LLM_RETRY_DELAYS_MS=1,1,1`). */
export function retryDelaysMs(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.MPF_LLM_RETRY_DELAYS_MS
  if (!raw) return DEFAULT_DELAYS_MS
  const parsed = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)
  return parsed.length ? parsed : DEFAULT_DELAYS_MS
}

/** A 400 that names an unsupported `reasoning_effort` parameter. */
export function rejectsReasoningEffort(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 400 && /reasoning_effort/i.test(err.body)
}

/** A 400 that says the conversation no longer fits the model's context window. */
export function isContextOverflow(err: unknown): boolean {
  return (
    err instanceof ApiRequestError &&
    err.status === 400 &&
    /context[ _]length|maximum context|context window|too many tokens|too long|exceeds? the (?:maximum|limit)|max(?:imum)?_tokens|token limit/i.test(
      err.body,
    )
  )
}

/** A 400 that refuses the `tool_choice` parameter (older or smaller servers). */
export function rejectsToolChoice(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 400 && /tool_choice/i.test(err.body)
}

/**
 * One non-streaming `POST ${baseUrl}/chat/completions`. Transient failures (408, 429, 5xx, a
 * network error, the per-request timeout) are retried with backoff and `Retry-After` honored;
 * 401/403 fail at once with the key's variable name; every other error status throws an
 * `ApiRequestError` the caller can inspect.
 */
export async function chatCompletion(
  llm: OpenAiCompatibleLlm,
  body: ChatRequest,
  options: RequestOptions = {},
): Promise<ChatResponse> {
  const delays = retryDelaysMs()
  const url = `${llm.baseUrl}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
    ...llm.headers,
  }
  const payload = JSON.stringify(body)
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (options.signal?.aborted) throw new ApiAbortError()
    const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let response: Response
    let text: string
    try {
      response = await fetch(url, { method: 'POST', headers, body: payload, signal })
      // A connection cut after the headers, or the timeout firing mid-body, fails here.
      text = await response.text()
    } catch (err) {
      if (options.signal?.aborted) throw new ApiAbortError()
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < delays.length) {
        await sleep(delays[attempt]!, options.signal)
        continue
      }
      throw new Error(`${llm.label}: ${describeNetworkError(lastError)}`, { cause: err })
    }
    if (response.ok) {
      const parsed = parseJson(text)
      if (parsed === undefined)
        throw new ApiRequestError(
          `${llm.label} answered with something other than JSON: ${excerpt(text, 200)}`,
          response.status,
          text,
        )
      return parsed
    }
    if (response.status === 401 || response.status === 403)
      throw new ApiAuthError(llm, response.status, text)
    if (RETRY_STATUSES.has(response.status) && attempt < delays.length) {
      lastError = new ApiRequestError(
        `${llm.label} answered ${response.status}: ${excerpt(text)}`,
        response.status,
        text,
      )
      const wait = retryAfterMs(response.headers.get('retry-after')) ?? delays[attempt]!
      await sleep(wait, options.signal)
      continue
    }
    throw new ApiRequestError(
      `${llm.label} answered ${response.status}: ${excerpt(text)}`,
      response.status,
      text,
    )
  }
  throw lastError ?? new Error(`${llm.label}: request failed`)
}

/** Remembered for the rest of a run: whether the server refused `reasoning_effort`. */
export interface EffortState {
  reasoningRejected: boolean
}

/**
 * `chatCompletion` with `reasoning_effort` when the backend is marked as supporting it; a 400 that
 * names the parameter retries once without it and drops it from every later request of the run.
 */
export async function chatCompletionWithEffort(
  llm: OpenAiCompatibleLlm,
  body: ChatRequest,
  effort: Effort | undefined,
  state: EffortState,
  options: RequestOptions = {},
): Promise<ChatResponse> {
  const withEffort = llm.reasoning && !state.reasoningRejected
  try {
    return await chatCompletion(
      llm,
      withEffort ? { ...body, reasoning_effort: reasoningEffortFor(effort) } : body,
      options,
    )
  } catch (err) {
    if (withEffort && rejectsReasoningEffort(err)) {
      state.reasoningRejected = true
      return chatCompletion(llm, body, options)
    }
    throw err
  }
}

function describeNetworkError(err: Error): string {
  if (err.name === 'TimeoutError') return 'the request timed out'
  const cause = (err as { cause?: { code?: string; message?: string } }).cause
  const detail = cause?.code ?? cause?.message
  return `network error: ${err.message}${detail ? ` (${detail})` : ''}`
}

function parseJson(text: string): ChatResponse | undefined {
  try {
    return JSON.parse(text) as ChatResponse
  } catch {
    return undefined
  }
}

function excerpt(text: string, max = 300): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** Seconds or an HTTP date, capped at a minute so a hostile header cannot stall a run. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(0, at - Date.now()), 60_000)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiAbortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ApiAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
