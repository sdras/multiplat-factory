import { describe, expect, it } from 'vitest'
import { SqliteRunStore } from '../src/store/sqlite.ts'

describe('event listing on a long run', () => {
  it('pages by default and lists everything through listAllEvents', () => {
    const store = new SqliteRunStore(':memory:')
    const runId = '01TESTRUN00000000000000000'
    store.createRun({
      id: runId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'queued',
      source: { locator: './x' },
      targets: ['web'],
      options: {} as never,
      runDir: '/tmp/x',
      costUsd: 0,
    } as never)
    for (let i = 0; i < 5_200; i++) {
      store.appendEvent({
        runId,
        seq: i + 1,
        ts: new Date().toISOString(),
        type: 'log',
        level: 'info',
        message: `line ${i}`,
      } as never)
    }
    expect(store.listEvents(runId).length).toBe(5_000)
    const all = store.listAllEvents(runId)
    expect(all.length).toBe(5_200)
    const last = all[all.length - 1]!.seq
    expect(store.listAllEvents(runId, last - 100).length).toBe(100)
    store.close()
  })
})
