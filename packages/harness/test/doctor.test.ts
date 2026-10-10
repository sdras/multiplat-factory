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

  it('picks the llm backend from the credential check', () => {
    expect(deriveLlm([base('llm', 'ok', 'messages')])).toBe('messages')
    expect(deriveLlm([base('llm', 'ok', 'agent-sdk')])).toBe('agent-sdk')
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
