import { describe, expect, it } from 'vitest'
import { RunOptions, type Run, type Stage } from '@mpf/core'
import { buildStageGraph } from '../src/graph.ts'
import {
  InvalidTransition,
  UNREACHABLE,
  deriveRunStatus,
  readyStages,
  transition,
  unreachableStages,
} from '../src/machine.ts'

const at = new Date().toISOString()

function mkRun(): Run {
  return {
    id: 'r',
    createdAt: at,
    updatedAt: at,
    status: 'queued',
    source: { locator: './x' },
    targets: ['ios', 'android'],
    options: RunOptions.parse({ coreMode: 'never' }),
    runDir: '/tmp/r',
    costUsd: 0,
  }
}

function set(stages: Stage[], id: string, status: Stage['status']): Stage[] {
  return stages.map((s) => (s.id === id ? { ...s, status } : s))
}

describe('transition', () => {
  const base = buildStageGraph(mkRun())[0]!

  it('start increments attempt; fail requeues until attempts are exhausted, then blocks', () => {
    let s = transition(base, { type: 'start', at })
    expect(s.status).toBe('running')
    expect(s.attempt).toBe(1)
    s = transition(s, {
      type: 'fail',
      at,
      error: { class: 'build-error', message: 'x', diagnostics: [] },
    })
    expect(s.status).toBe('failed')
    s = transition(s, { type: 'requeue', at })
    s = transition(s, { type: 'start', at })
    s = transition(s, {
      type: 'fail',
      at,
      error: { class: 'build-error', message: 'x', diagnostics: [] },
    })
    s = transition(transition(s, { type: 'requeue', at }), { type: 'start', at })
    s = transition(s, {
      type: 'fail',
      at,
      error: { class: 'build-error', message: 'x', diagnostics: [] },
    })
    expect(s.attempt).toBe(3)
    expect(s.status).toBe('blocked')
  })

  it('rejects illegal moves', () => {
    expect(() => transition(base, { type: 'succeed', at })).toThrow(InvalidTransition)
    expect(() => transition({ ...base, status: 'succeeded' }, { type: 'start', at })).toThrow(
      InvalidTransition,
    )
  })

  it('accumulates cost on succeed', () => {
    const s = transition(transition(base, { type: 'start', at }), {
      type: 'succeed',
      at,
      costUsd: 0.5,
    })
    expect(s.costUsd).toBe(0.5)
  })
})

describe('readyStages / deriveRunStatus', () => {
  it('only the root is ready at first; skipped deps count as satisfied', () => {
    let stages = buildStageGraph(mkRun())
    expect(readyStages(stages).map((s) => s.id)).toEqual(['ingest'])
    stages = set(stages, 'ingest', 'skipped')
    expect(readyStages(stages).map((s) => s.id)).toEqual(['inventory'])
  })

  it('derives partial when one target is blocked and the rest finish', () => {
    let stages: Stage[] = buildStageGraph(mkRun()).map((s) => ({ ...s, status: 'succeeded' }))
    stages = set(stages, 'build:ios', 'blocked')
    stages = set(stages, 'test:ios', 'skipped')
    stages = set(stages, 'critique:ios', 'skipped')
    stages = set(stages, 'fix:ios', 'skipped')
    expect(deriveRunStatus(mkRun(), stages)).toBe('partial')
    expect(deriveRunStatus(mkRun(), set(stages, 'build:android', 'blocked'))).toBe('failed')
  })

  it('derives partial when a requested target was skipped for lack of a toolchain', () => {
    let stages: Stage[] = buildStageGraph(mkRun()).map((s) => ({ ...s, status: 'succeeded' }))
    for (const k of ['generate', 'build', 'test', 'critique', 'fix'])
      stages = set(stages, `${k}:ios`, 'skipped')
    expect(deriveRunStatus(mkRun(), stages)).toBe('partial')
    for (const k of ['generate', 'build', 'test', 'critique', 'fix'])
      stages = set(stages, `${k}:android`, 'skipped')
    expect(deriveRunStatus(mkRun(), stages)).toBe('failed')
  })

  it('lets the report run once every dependency has ended, even unreachable ones', () => {
    let stages: Stage[] = buildStageGraph(mkRun()).map((s) => ({ ...s, status: 'succeeded' }))
    stages = set(stages, 'build:ios', 'blocked')
    for (const k of ['test', 'critique', 'fix'])
      stages = stages.map((s) =>
        s.id === `${k}:ios`
          ? { ...s, status: 'skipped', skipReason: `${UNREACHABLE} build:ios did not complete` }
          : s,
      )
    stages = set(stages, 'report', 'pending')
    expect(readyStages(stages).map((s) => s.id)).toEqual(['report'])
    expect(unreachableStages(stages)).toEqual([])
    // but not while a sibling target is still working
    stages = set(stages, 'fix:android', 'running')
    expect(readyStages(stages)).toEqual([])
  })

  it('derives failed when an untargeted stage is blocked', () => {
    let stages: Stage[] = buildStageGraph(mkRun()).map((s) => ({ ...s, status: 'skipped' }))
    stages = set(stages, 'plan', 'blocked')
    expect(deriveRunStatus(mkRun(), stages)).toBe('failed')
  })

  it('waiting_human wins over running; explicit cancel wins over everything', () => {
    let stages = buildStageGraph(mkRun())
    stages = set(stages, 'ingest', 'waiting_human')
    expect(deriveRunStatus(mkRun(), stages)).toBe('waiting_human')
    expect(deriveRunStatus({ ...mkRun(), status: 'cancelled' }, stages)).toBe('cancelled')
  })
})
