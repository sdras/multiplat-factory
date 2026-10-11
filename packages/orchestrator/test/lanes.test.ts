import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MpfConfig, RunEventBus, SqliteRunStore, type Event } from '@mpf/core'
import type { StageRunner } from '@mpf/harness'
import { Orchestrator } from '../src/runner.ts'

describe('device lanes in the orchestrator', () => {
  it('locks a device lane under the data directory while a stage uses it and logs lock events to the stage', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mpf-lanes-'))
    const lockPath = join(dataDir, 'locks', 'simulator.lock')
    mkdirSync(join(dataDir, 'locks'), { recursive: true })
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, since: new Date().toISOString(), lane: 'simulator' }),
    )

    let seen: { pid?: number; lane?: string } | undefined
    let buildLock: string | undefined = 'unset'
    const ingest: StageRunner = {
      async run(ctx) {
        await ctx.lanes.run('simulator', async () => {
          seen = JSON.parse(readFileSync(lockPath, 'utf8'))
        })
        buildLock = ctx.lanes.lockPath('gradle')
        return { status: 'succeeded' }
      },
    }
    const store = new SqliteRunStore(':memory:')
    const bus = new RunEventBus(store)
    const events: Event[] = []
    bus.subscribeAll((e) => events.push(e))
    const orch = new Orchestrator({
      store,
      bus,
      config: MpfConfig.parse({}),
      registry: { ingest },
      dataDir,
    })
    const run = orch.createRun({
      source: { locator: '.' },
      targets: ['web'],
      options: {
        coreMode: 'never',
        checkpoints: { planApproval: false, beforeFixLoop: false },
      },
    })
    await orch.start(run.id)

    expect(store.getStage(run.id, 'ingest')?.status).toBe('succeeded')
    expect(seen).toMatchObject({ pid: process.pid, lane: 'simulator' })
    expect(buildLock).toBeUndefined()
    expect(existsSync(lockPath)).toBe(false)
    const logs = events.filter(
      (e): e is Extract<Event, { type: 'log' }> => e.type === 'log' && e.stageId === 'ingest',
    )
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: expect.stringMatching(/^taking over the simulator lock held by pid 999999 /),
      }),
    )
  })
})
