import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MpfConfig, RunEventBus, SqliteRunStore, type Event } from '@mpf/core'
import type { StageRunner, StageRunnerRegistry } from '@mpf/harness'
import { Orchestrator } from '../src/runner.ts'

function setup(registry: StageRunnerRegistry, budgetUsd = 30) {
  const store = new SqliteRunStore(':memory:')
  const bus = new RunEventBus(store)
  const events: Event[] = []
  bus.subscribeAll((e) => events.push(e))
  const orch = new Orchestrator({
    store,
    bus,
    config: MpfConfig.parse({}),
    registry,
    dataDir: mkdtempSync(join(tmpdir(), 'mpf-cost-')),
  })
  const run = orch.createRun({
    source: { locator: '.' },
    targets: ['web'],
    options: {
      coreMode: 'never',
      budgetUsd,
      checkpoints: { planApproval: false, beforeFixLoop: false },
    },
  })
  return { store, orch, run, events }
}

const costUpdates = (events: Event[]) =>
  events
    .filter((e): e is Extract<Event, { type: 'cost.update' }> => e.type === 'cost.update')
    .map((e) => [e.stageCostUsd, e.runCostUsd])

describe('artifacts', () => {
  it('registers a bundle directory without hashing it', async () => {
    const ingest: StageRunner = {
      async run(ctx) {
        const dir = join(ctx.run.runDir, 'workspace/ios/Counter.app')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'Info.plist'), 'plist')
        writeFileSync(join(dir, 'binary'), 'bin!')
        const a = ctx.addArtifact({ kind: 'ios-app', relPath: 'workspace/ios/Counter.app' })
        return {
          status: 'succeeded',
          result: { mime: a.mime, bytes: a.bytes, sha: a.sha256 ?? null },
        }
      },
    }
    const { store, orch, run } = setup({ ingest })
    await orch.start(run.id)
    expect(store.getStage(run.id, 'ingest')?.status).toBe('succeeded')
    expect(store.getStage(run.id, 'ingest')?.result).toEqual({
      mime: 'inode/directory',
      bytes: 9,
      sha: null,
    })
  })
})

describe('cost accounting', () => {
  it('charges as a stage goes and does not double count the outcome total', async () => {
    const ingest: StageRunner = {
      async run(ctx) {
        ctx.chargeCost(2)
        ctx.chargeCost(0.5)
        return { status: 'succeeded', costUsd: 2.5 }
      },
    }
    const { store, orch, run, events } = setup({ ingest })
    await orch.start(run.id)
    expect(store.getStage(run.id, 'ingest')?.costUsd).toBeCloseTo(2.5)
    expect(store.getRun(run.id)?.costUsd).toBeCloseTo(2.5)
    expect(costUpdates(events)).toEqual([
      [2, 2],
      [0.5, 2.5],
    ])
  })

  it('keeps what was charged when the stage then fails, and adds only the excess an outcome reports', async () => {
    const ingest: StageRunner = {
      async run(ctx) {
        ctx.chargeCost(1.5)
        return {
          status: 'failed',
          retryable: false,
          costUsd: 2,
          error: { class: 'llm-error', message: 'boom', diagnostics: [] },
        }
      },
    }
    const { store, orch, run } = setup({ ingest })
    await orch.start(run.id)
    expect(store.getStage(run.id, 'ingest')?.status).toBe('blocked')
    expect(store.getStage(run.id, 'ingest')?.costUsd).toBeCloseTo(2)
    expect(store.getRun(run.id)?.costUsd).toBeCloseTo(2)
  })

  it('pauses the run the moment a charge reaches the budget', async () => {
    let afterCharge: string | undefined
    const ingest: StageRunner = {
      async run(ctx) {
        ctx.chargeCost(5)
        afterCharge = ctx.signal.aborted ? 'aborted' : 'live'
        return { status: 'succeeded', costUsd: 5 }
      },
    }
    const { store, orch, run } = setup({ ingest }, 4)
    await orch.start(run.id)
    expect(afterCharge).toBe('aborted')
    expect(store.getRun(run.id)?.status).toBe('paused')
    expect(store.getRun(run.id)?.costUsd).toBeCloseTo(5)
  })
})
