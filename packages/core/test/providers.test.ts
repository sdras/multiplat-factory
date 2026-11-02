import { describe, expect, it } from 'vitest'
import { hasKnownPrice, pricePerMillion } from '../src/cost/prices.ts'
import {
  defaultModelsFor,
  isLocalUrl,
  isTrustedModel,
  modelFitness,
  parameterCount,
  priceOptionsFor,
  reasoningEffortFor,
  resolveLlm,
} from '../src/providers.ts'

/** An environment with no Claude access: no keys, no profile, no ~/.claude. */
const bare = {
  HOME: '/nonexistent',
  XDG_CONFIG_HOME: '/nonexistent',
  CLAUDE_CONFIG_DIR: '/nonexistent',
}

describe('resolveLlm', () => {
  it('falls back to Claude when nothing is configured and no key is set', () => {
    const llm = resolveLlm({}, bare)
    expect(llm.backend).toBe('agent-sdk')
    expect(defaultModelsFor(llm)).toEqual({
      generate: 'claude-opus-5',
      critic: 'claude-opus-5',
      cheap: 'claude-sonnet-5',
    })
  })

  it('picks the provider whose key is set, Claude first', () => {
    expect(resolveLlm({}, { ...bare, OPENAI_API_KEY: 'k' }).provider).toBe('openai')
    expect(resolveLlm({}, { ...bare, GOOGLE_API_KEY: 'k' }).provider).toBe('gemini')
    expect(resolveLlm({}, { ...bare, OPENROUTER_API_KEY: 'k' }).provider).toBe('openrouter')
    expect(resolveLlm({}, { ...bare, OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }).provider).toBe(
      'anthropic',
    )
  })

  it('treats a configured base URL as a custom server and reads its key from MPF_LLM_API_KEY', () => {
    const llm = resolveLlm(
      { baseUrl: 'http://10.0.0.5:8000/v1/' },
      { ...bare, MPF_LLM_API_KEY: 'secret' },
    )
    expect(llm.backend).toBe('openai-compatible')
    if (llm.backend !== 'openai-compatible') return
    expect(llm.provider).toBe('custom')
    expect(llm.baseUrl).toBe('http://10.0.0.5:8000/v1')
    expect(llm.apiKey).toBe('secret')
    expect(llm.apiKeyEnv).toBe('MPF_LLM_API_KEY')
    expect(llm.local).toBe(false)
    expect(llm.reasoning).toBe(false)
    expect(defaultModelsFor(llm)).toBeUndefined()
  })

  it('applies a preset: base URL, key variable and its aliases, reasoning, models, headers', () => {
    const llm = resolveLlm({ provider: 'gemini' }, { ...bare, GOOGLE_API_KEY: 'g' })
    if (llm.backend !== 'openai-compatible') throw new Error('expected openai-compatible')
    expect(llm.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai')
    expect(llm.apiKey).toBe('g')
    expect(llm.apiKeyEnv).toBe('GEMINI_API_KEY')
    expect(llm.reasoning).toBe(true)
    expect(defaultModelsFor(llm)?.cheap).toBe('gemini-2.5-flash')
    const router = resolveLlm({ provider: 'openrouter', headers: { 'X-Extra': '1' } }, bare)
    if (router.backend !== 'openai-compatible') throw new Error('expected openai-compatible')
    expect(router.headers['X-Title']).toBe('multiplat-factory')
    expect(router.headers['X-Extra']).toBe('1')
  })

  it('knows a local server needs no key and costs nothing unless priced', () => {
    const llm = resolveLlm({ provider: 'ollama' }, bare)
    if (llm.backend !== 'openai-compatible') throw new Error('expected openai-compatible')
    expect(llm.local).toBe(true)
    expect(llm.apiKey).toBeUndefined()
    expect(priceOptionsFor(llm).fallback).toEqual({ input: 0, output: 0 })
    expect(pricePerMillion('qwen3-coder', priceOptionsFor(llm))).toEqual({ input: 0, output: 0 })
    const priced = resolveLlm(
      { provider: 'ollama', pricing: { 'qwen3-coder': { input: 1, output: 2 } } },
      bare,
    )
    expect(pricePerMillion('qwen3-coder', priceOptionsFor(priced))).toEqual({ input: 1, output: 2 })
  })

  it('lets the settings override the preset and force reasoning on or off', () => {
    const llm = resolveLlm(
      {
        provider: 'openai',
        baseUrl: 'https://proxy.example/v1',
        apiKeyEnv: 'PROXY_KEY',
        reasoning: 'off',
      },
      { ...bare, PROXY_KEY: 'p', OPENAI_API_KEY: 'o' },
    )
    if (llm.backend !== 'openai-compatible') throw new Error('expected openai-compatible')
    expect(llm.baseUrl).toBe('https://proxy.example/v1')
    expect(llm.apiKey).toBe('p')
    expect(llm.reasoning).toBe(false)
    const on = resolveLlm({ provider: 'ollama', reasoning: 'on' }, bare)
    expect(on.backend === 'openai-compatible' && on.reasoning).toBe(true)
  })

  it('refuses a custom provider without a base URL', () => {
    expect(() => resolveLlm({ provider: 'custom' }, bare)).toThrow(/llm\.baseUrl/)
  })

  it('maps effort levels onto the reasoning_effort scale', () => {
    expect(reasoningEffortFor('low')).toBe('low')
    expect(reasoningEffortFor('medium')).toBe('medium')
    expect(reasoningEffortFor('xhigh')).toBe('high')
    expect(reasoningEffortFor(undefined)).toBe('high')
  })

  it('recognizes local URLs', () => {
    expect(isLocalUrl('http://localhost:1234/v1')).toBe(true)
    expect(isLocalUrl('http://[::1]:1234/v1')).toBe(true)
    expect(isLocalUrl('https://api.openai.com/v1')).toBe(false)
    expect(isLocalUrl('not a url')).toBe(false)
  })
})

describe('pricePerMillion', () => {
  it('matches the longest family prefix and drops a vendor prefix', () => {
    expect(pricePerMillion('gpt-5-mini-2026-01-01')).toEqual(pricePerMillion('gpt-5-mini'))
    expect(pricePerMillion('gpt-5-mini')).not.toEqual(pricePerMillion('gpt-5'))
    expect(pricePerMillion('openai/gpt-5.1')).toEqual(pricePerMillion('gpt-5.1'))
    expect(pricePerMillion('claude-opus-5-20260101')).toEqual({ input: 5, output: 25 })
  })

  it('charges an unknown paid model at the dearest tier and says it has no price on file', () => {
    expect(pricePerMillion('mystery-9000')).toEqual({ input: 10, output: 50 })
    expect(hasKnownPrice('mystery-9000')).toBe(false)
    expect(hasKnownPrice('gpt-5.1')).toBe(true)
    expect(hasKnownPrice('mystery-9000', { 'mystery-9000': { input: 1, output: 1 } })).toBe(true)
  })
})

describe('model fitness by name', () => {
  it('reads a parameter count out of a model id', () => {
    expect(parameterCount('qwen2.5-coder:7b')).toBe(7)
    expect(parameterCount('Llama-3.1-70B-Instruct')).toBe(70)
    expect(parameterCount('gemma3:27b-it-q4_K_M')).toBe(27)
    expect(parameterCount('ollama/qwen3:1.5b')).toBe(1.5)
    expect(parameterCount('gpt-5.1')).toBeUndefined()
    expect(parameterCount('mixtral:8x7b')).toBeUndefined()
  })

  it('refuses small models, warns on mid-size ones and small tiers, and passes the rest', () => {
    expect(modelFitness('qwen2.5-coder:7b').level).toBe('error')
    expect(modelFitness('qwen2.5-coder:7b').reasons[0]).toMatch(/7B parameters/)
    expect(modelFitness('qwen2.5-coder:32b').level).toBe('warn')
    expect(modelFitness('llama3.1:70b').level).toBe('ok')
    expect(modelFitness('gpt-5-mini').level).toBe('warn')
    expect(modelFitness('gpt-5-mini', 'cheap').level).toBe('ok')
    expect(modelFitness('gemini-2.5-flash-lite', 'critic').reasons[0]).toMatch(/small tier/)
    expect(modelFitness('mystery-model').level).toBe('ok')
  })

  it('trusts frontier tiers on their name, vendor prefix or not', () => {
    for (const m of [
      'claude-opus-5',
      'claude-sonnet-5',
      'gpt-5.1',
      'gpt-5',
      'gpt-5.1-codex',
      'openai/gpt-5.1',
      'o3',
      'gpt-4.1',
      'gemini-2.5-pro',
      'google/gemini-3-pro-preview',
    ]) {
      expect(isTrustedModel(m), m).toBe(true)
      expect(modelFitness(m).trusted, m).toBe(true)
    }
    for (const m of [
      'gpt-5-mini',
      'gpt-5-nano',
      'o4-mini',
      'gemini-2.5-flash',
      'claude-haiku-4-5',
      'qwen2.5-coder:32b',
    ])
      expect(isTrustedModel(m), m).toBe(false)
  })
})
