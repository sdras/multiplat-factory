import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MpfConfig, RunEventBus, SqliteRunStore, type Event, type Run, type Stage } from '@mpf/core'
import type { StageContext, StageRunnerRegistry } from '@mpf/harness'
import type { BuildResult, E2eResult, TargetAdapter, TestOutcome } from '@mpf/adapters'
import type { AgentFn } from '@mpf/analyzer'
import { Orchestrator } from '../src/runner.ts'
import { buildStage, generateStage, testStage } from '../src/stages/target.ts'

const SPEC = {
  name: 'Counter',
  source: {
    platform: 'web',
    framework: 'static-html',
    language: 'javascript',
    entry: 'index.html',
  },
  screens: [
    {
      id: 'home',
      name: 'Home',
      route: '/',
      purpose: 'p',
      elements: [{ id: 'add', kind: 'button', label: 'Add', testId: 'add' }],
      navigatesTo: [],
    },
  ],
  navigation: { style: 'single', root: 'home', edges: [] },
  state: { entities: {}, storeStyle: 'x', persistence: [] },
  logic: [],
  integrations: [],
  assets: [],
  permissions: [],
  platformFeatures: [],
  unknowns: [],
}
const BEHAVIORS = {
  behaviors: [
    {
      id: 'B-001',
      title: 'must',
      screen: 'home',
      priority: 'must',
      category: 'state',
      steps: [{ op: 'tap', element: 'add' }],
      evidence: [],
      verifiedOnSource: true,
    },
    {
      id: 'B-002',
      title: 'should',
      screen: 'home',
      priority: 'should',
      category: 'display',
      steps: [{ op: 'expectVisible', element: 'add' }],
      evidence: [],
      verifiedOnSource: true,
    },
  ],
  invariants: [],
  seedData: {},
}
const PLAN = {
  targets: [
    {
      target: 'android',
      uiFramework: 'Compose',
      layout: 'x',
      stateStrategy: 's',
      screenMap: [{ screen: 'home', file: 'Home.kt' }],
      persistenceMap: [],
      integrationMap: [],
      deviations: [],
    },
  ],
  core: { enabled: false, rationale: 'r', functions: [] },
  testPlan: { unit: [], e2e: ['B-001'], parity: [] },
  estimate: { stages: 1, costUsd: 1, minutes: 1 },
  questionsForHuman: [],
}

/** A target adapter with scripted outcomes so the stage logic can be exercised without toolchains. */
function fakeAdapter(script: {
  buildFailures?: number
  e2eFailRounds?: number
  flaky?: boolean
  /** B-002 passes instead of always failing. */
  b002Passes?: boolean
  /** B-001's flow carries a skipped custom step. */
  partial?: boolean
}): TargetAdapter & { calls: string[]; e2eFlows: string[][] } {
  let builds = 0
  let e2eRuns = 0
  const calls: string[] = []
  const e2eFlows: string[][] = []
  const pass = (kind: TestOutcome['kind'], cases: TestOutcome['cases']): TestOutcome => ({
    kind,
    status: cases.some((c) => c.status === 'fail') ? 'fail' : 'pass',
    cases,
    summary: {
      total: cases.length,
      passed: cases.filter((c) => c.status === 'pass').length,
      failed: cases.filter((c) => c.status === 'fail').length,
      skipped: 0,
      flaky: 0,
    },
  })
  return {
    calls,
    e2eFlows,
    id: 'fake',
    target: 'android',
    bashAllow: [],
    async available() {
      return { ok: true, env: process.env }
    },
    async scaffold(ctx) {
      calls.push('scaffold')
      mkdirSync(ctx.workspace, { recursive: true })
      writeFileSync(join(ctx.workspace, 'MPF.md'), '# conventions')
      return { files: ['MPF.md'] }
    },
    workerPrompt() {
      return 'conventions'
    },
    async build(): Promise<BuildResult> {
      calls.push('build')
      builds++
      const ok = builds > (script.buildFailures ?? 0)
      return {
        ok,
        diagnostics: ok ? [] : [{ severity: 'error', file: 'Main.kt', line: 1, message: 'boom' }],
        product: ok ? 'app.apk' : undefined,
        durationMs: 1,
        logTail: 'log',
      }
    },
    async unitTest() {
      calls.push('unit')
      return pass('unit', [{ id: 'u1', name: 'u1', status: 'pass', durationMs: 1, artifacts: [] }])
    },
    async compileFlows(ctx) {
      return ctx.behaviors.behaviors.map((b) => ({
        behaviorId: b.id,
        path: `maestro/${b.id}.yaml`,
        ...(script.partial && b.id === 'B-001' ? { unverifiable: 'custom step: tap the row' } : {}),
      }))
    },
    async e2e(_ctx, flows): Promise<E2eResult> {
      calls.push('e2e')
      e2eRuns++
      e2eFlows.push(flows.map((f) => f.behaviorId))
      const failMust =
        e2eRuns <= (script.e2eFailRounds ?? 0) && !(script.flaky && e2eRuns % 2 === 0)
      // Cases only for the flows that were asked for, the way a real adapter runs them.
      const statusOf = (id: string) =>
        id === 'B-001'
          ? failMust
            ? 'fail'
            : 'pass'
          : id === 'B-002' && !script.b002Passes
            ? 'fail'
            : 'pass'
      return {
        launch: pass('launch', [
          { id: 'launch', name: 'launch', status: 'pass', durationMs: 1, artifacts: [] },
        ]),
        flows: pass(
          'e2e',
          flows.map((f) => ({
            id: f.behaviorId,
            name: f.behaviorId,
            behaviorId: f.behaviorId,
            status: statusOf(f.behaviorId) as 'pass' | 'fail',
            durationMs: 1,
            artifacts: [],
          })),
        ),
        screenshots: [{ screenId: 'home', file: 'screenshots/home.png' }],
      }
    },
  }
}

