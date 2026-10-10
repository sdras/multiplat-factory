import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { summarizeWebTests, type SourceAdapter } from '@mpf/adapters'
import {
  MpfConfig,
  RunEventBus,
  RunOptions,
  SqliteRunStore,
  type EventPayload,
  type Run,
  type Stage,
} from '@mpf/core'
import type { StageContext } from '@mpf/harness'
import { runSourceTests } from '../src/stages/observe.ts'

type TestResultEvent = Extract<EventPayload, { type: 'test.result' }>

/** The StageContext from worker.test.ts, with emitted events and log lines captured. */
function contextFor(runDir: string) {
  const events: EventPayload[] = []
  const logs: string[] = []
  const run: Run = {
    id: 'r1',
    createdAt: 'x',
    updatedAt: 'x',
    status: 'running',
    source: { locator: '.' },
    targets: ['android'],
    options: RunOptions.parse({ budgetUsd: 30 }),
    runDir,
    costUsd: 0,
  }
  const stage: Stage = {
    id: 'observe',
    runId: 'r1',
    ord: 0,
    kind: 'observe',
    status: 'running',
    attempt: 1,
    maxAttempts: 1,
    dependsOn: [],
    inputs: [],
    outputs: [],
    costUsd: 0,
  }
  const store = new SqliteRunStore(':memory:')
  const ctx: StageContext = {
    run,
    stage,
    store,
    bus: new RunEventBus(store),
    config: MpfConfig.parse({}),
    lanes: { run: async (_lane: string, fn: () => Promise<unknown>) => fn() } as never,
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    log: (_level, message) => logs.push(message),
    takeInstructions: () => [],
    addArtifact: () => ({}) as never,
    readJsonArtifact: () => undefined,
    updateRun: () => run,
    chargeCost: () => {},
  }
  return { ctx, events, logs }
}

function fakeAdapter(existingTests: SourceAdapter['existingTests']): SourceAdapter {
  return { id: 'fake-web', platform: 'web', detect: async () => undefined, existingTests }
}

/** A test "suite" that is really one Node script, summarized like a web source's runner. */
function nodeCommand(script: string) {
  return {
    command: process.execPath,
    args: ['-e', script],
    summarize: (r: { stdout: string; stderr: string; exitCode: number }) =>
      summarizeWebTests(r.stdout + r.stderr, r.exitCode),
  }
}

async function runWith(adapter: SourceAdapter) {
  const sourceDir = mkdtempSync(join(tmpdir(), 'mpf-source-tests-'))
  const { ctx, events, logs } = contextFor(sourceDir)
  await runSourceTests(ctx, adapter, sourceDir, join(sourceDir, 'observe'))
  const results = events.filter((e): e is TestResultEvent => e.type === 'test.result')
  return { results, logs }
}

describe('runSourceTests', () => {
  it('records a passing suite as a unit result for the source', async () => {
    const { results, logs } = await runWith(
      fakeAdapter(async () => nodeCommand('console.log("Tests  2 passed (2)")')),
    )
    expect(results).toHaveLength(1)
    expect(results[0]!.result).toMatchObject({
      target: 'source',
      kind: 'unit',
      status: 'pass',
      summary: { total: 2, passed: 2 },
    })
    expect(logs.some((m) => m.includes('source tests: pass 2/2'))).toBe(true)
  })

  it('emits nothing when the source has no test suite', async () => {
    const { results, logs } = await runWith(fakeAdapter(async () => undefined))
    expect(results).toHaveLength(0)
    expect(logs).toContain('the source has no test suite the factory can run here')
  })

  it('reports a non-zero exit without a parsable summary as a failure', async () => {
    const { results } = await runWith(fakeAdapter(async () => nodeCommand('process.exit(1)')))
    expect(results).toHaveLength(1)
    expect(results[0]!.result).toMatchObject({ target: 'source', status: 'fail' })
    expect(results[0]!.result.summary.failed).toBe(1)
  })
})
