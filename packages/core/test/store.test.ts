import { describe, expect, it } from 'vitest'
import { RunEventBus } from '../src/events/bus.ts'
import { applyEvents, emptyView } from '../src/reducer.ts'
import { RunOptions } from '../src/schemas/index.ts'
import { SqliteRunStore } from '../src/store/sqlite.ts'

function makeRun(id = 'r1') {
  const ts = new Date().toISOString()
  return {
    id,
    createdAt: ts,
    updatedAt: ts,
    status: 'queued' as const,
    source: { locator: './app' },
    targets: ['web' as const],
    options: RunOptions.parse({}),
    runDir: `/tmp/${id}`,
    costUsd: 0,
  }
}

describe('SqliteRunStore', () => {
  it('stores runs, stages, events with monotonic seq, artifacts', () => {
    const store = new SqliteRunStore(':memory:')
    const run = makeRun()
    store.createRun(run)
    expect(store.getRun('r1')?.status).toBe('queued')
    expect(store.listRuns()).toHaveLength(1)

    store.upsertStage({
      id: 'ingest',
      runId: 'r1',
      kind: 'ingest',
      status: 'pending',
      attempt: 0,
      maxAttempts: 3,
      dependsOn: [],
      ord: 0,
      inputs: [],
      outputs: [],
      costUsd: 0,
    })
    store.upsertStage({ ...store.getStage('r1', 'ingest')!, status: 'running' })
    expect(store.listStages('r1')[0]?.status).toBe('running')

    const ts = new Date().toISOString()
    const a = store.appendEvent({ runId: 'r1', ts, type: 'log', level: 'info', message: 'a' })
    const b = store.appendEvent({ runId: 'r1', ts, type: 'log', level: 'info', message: 'b' })
    expect([a.seq, b.seq]).toEqual([0, 1])
    expect(store.listEvents('r1', 0)).toHaveLength(1)

    store.addArtifact({
      id: 'art1',
      runId: 'r1',
      stageId: 'ingest',
      kind: 'log',
      relPath: 'logs/ingest.log',
      mime: 'text/plain',
      createdAt: ts,
      meta: {},
    })
    expect(store.listArtifacts('r1')).toHaveLength(1)
    store.close()
  })
})

describe('RunEventBus + reducer', () => {
  it('fans out and the reducer rebuilds the same view from the log', () => {
    const store = new SqliteRunStore(':memory:')
    const bus = new RunEventBus(store)
    const run = makeRun('r2')
    store.createRun(run)
    const seen: number[] = []
    const off = bus.subscribe('r2', (e) => seen.push(e.seq))

    bus.emit('r2', undefined, { type: 'run.status', run: { ...run, status: 'running' } })
    bus.emit('r2', 'ingest', { type: 'log', level: 'info', message: 'copying' })
    bus.emit('r2', 'ingest', {
      type: 'stage.status',
      stage: {
        id: 'ingest',
        runId: 'r2',
        kind: 'ingest',
        status: 'succeeded',
        attempt: 1,
        maxAttempts: 3,
        dependsOn: [],
        ord: 0,
        inputs: [],
        outputs: [],
        costUsd: 0,
      },
    })
    off()
    bus.emit('r2', undefined, { type: 'log', level: 'info', message: 'after unsubscribe' })

    expect(seen).toEqual([0, 1, 2])
    const view = applyEvents(emptyView(), store.listEvents('r2'))
    expect(view.run?.status).toBe('running')
    expect(view.stages.map((s) => s.status)).toEqual(['succeeded'])
    expect(view.transcripts['ingest']?.map((t) => t.text)).toEqual(['copying'])
    expect(view.lastSeq).toBe(3)
    store.close()
  })
})