const stubAgent: AgentFn = async () => ({
  ok: true,
  text: '',
  structured: {
    filesWritten: ['a.kt'],
    behaviorsCovered: ['B-001', 'B-002'],
    deviations: [],
    notes: '',
  },
  costUsd: 0.05,
  numTurns: 3,
  sessionId: 'gen-session',
  denials: 0,
})

async function runTargetStages(
  adapter: TargetAdapter,
  opts: { agent?: AgentFn; beforeFixLoop?: boolean } = {},
) {
  const store = new SqliteRunStore(':memory:')
  const bus = new RunEventBus(store)
  const events: Event[] = []
  bus.subscribeAll((e) => events.push(e))
  const config = MpfConfig.parse({})
  const deps = { agent: opts.agent ?? stubAgent, adapterFor: () => adapter }
  const registry: StageRunnerRegistry = {
    generate: generateStage(config, deps),
    build: buildStage(config, deps),
    test: testStage(config, deps),
  }
  const orch = new Orchestrator({
    store,
    bus,
    config,
    registry,
    dataDir: mkdtempSync(join(tmpdir(), 'mpf-target-')),
  })
  const run = orch.createRun({
    source: { locator: '.' },
    targets: ['android'],
    options: {
      coreMode: 'never',
      checkpoints: { planApproval: false, beforeFixLoop: opts.beforeFixLoop ?? false },
    },
  })
  // pretend analysis already happened: succeed the analysis stages and drop in the artifacts
  for (const [name, data] of [
    ['appspec', SPEC],
    ['behaviorspec', BEHAVIORS],
    ['portplan', PLAN],
  ] as const) {
    writeFileSync(join(run.runDir, `${name}.json`), JSON.stringify(data))
    store.addArtifact({
      id: name,
      runId: run.id,
      stageId: 'plan',
      kind: name,
      relPath: `${name}.json`,
      mime: 'application/json',
      createdAt: 'x',
      meta: {},
    })
  }
  for (const s of store.listStages(run.id)) {
    if (['ingest', 'inventory', 'spec', 'behaviors', 'observe', 'plan'].includes(s.kind))
      store.upsertStage({ ...s, status: 'succeeded' } as Stage)
  }
  await orch.start(run.id)
  return {
    orch,
    store,
    events,
    run: store.getRun(run.id) as Run,
    stages: new Map(store.listStages(run.id).map((s) => [s.id, s])),
  }
}

