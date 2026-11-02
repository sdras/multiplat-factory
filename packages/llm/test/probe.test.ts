import { writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import type { AgentRunOptions, AgentRunResult } from '../src/agent.ts'
import { probeModel, type ProbeOptions } from '../src/probe.ts'

const usage = { input_tokens: 100, output_tokens: 600 }

/** A worker that does the task properly: writes summary.md and submits the right result. */
const goodAgent = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
  writeFileSync(join(opts.cwd, 'summary.md'), 'THE QUICK BROWN FOX\n')
  return {
    ok: true,
    text: 'done',
    structured: { firstLine: 'the quick brown fox', files: ['notes.txt', 'summary.md'] },
    costUsd: 0.02,
    numTurns: 4,
    denials: 0,
    usage,
  }
}
const idleAgent = async (): Promise<AgentRunResult> => ({
  ok: false,
  text: '',
  costUsd: 0.01,
  numTurns: 12,
  denials: 0,
  error: 'maximum turns (12) reached',
})
const goodCall: ProbeOptions['structured'] = async () =>
  ({ ok: true, data: { answer: 42, reasoning: 'six sevens' }, costUsd: 0.001, usage: {} }) as never
const wrongCall: ProbeOptions['structured'] = async () =>
  ({ ok: true, data: { answer: 41, reasoning: 'nearly' }, costUsd: 0.001, usage: {} }) as never

const base = {
  llm: { provider: 'custom' as const, baseUrl: 'http://127.0.0.1:1/v1' },
  model: 'local-coder',
}

describe('probeModel', () => {
  it('passes a model that does the task, with its throughput and cost', async () => {
    const p = await probeModel({ ...base, agent: goodAgent, structured: goodCall })
    expect(p.level).toBe('ok')
    expect(p.toolUse).toBe(true)
    expect(p.structured).toBe(true)
    expect(p.outputTokensPerSecond).toBeGreaterThan(25)
    expect(p.turns).toBe(4)
    expect(p.costUsd).toBeCloseTo(0.021)
    expect(p.reasons).toEqual([])
  })

  it('refuses a model that cannot complete the tool task', async () => {
    const p = await probeModel({ ...base, agent: idleAgent, structured: goodCall })
    expect(p.level).toBe('error')
    expect(p.toolUse).toBe(false)
    expect(p.reasons.join(' ')).toMatch(/could not complete a four-step task.*maximum turns/)
  })

  it('refuses a model whose structured answers are wrong', async () => {
    const p = await probeModel({ ...base, agent: goodAgent, structured: wrongCall })
    expect(p.level).toBe('error')
    expect(p.structured).toBe(false)
    expect(p.reasons[0]).toMatch(/requested shape/)
  })

  it('refuses a slow model and warns on a sluggish one', async () => {
    const slow = await probeModel({
      ...base,
      agent: goodAgent,
      structured: goodCall,
      thresholds: { slowTokensPerSecond: 1e9, sluggishTokensPerSecond: 2e9 },
    })
    expect(slow.level).toBe('error')
    expect(slow.reasons[0]).toMatch(/output tokens per second; under/)
    const sluggish = await probeModel({
      ...base,
      agent: goodAgent,
      structured: goodCall,
      thresholds: { slowTokensPerSecond: 0, sluggishTokensPerSecond: 1e9 },
    })
    expect(sluggish.level).toBe('warn')
    expect(sluggish.reasons[0]).toMatch(/expect long stages/)
  })

  it('applies the size rule even when the task passed', async () => {
    const p = await probeModel({
      ...base,
      model: 'qwen2.5-coder:7b',
      agent: goodAgent,
      structured: goodCall,
    })
    expect(p.level).toBe('error')
    expect(p.reasons[0]).toMatch(/7B parameters/)
    const mid = await probeModel({
      ...base,
      model: 'qwen2.5-coder:32b',
      agent: goodAgent,
      structured: goodCall,
    })
    expect(mid.level).toBe('warn')
  })

  it('reports a probe that threw instead of throwing', async () => {
    const p = await probeModel({
      ...base,
      agent: async () => {
        throw new Error('connection refused')
      },
      structured: goodCall,
    })
    expect(p.level).toBe('error')
    expect(p.reasons[0]).toMatch(/could not be probed: connection refused/)
  })
})
