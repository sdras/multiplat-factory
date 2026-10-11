import { describe, expect, it } from 'vitest'
import { applyEvents, emptyView, PARTIAL_FLOWS_LOG } from '../src/reducer.ts'
import { Stage, TestResult, type Event, type EventPayload } from '../src/schemas/index.ts'

const ts = new Date().toISOString()

function events(list: [payload: EventPayload, stageId?: string][]): Event[] {
  return list.map(([payload, stageId], seq) => ({ runId: 'r1', ts, seq, stageId, ...payload }))
}

const testStage = (target: 'ios' | 'android') =>
  Stage.parse({ id: `test:${target}`, runId: 'r1', kind: 'test', target, status: 'running' })

const e2e = (target: 'ios' | 'android', passed: number, total: number) =>
  TestResult.parse({
    stageId: `test:${target}`,
    target,
    kind: 'e2e',
    status: passed === total ? 'pass' : 'fail',
    summary: { total, passed, failed: total - passed, skipped: 0 },
  })

const partialLog = (ids: string[]): Extract<EventPayload, { type: 'log' }> => ({
  type: 'log',
  level: 'warn',
  message: `${ids.length} failing flow(s) contain a step the compiler could not express and do not block the target: ${ids.join(', ')}`,
})

describe('reducer: partial flows', () => {
  it('starts empty', () => {
    expect(emptyView().partialFlows).toEqual({})
  })

  it('matches the test stage warning and captures the behavior ids', () => {
    const m = PARTIAL_FLOWS_LOG.exec(partialLog(['B-005', 'B-007']).message)
    expect(m?.[1]).toBe('B-005, B-007')
    expect(PARTIAL_FLOWS_LOG.test('tests: e2e fail 12/13; blocking failures: B-003')).toBe(false)
  })

  it('keys the ids by the stage target and clears them on the next e2e result', () => {
    const view = applyEvents(
      emptyView(),
      events([
        [{ type: 'stage.status', stage: testStage('ios') }, 'test:ios'],
        [{ type: 'test.result', result: e2e('ios', 12, 13) }, 'test:ios'],
        [partialLog(['B-005']), 'test:ios'],
      ]),
    )
    expect(view.partialFlows).toEqual({ ios: ['B-005'] })
    // The log line still reaches the transcript like any other.
    expect(view.transcripts['test:ios']?.at(-1)?.kind).toBe('log')

    // A retest after a fix round emits a fresh e2e result before any new warning.
    const retested = applyEvents(
      view,
      events([[{ type: 'test.result', result: e2e('ios', 13, 13) }, 'test:ios']]).map((e) => ({
        ...e,
        seq: e.seq + 10,
      })),
    )
    expect(retested.partialFlows).toEqual({})

    const again = applyEvents(
      retested,
      events([[partialLog(['B-005', 'B-007']), 'test:ios']]).map((e) => ({
        ...e,
        seq: e.seq + 20,
      })),
    )
    expect(again.partialFlows).toEqual({ ios: ['B-005', 'B-007'] })
  })

  it('falls back to the target in the stage id and leaves other targets alone', () => {
    const view = applyEvents(
      emptyView(),
      events([
        [partialLog(['B-002']), 'test:android'],
        [{ type: 'stage.status', stage: testStage('ios') }, 'test:ios'],
        [partialLog(['B-005']), 'test:ios'],
        [{ type: 'test.result', result: e2e('android', 9, 9) }, 'test:android'],
      ]),
    )
    expect(view.partialFlows).toEqual({ ios: ['B-005'] })
  })

  it('ignores the warning without a stage and other log lines', () => {
    const view = applyEvents(
      emptyView(),
      events([
        [partialLog(['B-001'])],
        [
          { type: 'log', level: 'info', message: 'before launching: dismissed an ANR dialog' },
          'test:android',
        ],
      ]),
    )
    expect(view.partialFlows).toEqual({})
    expect(view.transcripts['_run']).toHaveLength(1)
    expect(view.transcripts['test:android']).toHaveLength(1)
  })
})
