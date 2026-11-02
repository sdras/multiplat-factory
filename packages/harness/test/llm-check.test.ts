import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { MpfConfig } from '@mpf/core'
import { llmCheck } from '../src/toolchain/checks/llm.ts'
import type { CheckContext } from '../src/toolchain/types.ts'

type ConfigInput = z.input<typeof MpfConfig>
type LlmInput = NonNullable<ConfigInput['llm']>
type ModelsInput = NonNullable<ConfigInput['models']>

interface RecordedCall {
  url: string
  headers: Record<string, string>
}

/** A fetch that answers from a handler and records the URL and headers it was given. */
function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: RecordedCall[] = []
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } })
    return respond(url)
  }
  return { fetchFn, calls }
}

function listing(ids: string[], status = 200): Response {
  return new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ctx(over: {
  llm?: LlmInput
  models?: ModelsInput
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
}): CheckContext {
  const config = MpfConfig.parse({ llm: over.llm ?? {}, models: over.models ?? {} })
  return {
    env: over.env ?? {},
    platform: process.platform,
    toolchain: config.toolchain,
    llm: config.llm,
    models: config.models,
    fetch: over.fetch,
  }
}

const local = { provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1' } as const
const allLlama = { generate: 'llama3', critic: 'llama3', cheap: 'llama3' }

describe('llmCheck on an OpenAI-compatible server', () => {
  it('is ok when the key is set and the server lists every model the factory would use', async () => {
    const { fetchFn, calls } = fakeFetch(() => listing(['gpt-5.1', 'gpt-5-mini', 'gpt-5-nano']))
    const check = await llmCheck(
      ctx({ llm: { provider: 'openai' }, env: { OPENAI_API_KEY: 'sk-test-only' }, fetch: fetchFn }),
    )
    expect(check).toMatchObject({
      id: 'llm',
      label: 'Model access',
      status: 'ok',
      version: 'openai-compatible',
      affects: ['llm'],
      detail: 'OpenAI at https://api.openai.com/v1: gpt-5.1 (generate, critic), gpt-5-mini (cheap)',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models')
    expect(calls[0]?.headers.Authorization).toBe('Bearer sk-test-only')
    expect(JSON.stringify(check)).not.toContain('sk-test-only')
  })

  it('sends the configured headers and no Authorization to a local server without a key', async () => {
    const { fetchFn, calls } = fakeFetch(() => listing(['llama3']))
    const check = await llmCheck(
      ctx({
        llm: { ...local, baseUrl: `${local.baseUrl}/`, headers: { 'X-Test': 'yes' } },
        models: allLlama,
        fetch: fetchFn,
      }),
    )
    expect(check.status).toBe('ok')
    expect(check.detail).toBe(
      'OpenAI-compatible server at http://127.0.0.1:1/v1: llama3 (generate, critic, cheap)',
    )
    expect(calls[0]?.url).toBe('http://127.0.0.1:1/v1/models')
    expect(calls[0]?.headers).toEqual({ 'X-Test': 'yes' })
  })

  it('warns when a configured model is not among the ones the server lists', async () => {
    const { fetchFn } = fakeFetch(() => listing(['llama3', 'mistral']))
    const check = await llmCheck(
      ctx({ llm: local, models: { ...allLlama, cheap: 'phi4' }, fetch: fetchFn }),
    )
    expect(check.status).toBe('warn')
    expect(check.version).toBe('openai-compatible')
    expect(check.detail).toBe(
      'OpenAI-compatible server at http://127.0.0.1:1/v1: phi4 not among the models the server lists (llama3, mistral); would use llama3 (generate, critic), phi4 (cheap)',
    )
  })

  it('shows at most ten of the ids a server lists', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `model-${i + 1}`)
    const { fetchFn } = fakeFetch(() => listing(ids))
    const check = await llmCheck(ctx({ llm: local, models: allLlama, fetch: fetchFn }))
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('model-10, … 12 in all')
    expect(check.detail).not.toContain('model-11')
  })

  it('accepts a listed id that matches once a vendor prefix is dropped on either side', async () => {
    const bare = fakeFetch(() => listing(['gpt-5.1', 'gpt-5-mini']))
    const openrouter = await llmCheck(
      ctx({
        llm: { provider: 'openrouter' },
        env: { OPENROUTER_API_KEY: 'or-test' },
        fetch: bare.fetchFn,
      }),
    )
    expect(openrouter.status).toBe('ok')
    expect(openrouter.detail).toBe(
      'OpenRouter at https://openrouter.ai/api/v1: openai/gpt-5.1 (generate, critic), openai/gpt-5-mini (cheap)',
    )
    expect(bare.calls[0]?.headers['X-Title']).toBe('multiplat-factory')

    const prefixed = fakeFetch(() => listing(['models/gemini-2.5-pro', 'models/gemini-2.5-flash']))
    const gemini = await llmCheck(
      ctx({
        llm: { provider: 'gemini' },
        env: { GOOGLE_API_KEY: 'g-test' },
        fetch: prefixed.fetchFn,
      }),
    )
    expect(gemini.status).toBe('ok')
    expect(prefixed.calls[0]?.headers.Authorization).toBe('Bearer g-test')
  })

  it('warns when the server cannot be reached and still names the models it would use', async () => {
    const { fetchFn } = fakeFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') })
    })
    const check = await llmCheck(ctx({ llm: local, models: allLlama, fetch: fetchFn }))
    expect(check.status).toBe('warn')
    expect(check.version).toBe('openai-compatible')
    expect(check.detail).toBe(
      'OpenAI-compatible server at http://127.0.0.1:1/v1: server could not be reached (connect ECONNREFUSED 127.0.0.1:1); would use llama3 (generate, critic, cheap)',
    )
  })

  it('warns on a server error and on a body without a data array', async () => {
    const failing = fakeFetch(() => new Response('nope', { status: 500 }))
    const error = await llmCheck(ctx({ llm: local, models: allLlama, fetch: failing.fetchFn }))
    expect(error.status).toBe('warn')
    expect(error.detail).toContain('server could not be reached (GET /models returned 500)')

    const empty = fakeFetch(() => Response.json({ object: 'list' }))
    const noList = await llmCheck(ctx({ llm: local, models: allLlama, fetch: empty.fetchFn }))
    expect(noList.status).toBe('warn')
    expect(noList.detail).toContain('server listed no models (the response has no data array)')
    expect(noList.detail).toContain('would use llama3 (generate, critic, cheap)')
  })

  it('is missing on a rejected key, naming the variable and never the key', async () => {
    const { fetchFn } = fakeFetch(() => new Response('', { status: 401 }))
    const check = await llmCheck(
      ctx({ llm: { provider: 'openai' }, env: { OPENAI_API_KEY: 'sk-bad-key' }, fetch: fetchFn }),
    )
    expect(check.status).toBe('missing')
    expect(check.detail).toBe(
      'OpenAI at https://api.openai.com/v1: authentication failed; check OPENAI_API_KEY',
    )
    expect(check.fix?.manual).toBe('export OPENAI_API_KEY=...')
    expect(JSON.stringify(check)).not.toContain('sk-bad-key')
  })

  it('is missing without a key on a paid provider and never contacts the server', async () => {
    const { fetchFn, calls } = fakeFetch(() => listing(['gpt-5.1']))
    const check = await llmCheck(ctx({ llm: { provider: 'openai' }, env: {}, fetch: fetchFn }))
    expect(check).toMatchObject({
      status: 'missing',
      version: 'openai-compatible',
      detail: 'OpenAI at https://api.openai.com/v1: no API key; set OPENAI_API_KEY',
      fix: { manual: 'export OPENAI_API_KEY=...' },
    })
    expect(calls).toHaveLength(0)
  })

  it('is missing when a local provider has no models configured', async () => {
    const { fetchFn, calls } = fakeFetch(() => listing(['llama3']))
    const none = await llmCheck(ctx({ llm: { provider: 'ollama' }, env: {}, fetch: fetchFn }))
    expect(none).toMatchObject({
      status: 'missing',
      version: 'openai-compatible',
      detail:
        'Ollama at http://127.0.0.1:11434/v1: no model configured for generate, critic, cheap',
    })
    expect(none.fix?.manual).toContain(
      '"models": { "generate": "...", "critic": "...", "cheap": "..." }',
    )
    expect(none.fix?.manual).toContain('~/.mpf/config.json')
    expect(calls).toHaveLength(0)

    const partial = await llmCheck(
      ctx({ llm: { provider: 'ollama' }, models: { generate: 'llama3' }, fetch: fetchFn }),
    )
    expect(partial.status).toBe('missing')
    expect(partial.detail).toContain('no model configured for critic, cheap')
  })

  it('notes models with no price on file on a paid provider until llm.pricing names them', async () => {
    const models = {
      generate: 'mistralai/mistral-large',
      critic: 'mistralai/mistral-large',
      cheap: 'openai/gpt-5-mini',
    }
    const { fetchFn } = fakeFetch(() => listing(Object.values(models)))
    const env = { OPENROUTER_API_KEY: 'or-test' }
    const unpriced = await llmCheck(
      ctx({ llm: { provider: 'openrouter' }, models, env, fetch: fetchFn }),
    )
    expect(unpriced.status).toBe('ok')
    expect(unpriced.detail).toBe(
      'OpenRouter at https://openrouter.ai/api/v1: mistralai/mistral-large (generate, critic), openai/gpt-5-mini (cheap); no price on file for mistralai/mistral-large (budgets charge the dearest tier; set llm.pricing)',
    )

    const priced = await llmCheck(
      ctx({
        llm: {
          provider: 'openrouter',
          pricing: { 'mistralai/mistral-large': { input: 2, output: 6 } },
        },
        models,
        env,
        fetch: fetchFn,
      }),
    )
    expect(priced.status).toBe('ok')
    expect(priced.detail).not.toContain('no price on file')

    const unreachable = fakeFetch(() => {
      throw new Error('ECONNRESET')
    })
    const warned = await llmCheck(
      ctx({ llm: { provider: 'openrouter' }, models, env, fetch: unreachable.fetchFn }),
    )
    expect(warned.status).toBe('warn')
    expect(warned.detail).toContain('no price on file for mistralai/mistral-large')
  })

  it('never notes prices for a local server, whose tokens cost nothing', async () => {
    const { fetchFn } = fakeFetch(() => listing(['llama3']))
    const check = await llmCheck(ctx({ llm: local, models: allLlama, fetch: fetchFn }))
    expect(check.status).toBe('ok')
    expect(check.detail).not.toContain('no price on file')
  })

  it('is missing when a custom provider has no base URL', async () => {
    const { fetchFn, calls } = fakeFetch(() => listing(['llama3']))
    const check = await llmCheck(
      ctx({ llm: { provider: 'custom' }, models: allLlama, fetch: fetchFn }),
    )
    expect(check.status).toBe('missing')
    expect(check.version).toBe('none')
    expect(check.detail).toContain('llm.baseUrl is not set')
    expect(check.fix?.manual).toBe('set llm.baseUrl in ~/.mpf/config.json or MPF_LLM_BASE_URL')
    expect(calls).toHaveLength(0)
  })
})

describe('llmCheck and model fitness by name', () => {
  it('warns about a model too small or mid-size for the factory, with the reason', async () => {
    const { fetchFn } = fakeFetch(() => listing(['qwen2.5-coder:7b', 'qwen2.5-coder:32b']))
    const small = await llmCheck(
      ctx({
        llm: local,
        models: {
          generate: 'qwen2.5-coder:7b',
          critic: 'qwen2.5-coder:7b',
          cheap: 'qwen2.5-coder:7b',
        },
        fetch: fetchFn,
      }),
    )
    expect(small.status).toBe('warn')
    expect(small.detail).toMatch(/7B parameters/)
    expect(small.detail).toMatch(/mpf doctor --probe/)
    const mid = await llmCheck(
      ctx({
        llm: local,
        models: {
          generate: 'qwen2.5-coder:32b',
          critic: 'qwen2.5-coder:32b',
          cheap: 'qwen2.5-coder:7b',
        },
        fetch: fetchFn,
      }),
    )
    expect(mid.status).toBe('warn')
    expect(mid.detail).toMatch(/mid-size model \(32B\)/)
    expect(mid.detail).toMatch(/7B parameters/)
  })
})
