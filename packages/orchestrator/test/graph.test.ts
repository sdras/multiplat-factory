import { describe, expect, it } from 'vitest'
import { RunOptions, type Run } from '@mpf/core'
import { buildStageGraph } from '../src/graph.ts'

function run(targets: Run['targets'], coreMode: 'auto' | 'always' | 'never' = 'auto'): Run {
  const ts = new Date().toISOString()
  return {
    id: 'r',
    createdAt: ts,
    updatedAt: ts,
    status: 'queued',
    source: { locator: './x' },
    targets,
    options: RunOptions.parse({ coreMode }),
    runDir: '/tmp/r',
    costUsd: 0,
  }
}

describe('buildStageGraph', () => {
  it('builds the linear analysis chain, per-target chains, and a report that waits for the end of every target loop', () => {
    const stages = buildStageGraph(run(['ios', 'android'], 'never'))
    const ids = stages.map((s) => s.id)
    expect(ids).toEqual([
      'ingest',
      'inventory',
      'spec',
      'behaviors',
      'observe',
      'plan',
      'generate:ios',
      'build:ios',
      'test:ios',
      'critique:ios',
      'fix:ios',
      'generate:android',
      'build:android',
      'test:android',
      'critique:android',
      'fix:android',
      'report',
    ])
    const byId = new Map(stages.map((s) => [s.id, s]))
    expect(byId.get('generate:ios')?.dependsOn).toEqual(['plan'])
    expect(byId.get('report')?.dependsOn).toEqual(['fix:ios', 'fix:android'])
    expect(byId.get('fix:ios')?.maxAttempts).toBe(5)
    expect(new Set(stages.map((s) => s.ord)).size).toBe(stages.length)
  })

  it('adds the core chain and makes generation depend on core.build unless coreMode is never', () => {
    const auto = buildStageGraph(run(['web'], 'auto'))
    expect(auto.map((s) => s.id)).toContain('core.build')
    expect(auto.find((s) => s.id === 'generate:web')?.dependsOn).toEqual(['plan', 'core.build'])
    const never = buildStageGraph(run(['web'], 'never'))
    expect(never.map((s) => s.id)).not.toContain('core.extract')
  })
})
