import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MpfConfig, RunEventBus, RunOptions, SqliteRunStore, type Run, type Stage } from '@mpf/core'
import type { StageContext } from '@mpf/harness'
import type { AgentRunResult } from '@mpf/llm'
import {
  READ_ONLY_BASH,
  WRITE_BASH,
  readSessionLedger,
  runWorker,
  type AgentFn,
} from '../src/worker.ts'

function contextFor(runDir: string): StageContext {
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
    id: 'generate:android',
    runId: 'r1',
    ord: 0,
    kind: 'generate',
    target: 'android',
    status: 'running',
    attempt: 1,
    maxAttempts: 1,
    dependsOn: [],
    inputs: [],
    outputs: [],
    costUsd: 0,
  }
  const store = new SqliteRunStore(':memory:')
  return {
    run,
    stage,
    store,
    bus: new RunEventBus(store),
    config: MpfConfig.parse({}),
    lanes: { run: async (_lane: string, fn: () => Promise<unknown>) => fn() } as never,
    signal: new AbortController().signal,
    emit: () => {},
    log: () => {},
    takeInstructions: () => [],
    addArtifact: () => ({}) as never,
    readJsonArtifact: () => undefined,
    updateRun: () => run,
    chargeCost: () => {},
  }
}

const result = (costUsd: number, sessionId: string): AgentRunResult => ({
  ok: true,
  text: '',
  costUsd,
  numTurns: 1,
  sessionId,
  denials: 0,
})

describe('runWorker cost accounting', () => {
  it('charges a fresh session in full and a resumed session only for the increment', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'mpf-worker-'))
    const ctx = contextFor(runDir)
    const calls: number[] = []
    const agent: AgentFn = async (o) => {
      // The SDK reports the whole session's spend on resume: 5.40 first, then 5.40 + 3.17.
      calls.push(o.maxBudgetUsd ?? 0)
      return o.resume ? result(8.57, 'sess-1') : result(5.4, 'sess-1')
    }
    const base = {
      role: 'generate' as const,
      budgetShare: 0.35,
      cwd: runDir,
      systemPrompt: 's',
      prompt: 'p',
    }
    const first = await runWorker(ctx, base, agent)
    expect(first.costUsd).toBeCloseTo(5.4)
    expect(first.sessionCostUsd).toBeCloseTo(5.4)
    expect(readSessionLedger(runDir)).toEqual({ 'sess-1': 5.4 })

    const second = await runWorker(ctx, { ...base, resume: 'sess-1' }, agent)
    expect(second.costUsd).toBeCloseTo(3.17)
    expect(second.sessionCostUsd).toBeCloseTo(8.57)
    expect(JSON.parse(readFileSync(join(runDir, 'sessions.json'), 'utf8'))).toEqual({
      'sess-1': 8.57,
    })
    expect(calls.every((c) => c > 0)).toBe(true)
  })

  it("treats a resumed total below the known total as this call's own spend (older SDKs start at zero)", async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'mpf-worker-'))
    const ctx = contextFor(runDir)
    const agent: AgentFn = async (o) => (o.resume ? result(1.25, 'sess-2') : result(6, 'sess-2'))
    const base = {
      role: 'generate' as const,
      budgetShare: 0.35,
      cwd: runDir,
      systemPrompt: 's',
      prompt: 'p',
    }
    await runWorker(ctx, base, agent)
    const again = await runWorker(ctx, { ...base, resume: 'sess-2' }, agent)
    expect(again.costUsd).toBeCloseTo(1.25)
  })
})

describe('READ_ONLY_BASH', () => {
  const allowed = (cmd: string) => READ_ONLY_BASH.some((re) => re.test(cmd))
  it('lets workers read logs with the usual text tools but not edit with sed', () => {
    expect(allowed("sed -n '2135,2260p' maestro.log | grep -oE 'onCommand'")).toBe(true)
    expect(allowed("awk 'NR>=10' maestro.log")).toBe(true)
    expect(allowed('sort -u ids.txt | uniq -c')).toBe(true)
    expect(allowed("sed -i '' 's/a/b/' App.kt")).toBe(false)
    expect(allowed('rm -rf build')).toBe(false)
  })
})

describe('WRITE_BASH', () => {
  const allowed = (cmd: string) => WRITE_BASH.some((re) => re.test(cmd))
  it('lets a writing worker move, copy, make, and remove relative paths only', () => {
    expect(allowed('mv probe.swift main.swift')).toBe(true)
    expect(allowed('cp -R src/logic scratch/logic')).toBe(true)
    expect(allowed('mkdir -p scratch/harness')).toBe(true)
    expect(allowed('rm -rf scratch')).toBe(true)
    expect(allowed('rm -rf /')).toBe(false)
    expect(allowed('rm -rf /Users/someone')).toBe(false)
    expect(allowed('cp secret.txt /tmp/out')).toBe(false)
    expect(allowed('mv -- -weird x')).toBe(false)
  })
})

describe('WRITE_BASH', () => {
  it('admits rmdir and in-place sed on relative paths only', () => {
    const ok = (cmd: string) => WRITE_BASH.some((re) => re.test(cmd))
    expect(ok('rmdir mpf-harness/bodies')).toBe(true)
    expect(ok('rmdir /tmp/x')).toBe(false)
    expect(ok("sed -i '' 's|a|b|' src/api/mod.rs")).toBe(true)
    expect(ok('rm -rf /')).toBe(false)
  })
})