describe('target stages', () => {
  it('generates, builds, and tests a target end to end with a scripted adapter', async () => {
    const adapter = fakeAdapter({})
    const { stages, events, store, run } = await runTargetStages(adapter)
    expect(stages.get('generate:android')?.status).toBe('succeeded')
    expect(stages.get('build:android')?.status).toBe('succeeded')
    expect(stages.get('test:android')?.status).toBe('succeeded')
    expect(adapter.calls).toEqual(['scaffold', 'build', 'unit', 'e2e'])
    expect(store.listArtifacts(run.id).map((a) => a.kind)).toEqual(
      expect.arrayContaining(['android-apk', 'target-screenshot']),
    )
    const tests = events
      .filter((e): e is Extract<Event, { type: 'test.result' }> => e.type === 'test.result')
      .map((e) => e.result.kind)
    expect(tests).toEqual(['unit', 'launch', 'e2e'])
    // the should-behavior failed but is not blocking; critique has no runner here, so it blocks; the report still runs (and blocks too without a runner)
    expect(stages.get('critique:android')?.status).toBe('blocked')
    expect(stages.get('report')?.status).toBe('blocked')
  })

  it('runs the build-fix loop against the generation session and stops when it passes', async () => {
    const adapter = fakeAdapter({ buildFailures: 2 })
    const agent: AgentFn = async (o) => ({
      ...(await stubAgent(o)),
      sessionId: o.resume ?? 'gen-session',
    })
    const { stages } = await runTargetStages(adapter, { agent })
    expect(stages.get('build:android')?.status).toBe('succeeded')
    expect((stages.get('build:android')?.result as { rounds: number }).rounds).toBe(2)
    expect(adapter.calls.filter((c) => c === 'build')).toHaveLength(3)
  })

  it('blocks the build after the fix budget is exhausted', async () => {
    const adapter = fakeAdapter({ buildFailures: 10 })
    const { stages, run } = await runTargetStages(adapter)
    expect(stages.get('build:android')?.status).toBe('blocked')
    expect(stages.get('build:android')?.error?.class).toBe('build-error')
    expect(stages.get('test:android')?.status).toBe('skipped')
    expect(run.status).toBe('failed')
  })

  it('treats a must-behavior that passes on retry as flaky, and fixes real failures with a bounded loop', async () => {
    const flaky = fakeAdapter({ e2eFailRounds: 1, flaky: true })
    const r1 = await runTargetStages(flaky)
    expect(r1.stages.get('test:android')?.status).toBe('succeeded')
    const flows = r1.events.filter(
      (e): e is Extract<Event, { type: 'test.result' }> =>
        e.type === 'test.result' && e.result.kind === 'e2e',
    )
    expect(flows[0]?.result.cases.find((c) => c.id === 'B-001')?.status).toBe('flaky')

    const stubborn = fakeAdapter({ e2eFailRounds: 3 })
    const r2 = await runTargetStages(stubborn)
    expect(r2.stages.get('test:android')?.status).toBe('succeeded')
    expect((r2.stages.get('test:android')?.result as { rounds: number }).rounds).toBe(1)

    const hopeless = fakeAdapter({ e2eFailRounds: 100 })
    const r3 = await runTargetStages(hopeless)
    expect(r3.stages.get('test:android')?.status).toBe('blocked')
    expect(r3.stages.get('test:android')?.error?.message).toMatch(/B-001/)
  })

  it('skips a target whose toolchain is unavailable', async () => {
    const adapter = fakeAdapter({})
    adapter.available = async () => ({ ok: false, reason: 'no sdk', env: process.env })
    const { stages } = await runTargetStages(adapter)
    expect(stages.get('generate:android')?.status).toBe('skipped')
    expect(stages.get('generate:android')?.skipReason).toMatch(/no sdk/)
  })
})

