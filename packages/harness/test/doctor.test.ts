import { describe, expect, it } from 'vitest'
import { deriveLlm, deriveTargets, runDoctor } from '../src/toolchain/doctor.ts'
import { Lanes } from '../src/lanes.ts'
import { runProcess } from '../src/exec.ts'
import { MpfConfig } from '@mpf/core'

describe('deriveTargets / deriveLlm', () => {
  const base = (id: string, status: 'ok' | 'warn' | 'missing', version?: string) => ({
    id,
    label: id,
    status,
    detail: '',
    affects: [],
    version,
  })

  it('enables web only with node + package manager', () => {
    expect(deriveTargets([base('node', 'ok'), base('pm', 'ok')])).toEqual(['web'])
    expect(deriveTargets([base('node', 'missing'), base('pm', 'ok')])).toEqual([])
  })

  it('enables ios when xcode is ok or warn, android when java ok and sdk present', () => {
    const checks = [
      base('node', 'ok'),
      base('pm', 'ok'),
      base('xcode', 'warn'),
      base('java', 'ok'),
      base('android', 'warn'),
    ]
    expect(deriveTargets(checks)).toEqual(['web', 'ios', 'android'])
    expect(deriveTargets([...checks.slice(0, 2), base('xcode', 'missing')])).toEqual(['web'])
  })

  it('picks the llm backend from the model-access check', () => {
    expect(deriveLlm([base('llm', 'ok', 'messages')])).toBe('messages')
    expect(deriveLlm([base('llm', 'ok', 'agent-sdk')])).toBe('agent-sdk')
    expect(deriveLlm([base('llm', 'ok', 'openai-compatible')])).toBe('openai-compatible')
    expect(deriveLlm([base('llm', 'warn', 'openai-compatible')])).toBe('openai-compatible')
    expect(deriveLlm([base('llm', 'missing', 'openai-compatible')])).toBe('none')
    expect(deriveLlm([base('llm', 'missing', 'none')])).toBe('none')
    expect(deriveLlm([])).toBe('none')
  })
})

describe('runDoctor', () => {
  it('runs a custom check set and never throws when a check crashes', async () => {
    const report = await runDoctor(MpfConfig.parse({}), {}, [
      async () => ({ id: 'node', label: 'Node', status: 'ok', detail: 'x', affects: [] }),
      async () => {
        throw new Error('boom')
      },
    ])
    expect(report.checks).toHaveLength(2)
    expect(report.checks[1]?.status).toBe('warn')
    expect(report.host.node).toBe(process.versions.node)
  })

  it('hands every check the config llm settings and model overrides, with fetch left to the default', async () => {
    const config = MpfConfig.parse({
      llm: { provider: 'openai', headers: { 'X-Test': 'yes' } },
      models: { cheap: 'gpt-5-nano' },
    })
    const report = await runDoctor(config, {}, [
      async (ctx) => ({
        id: 'stub',
        label: 'stub',
        status: 'ok',
        detail: JSON.stringify({
          llm: ctx.llm,
          models: ctx.models,
          fetch: ctx.fetch === undefined,
        }),
        affects: [],
      }),
    ])
    const seen = JSON.parse(report.checks[0]!.detail) as {
      llm: MpfConfig['llm']
      models: MpfConfig['models']
      fetch: boolean
    }
    expect(seen.llm).toEqual(config.llm)
    expect(seen.llm.provider).toBe('openai')
    expect(seen.llm.headers).toEqual({ 'X-Test': 'yes' })
    expect(seen.models).toEqual({ cheap: 'gpt-5-nano' })
    expect(seen.fetch).toBe(true)
  })
})

describe('runProcess + Lanes', () => {
  it('captures output and exit code without throwing', async () => {
    const r = await runProcess({
      command: 'node',
      args: ['-e', 'console.log("hi"); process.exit(3)'],
    })
    expect(r.exitCode).toBe(3)
    expect(r.stdout.trim()).toBe('hi')
  })

  it('serializes a lane with concurrency 1', async () => {
    const lanes = new Lanes({ x: 1 })
    const order: string[] = []
    await Promise.all([
      lanes.run('x', async () => {
        order.push('a-start')
        await new Promise((r) => setTimeout(r, 30))
        order.push('a-end')
      }),
      lanes.run('x', async () => {
        order.push('b-start')
        order.push('b-end')
      }),
    ])
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })
})
