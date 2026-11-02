import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CreateRunInput, MpfConfig, RunEventBus, SqliteRunStore } from '@mpf/core'
import { Orchestrator } from '../src/runner.ts'
import { fakeRegistry } from '../src/stages/fake.ts'

function orchestrator(config: Record<string, unknown>) {
  const store = new SqliteRunStore(':memory:')
  return new Orchestrator({
    store,
    bus: new RunEventBus(store),
    config: MpfConfig.parse(config),
    registry: fakeRegistry(0.01),
    dataDir: mkdtempSync(join(tmpdir(), 'mpf-llm-')),
  })
}

describe('createRun and the model provider', () => {
  it('records the provider and fills the roles with its default models', () => {
    const run = orchestrator({ llm: { provider: 'openai' } }).createRun({
      source: { locator: './x' },
      targets: ['web'],
    })
    expect(run.options.llm.provider).toBe('openai')
    expect(run.options.models).toEqual({
      generate: 'gpt-5.1',
      critic: 'gpt-5.1',
      cheap: 'gpt-5-mini',
    })
  })

  it('lets the config and the request name models role by role without Claude defaults creeping in', () => {
    const run = orchestrator({
      llm: { provider: 'openai' },
      models: { cheap: 'gpt-5-nano' },
    }).createRun({
      source: { locator: './x' },
      targets: ['web'],
      options: { models: { generate: 'gpt-5.1-codex' } },
    })
    expect(run.options.models).toEqual({
      generate: 'gpt-5.1-codex',
      critic: 'gpt-5.1',
      cheap: 'gpt-5-nano',
    })
  })

  it('keeps partial models and llm settings through CreateRunInput', () => {
    const parsed = CreateRunInput.parse({
      source: { locator: './x' },
      targets: ['web'],
      options: { models: { generate: 'gpt-5.1' }, llm: { provider: 'openai' } },
    })
    expect(parsed.options?.models).toEqual({ generate: 'gpt-5.1' })
    expect(parsed.options?.llm).toEqual({ provider: 'openai' })
  })

  it('lets a request pick a provider for one run', () => {
    const run = orchestrator({}).createRun({
      source: { locator: './x' },
      targets: ['web'],
      options: { llm: { provider: 'gemini' } },
    })
    expect(run.options.llm.provider).toBe('gemini')
    expect(run.options.models.generate).toBe('gemini-2.5-pro')
  })

  it('refuses a provider without default models until every role is configured', () => {
    expect(() =>
      orchestrator({ llm: { provider: 'ollama' }, models: { generate: 'qwen3-coder' } }).createRun({
        source: { locator: './x' },
        targets: ['web'],
      }),
    ).toThrow(/no default model for critic, cheap: set models\.critic/)
    const run = orchestrator({
      llm: { provider: 'ollama' },
      models: { generate: 'qwen3-coder', critic: 'qwen3-coder', cheap: 'qwen3' },
    }).createRun({ source: { locator: './x' }, targets: ['web'] })
    expect(run.options.models.cheap).toBe('qwen3')
  })
})
