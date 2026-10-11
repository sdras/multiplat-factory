import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { MpfConfig, RunEventBus, SqliteRunStore } from '@mpf/core'
import { laneLockPath } from '@mpf/harness'
import { fakeRegistry } from '../src/stages/fake.ts'
import { Orchestrator } from '../src/runner.ts'

describe('run driver lock', () => {
  it('lets a second start in the same process join the loop, and releases the lock when the run settles', async () => {
    const store = new SqliteRunStore(':memory:')
    const dataDir = mkdtempSync(join(tmpdir(), 'mpf-driver-'))
    const orch = new Orchestrator({
      store,
      bus: new RunEventBus(store),
      config: MpfConfig.parse({}),
      registry: fakeRegistry(0.01),
      dataDir,
    })
    const run = orch.createRun({
      source: { locator: './x' },
      targets: ['web'],
      options: {
        fake: true,
        coreMode: 'never',
        checkpoints: { planApproval: false, beforeFixLoop: false },
      },
    })
    const first = orch.start(run.id)
    const second = orch.start(run.id)
    await Promise.all([first, second])
    expect(store.getRun(run.id)?.status).toBe('succeeded')
    const lock = laneLockPath(join(dataDir, 'locks'), `run-${run.id}`)
    expect(existsSync(lock)).toBe(false)
    store.close()
  }, 30_000)
})
