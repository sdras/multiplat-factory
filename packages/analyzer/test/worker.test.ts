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
  workerFailure,
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

describe('runWorker read-only stages', () => {
  it('denies the write tools for analysis and critique workers and leaves generation alone', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'mpf-worker-ro-'))
    const seen: Array<{ kind: string; tools?: string[]; deny?: string[] }> = []
    const agent: AgentFn = async (o) => {
      seen.push({ kind: seen.length.toString(), tools: o.tools, deny: o.policy?.denyTools })
      return result(0.1, 'sess-ro')
    }
    const base = {
      role: 'generate' as const,
      budgetShare: 0.1,
      cwd: runDir,
      systemPrompt: 's',
      prompt: 'p',
    }
    for (const kind of ['spec', 'behaviors', 'plan', 'critique', 'generate', 'fix'] as const) {
      const ctx = contextFor(runDir)
      ctx.stage.kind = kind
      await runWorker(ctx, base, agent)
    }
    const [spec, behaviors, plan, critique, generate, fix] = seen
    for (const ro of [spec, behaviors, plan, critique]) {
      expect(ro?.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
      expect(ro?.deny).toEqual(expect.arrayContaining(['Write', 'Edit', 'MultiEdit', 'WebFetch']))
    }
    expect(generate?.tools).toBeUndefined()
    expect(generate?.deny).toBeUndefined()
    expect(fix?.tools).toBeUndefined()

    const ctx = contextFor(runDir)
    ctx.stage.kind = 'spec'
    await runWorker(ctx, { ...base, readOnly: false }, agent)
    expect(seen.at(-1)?.tools).toBeUndefined()
  })
})

describe('runWorker model check', () => {
  const base = {
    role: 'generate' as const,
    budgetShare: 0.1,
    systemPrompt: 's',
    prompt: 'p',
  }
  function localContext(runDir: string, model: string, probeSetting = true): StageContext {
    const ctx = contextFor(runDir)
    ctx.run.options.llm = { ...ctx.run.options.llm, provider: 'ollama', probe: probeSetting }
    ctx.run.options.models = { generate: model, critic: model, cheap: model }
    return ctx
  }
  const probeResult = (level: 'ok' | 'error', reasons: string[] = []) => ({
    model: 'x',
    role: 'generate' as const,
    level,
    reasons,
    toolUse: level === 'ok',
    structured: level === 'ok',
    turns: 3,
    durationMs: 10,
    costUsd: 0.05,
    probedAt: 'now',
  })

  it('refuses an unsuitable model before the worker runs, as a non-retryable failure', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'mpf-worker-probe-'))
    let agentCalls = 0
    const agent: AgentFn = async () => {
      agentCalls++
      return result(0.1, 'sess')
    }
    const charged: number[] = []
    const ctx = localContext(runDir, 'local-coder')
    ctx.chargeCost = (usd) => {
      charged.push(usd)
    }
    const r = await runWorker(ctx, { ...base, cwd: runDir }, agent, async () =>
      probeResult('error', ['too weak for the task']),
    )
    expect(r.ok).toBe(false)
    expect(r.error).toBe('model unsuitable: too weak for the task')
    expect(agentCalls).toBe(0)
    expect(charged).toEqual([0.05])
    const failure = workerFailure(r, 'fallback')
    expect(failure.error.class).toBe('model-unsuitable')
    expect(failure.retryable).toBe(false)
  })

  it('probes a model once per run and then lets workers through', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'mpf-worker-probe-'))
    let agentCalls = 0
    let probeCalls = 0
    const agent: AgentFn = async () => {
      agentCalls++
      return result(0.1, 'sess')
    }
    const probe = async () => {
      probeCalls++
      return probeResult('ok')
    }
    const ctx = localContext(runDir, 'local-coder')
    await runWorker(ctx, { ...base, cwd: runDir }, agent, probe)
    await runWorker(ctx, { ...base, cwd: runDir }, agent, probe)
    expect(agentCalls).toBe(2)
    expect(probeCalls).toBe(1)
    expect(readFileSync(join(runDir, 'model-probe.json'), 'utf8')).toContain('"local-coder"')
  })

  it('skips the probe for frontier tiers and when llm.probe is false', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'mpf-worker-probe-'))
    let probeCalls = 0
    const probe = async () => {
      probeCalls++
      return probeResult('ok')
    }
    const agent: AgentFn = async () => result(0.1, 'sess')
    await runWorker(localContext(runDir, 'gpt-5.1'), { ...base, cwd: runDir }, agent, probe)
    const small = await runWorker(
      localContext(runDir, 'qwen2.5-coder:7b', false),
      { ...base, cwd: runDir },
      agent,
      probe,
    )
    expect(probeCalls).toBe(0)
    expect(small.ok).toBe(true)
    const refused = await runWorker(
      localContext(runDir, 'qwen2.5-coder:7b'),
      { ...base, cwd: runDir },
      agent,
      async () => probeResult('error', ['7B is too small']),
    )
    expect(refused.error).toMatch(/^model unsuitable: 7B is too small/)
  })
})