describe('before-fix-loop checkpoint', () => {
  /** The stub agent, recording whether each call was the generation worker or a resumed fix worker. */
  function trackingAgent() {
    const calls: string[] = []
    const agent: AgentFn = async (o) => {
      calls.push(o.resume ? 'fix' : 'generate')
      return { ...(await stubAgent(o)), sessionId: o.resume ?? 'gen-session' }
    }
    return { agent, calls }
  }
  const asks = (events: Event[]) =>
    events.filter(
      (e): e is Extract<Event, { type: 'human.required' }> => e.type === 'human.required',
    )

  it('pauses on test:android before the first fix worker, and "continue" resumes into the fix loop', async () => {
    const adapter = fakeAdapter({ e2eFailRounds: 4 })
    const { agent, calls } = trackingAgent()
    const { orch, store, events, run } = await runTargetStages(adapter, {
      agent,
      beforeFixLoop: true,
    })
    expect(run.status).toBe('waiting_human')
    expect(store.getStage(run.id, 'test:android')?.status).toBe('waiting_human')
    expect(calls).toEqual(['generate'])
    const [ask] = asks(events)
    expect(ask?.stageId).toBe('test:android')
    expect(ask?.reason).toMatch(
      /^Tests for android: unit pass 1\/1, launch pass 1\/1, e2e fail 0\/2; blocking failures: B-001\. Continue to start a fix worker for android with a budget cap of \$\d+\.\d\d, or reject to cancel\.$/,
    )
    expect(ask?.choices.map((c) => c.id)).toEqual(['continue', 'reject'])
    // the results that explain the pause were emitted before it
    expect(
      events
        .filter((e): e is Extract<Event, { type: 'test.result' }> => e.type === 'test.result')
        .map((e) => e.result.kind),
    ).toEqual(['unit', 'launch', 'e2e'])

    await orch.answer(run.id, 'test:android', 'continue')
    const test = store.getStage(run.id, 'test:android')
    expect(test?.status).toBe('succeeded')
    expect((test?.result as { rounds: number }).rounds).toBe(1)
    expect(calls).toEqual(['generate', 'fix'])
    expect(asks(events)).toHaveLength(1)
  })

  it('never pauses when the checkpoint is off', async () => {
    const adapter = fakeAdapter({ e2eFailRounds: 3 })
    const { agent, calls } = trackingAgent()
    const { stages, events } = await runTargetStages(adapter, { agent, beforeFixLoop: false })
    expect(asks(events)).toHaveLength(0)
    expect(stages.get('test:android')?.status).toBe('succeeded')
    expect((stages.get('test:android')?.result as { rounds: number }).rounds).toBe(1)
    expect(calls).toEqual(['generate', 'fix'])
  })

  it('"reject" at the checkpoint cancels the run without starting a worker', async () => {
    const adapter = fakeAdapter({ e2eFailRounds: 100 })
    const { agent, calls } = trackingAgent()
    const { orch, store, run } = await runTargetStages(adapter, { agent, beforeFixLoop: true })
    expect(run.status).toBe('waiting_human')
    await orch.answer(run.id, 'test:android', 'reject')
    expect(store.getRun(run.id)?.status).toBe('cancelled')
    expect(store.getStage(run.id, 'test:android')?.status).toBe('cancelled')
    expect(calls).toEqual(['generate'])
  })

  it('pauses on build:android with the diagnostics in the reason, then fixes after "continue"', async () => {
    const adapter = fakeAdapter({ buildFailures: 2 })
    const { agent, calls } = trackingAgent()
    const { orch, store, events, run } = await runTargetStages(adapter, {
      agent,
      beforeFixLoop: true,
    })
    expect(store.getStage(run.id, 'build:android')?.status).toBe('waiting_human')
    const [ask] = asks(events)
    expect(ask?.stageId).toBe('build:android')
    expect(ask?.reason).toMatch(
      /^Build of android failed with 1 error\(s\): Main\.kt:1 boom\. Continue to start a fix worker for android with a budget cap of \$\d+\.\d\d, or reject to cancel\.$/,
    )
    expect(events.filter((e) => e.type === 'build.result')).toHaveLength(1)
    expect(calls).toEqual(['generate'])

    await orch.answer(run.id, 'build:android', 'continue')
    const build = store.getStage(run.id, 'build:android')
    expect(build?.status).toBe('succeeded')
    expect((build?.result as { rounds: number }).rounds).toBe(1)
    expect(calls).toEqual(['generate', 'fix'])
    // tests pass first time, so the test stage has no fix worker to ask about
    expect(store.getStage(run.id, 'test:android')?.status).toBe('succeeded')
    expect(asks(events)).toHaveLength(1)
  })
})

export type { StageContext }

describe('flow retries and partial flows', () => {
  it('retries only the flows that failed when separating flaky from real failures', async () => {
    const adapter = fakeAdapter({ e2eFailRounds: 1, b002Passes: true })
    const { stages } = await runTargetStages(adapter)
    expect(adapter.e2eFlows[0]).toEqual(['B-001', 'B-002'])
    expect(adapter.e2eFlows[1]).toEqual(['B-001'])
    expect(stages.get('test:android')?.status).toBe('succeeded')
  })

  it('does not block the target on a must behavior whose flow skipped a custom step', async () => {
    const adapter = fakeAdapter({ e2eFailRounds: 99, b002Passes: true, partial: true })
    const { stages, events } = await runTargetStages(adapter)
    expect(stages.get('test:android')?.status).toBe('succeeded')
    expect(adapter.calls.filter((c) => c === 'e2e')).toHaveLength(1)
    const warned = events.some(
      (e) =>
        e.type === 'log' && /could not express and do not block the target: B-001/.test(e.message),
    )
    expect(warned).toBe(true)
  })
})
