import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MpfConfig,
  RunEventBus,
  SqliteRunStore,
  applyEvents,
  emptyView,
  type Event,
} from '@mpf/core'
import { Orchestrator } from '../src/runner.ts'
import { fakeRegistry } from '../src/stages/fake.ts'

function make() {
  const store = new SqliteRunStore(':memory:')
  const bus = new RunEventBus(store)
  const events: Event[] = []
  bus.subscribeAll((e) => events.push(e))
  const orch = new Orchestrator({
    store,
    bus,
    config: MpfConfig.parse({}),
    registry: fakeRegistry(0.02),
    dataDir: mkdtempSync(join(tmpdir(), 'mpf-test-')),
  })
  return { store, bus, events, orch }
}

describe('Orchestrator with the fake pipeline', () => {
  it('runs a two-target port to completion and emits the expected events', async () => {
    const { store, events, orch } = make()
    const run = orch.createRun({
      source: { locator: './fixture' },
      targets: ['ios', 'android'],
      options: { checkpoints: { planApproval: false }, coreMode: 'never' },
    })
    await orch.start(run.id)
    const final = store.getRun(run.id)!
    expect(final.status).toBe('succeeded')
    const stages = store.listStages(run.id)
    expect(stages.every((s) => s.status === 'succeeded' || s.status === 'skipped')).toBe(true)
    expect(stages.find((s) => s.id === 'fix:ios')?.status).toBe('skipped')
    expect(final.costUsd).toBeGreaterThan(0)

    const types = new Set(events.map((e) => e.type))
    for (const t of [
      'run.status',
      'stage.status',
      'agent.message',
      'proc.started',
      'test.result',
      'critic.verdict',
      'artifact.added',
      'cost.update',
    ]) {
      expect(types.has(t as Event['type'])).toBe(true)
    }
    const view = applyEvents(emptyView(), store.listEvents(run.id))
    expect(view.run?.status).toBe('succeeded')
    expect(view.tests).toHaveLength(2)
    expect(view.verdicts).toHaveLength(2)
    expect(view.artifacts.map((a) => a.kind)).toEqual(['port-readme'])
  })

  it('skips the core chain in auto mode when the analyzer finds too little logic', async () => {
    const { store, orch } = make()
    const run = orch.createRun({
      source: { locator: './fixture' },
      targets: ['web'],
      options: { checkpoints: { planApproval: false }, coreMode: 'auto' },
    })
    await orch.start(run.id)
    const byId = new Map(store.listStages(run.id).map((s) => [s.id, s]))
    expect(byId.get('core.extract')?.status).toBe('skipped')
    expect(byId.get('core.build')?.status).toBe('skipped')
    expect(byId.get('generate:web')?.status).toBe('succeeded')
    expect(store.getRun(run.id)?.status).toBe('succeeded')
  })

  it('pauses at the plan checkpoint, then continues after approval', async () => {
    const { store, orch } = make()
    const run = orch.createRun({
      source: { locator: './fixture' },
      targets: ['web'],
      options: { coreMode: 'never' },
    })
    await orch.start(run.id)
    expect(store.getRun(run.id)?.status).toBe('waiting_human')
    expect(store.getStage(run.id, 'plan')?.status).toBe('waiting_human')
    await orch.answer(run.id, 'plan', 'approve', 'keep the tab bar')
    expect(store.getRun(run.id)?.status).toBe('succeeded')
  })

  it('cancels a run in flight', async () => {
    const { store, orch } = make()
    const run = orch.createRun({
      source: { locator: './fixture' },
      targets: ['web'],
      options: { checkpoints: { planApproval: false }, coreMode: 'never' },
    })
    const done = orch.start(run.id)
    await new Promise((r) => setTimeout(r, 15))
    orch.cancel(run.id)
    await done
    expect(store.getRun(run.id)?.status).toBe('cancelled')
    expect(store.listStages(run.id).some((s) => s.status === 'running')).toBe(false)
  })

  it('pauses and resumes without consuming attempts', async () => {
    const { store, orch } = make()
    const run = orch.createRun({
      source: { locator: './fixture' },
      targets: ['web'],
      options: { checkpoints: { planApproval: false }, coreMode: 'never' },
    })
    const first = orch.start(run.id)
    await new Promise((r) => setTimeout(r, 15))
    orch.pause(run.id)
    await first
    expect(store.getRun(run.id)?.status).toBe('paused')
    const paused = store.listStages(run.id).filter((s) => s.status === 'paused')
    expect(paused.length).toBeGreaterThan(0)
    await orch.resume(run.id)
    expect(store.getRun(run.id)?.status).toBe('succeeded')
    expect(store.listStages(run.id).every((s) => s.attempt <= 2)).toBe(true)
  })
})
