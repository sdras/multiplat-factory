import { describe, expect, it } from 'vitest'
import {
  AppSpec,
  BehaviorSpec,
  CreateRunInput,
  Event,
  Run,
  RunOptions,
  Step,
  Verdict,
  toJsonSchema,
} from '../src/schemas/index.ts'

describe('schemas', () => {
  it('fills run option defaults', () => {
    const o = RunOptions.parse({})
    expect(o.budgetUsd).toBe(30)
    expect(o.models.generate).toBe('claude-opus-5')
    expect(o.effort.generate).toBe('xhigh')
    expect(o.checkpoints.planApproval).toBe(true)
  })

  it('rejects an empty target list', () => {
    expect(() => CreateRunInput.parse({ source: { locator: './x' }, targets: [] })).toThrow()
  })

  it('round-trips a run', () => {
    const run = Run.parse({
      id: 'r1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'queued',
      source: { locator: './app' },
      targets: ['ios', 'android'],
      options: RunOptions.parse({}),
      runDir: '/tmp/r1',
    })
    expect(Run.parse(JSON.parse(JSON.stringify(run)))).toEqual(run)
  })

  it('discriminates event payloads', () => {
    const e = Event.parse({
      seq: 0,
      runId: 'r1',
      ts: new Date().toISOString(),
      type: 'log',
      level: 'info',
      message: 'hi',
    })
    expect(e.type).toBe('log')
    expect(() => Event.parse({ seq: 0, runId: 'r1', ts: 'x', type: 'nope' as never })).toThrow()
  })

  it('exports JSON Schema for LLM-facing schemas', () => {
    for (const s of [AppSpec, Verdict]) {
      const js = toJsonSchema(s)
      expect(js).toHaveProperty('type', 'object')
      expect(js).toHaveProperty('properties')
    }
  })

  it('accepts a text qualifier on tap steps and describes it in the JSON Schema', () => {
    expect(Step.parse({ op: 'tap', element: 'note-row', text: 'First' })).toEqual({
      op: 'tap',
      element: 'note-row',
      text: 'First',
    })
    expect(Step.parse({ op: 'tap', element: 'note-row' })).not.toHaveProperty('text')
    expect(() => Step.parse({ op: 'tap', element: 'note-row', text: 3 })).toThrow()
    expect(JSON.stringify(toJsonSchema(BehaviorSpec))).toContain('whose visible text contains')
  })
})
