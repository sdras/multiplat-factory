import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CriticOutput,
  MpfConfig,
  RunEventBus,
  SqliteRunStore,
  type Event,
  type Stage,
} from '@mpf/core'
import type { StageRunnerRegistry } from '@mpf/harness'
import type { TargetAdapter, TestOutcome } from '@mpf/adapters'
import type { AgentFn } from '@mpf/analyzer'
import { Orchestrator } from '../src/runner.ts'
import { critiqueStage, fixStage } from '../src/stages/critic.ts'
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

const pass = (kind: TestOutcome['kind']): TestOutcome => ({
  kind,
  status: 'pass',
  cases: [
    { id: 'c', name: 'c', behaviorId: 'B-001', status: 'pass', durationMs: 1, artifacts: [] },
  ],
  summary: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
})
const adapter: TargetAdapter & { builds: number } = {
  builds: 0,
  id: 'fake',
  target: 'android',
  bashAllow: [],
  async available() {
    return { ok: true, env: process.env }
  },
  async scaffold(ctx) {
    mkdirSync(ctx.workspace, { recursive: true })
    writeFileSync(join(ctx.workspace, 'MPF.md'), '#')
    return { files: ['MPF.md'] }
  },
  workerPrompt() {
    return 'conventions'
  },
  async build() {
    adapter.builds++
    return { ok: true, diagnostics: [], product: 'app.apk', durationMs: 1, logTail: '' }
  },
  async unitTest() {
    return pass('unit')
  },
  async compileFlows() {
    return [{ behaviorId: 'B-001', path: 'maestro/B-001.yaml' }]
  },
  async e2e() {
    return { launch: pass('launch'), flows: pass('e2e'), screenshots: [] }
  },
}

function criticScript(outputs: CriticOutput[]): AgentFn {
  let calls = 0
  return async (o) => {
    if (o.outputSchema === CriticOutput) {
      const out = outputs[Math.min(calls++, outputs.length - 1)]!
      return {
        ok: true,
        text: '',
        structured: out,
        costUsd: 0.02,
        numTurns: 2,
        sessionId: 'critic',
        denials: 0,
      }
    }
    return {
      ok: true,
      text: '',
      structured: {
        filesWritten: ['Home.kt'],
        behaviorsCovered: ['B-001'],
        deviations: [],
        notes: '',
      },
      costUsd: 0.05,
      numTurns: 3,
      sessionId: o.resume ?? 'gen',
      denials: 0,
    }
  }
}

const verdict = (findings: CriticOutput['findings'], confidence = 0.9): CriticOutput => ({
  scores: { fidelity: 3, idiomatic: 4, testAdequacy: 4, parityDocs: 4, buildHealth: 5 },
  findings,
  confidence,
  acceptedDeviationsSeen: [],
  summary: 's',
})
const blocking = (d: string) => ({
  id: 'x',
  severity: 'blocking' as const,
  category: 'fidelity' as const,
  file: 'Home.kt',
  description: d,
  suggestedFix: 'f',
  evidence: 'e',
})

async function runWith(agent: AgentFn) {
  const store = new SqliteRunStore(':memory:')
  const bus = new RunEventBus(store)
  const events: Event[] = []
  bus.subscribeAll((e) => events.push(e))
  const config = MpfConfig.parse({})
  const deps = { agent, adapterFor: () => adapter }
  const registry: StageRunnerRegistry = {
    generate: generateStage(config, deps),
    build: buildStage(config, deps),
    test: testStage(config, deps),
    critique: critiqueStage(config, deps),
    fix: fixStage(config, deps),
  }
  const orch = new Orchestrator({
    store,
    bus,
    config,
    registry,
    dataDir: mkdtempSync(join(tmpdir(), 'mpf-critic-')),
  })
  const run = orch.createRun({
    source: { locator: '.' },
    targets: ['android'],
    options: { coreMode: 'never', checkpoints: { planApproval: false, beforeFixLoop: false } },
  })
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
  for (const s of store.listStages(run.id))
    if (['ingest', 'inventory', 'spec', 'behaviors', 'observe', 'plan'].includes(s.kind))
      store.upsertStage({ ...s, status: 'succeeded' } as Stage)
  adapter.builds = 0
  await orch.start(run.id)
  return {
    store,
    events,
    orch,
    run,
    stages: () => new Map(store.listStages(run.id).map((s) => [s.id, s])),
  }
}

describe('critic and fix loop', () => {
  it('passes straight through when the critic finds nothing blocking', async () => {
    const { stages, events } = await runWith(criticScript([verdict([])]))
    expect(stages().get('critique:android')?.status).toBe('succeeded')
    expect(stages().get('fix:android')?.status).toBe('skipped')
    expect(events.filter((e) => e.type === 'critic.verdict')).toHaveLength(1)
    expect(adapter.builds).toBe(1)
  })

  it('fixes blocking findings, reruns build/test/critique, and passes on the second round', async () => {
    const { stages, events } = await runWith(
      criticScript([verdict([blocking('missing tag')]), verdict([])]),
    )
    const verdicts = events
      .filter((e): e is Extract<Event, { type: 'critic.verdict' }> => e.type === 'critic.verdict')
      .map((e) => e.verdict)
    expect(verdicts.map((v) => v.decision)).toEqual(['fix', 'pass'])
    expect(verdicts[1]?.round).toBe(2)
    expect(adapter.builds).toBe(2)
    expect(stages().get('critique:android')?.status).toBe('succeeded')
    expect(stages().get('fix:android')?.status).toBe('skipped')
  })

  it('escalates to a human when findings persist, and accepting them completes the target', async () => {
    const same = verdict([blocking('missing tag')])
    const { stages, orch, run, store } = await runWith(criticScript([same, same, same]))
    expect(store.getRun(run.id)?.status).toBe('waiting_human')
    expect(stages().get('critique:android')?.status).toBe('waiting_human')
    await orch.answer(run.id, 'critique:android', 'accept')
    expect(stages().get('critique:android')?.status).toBe('succeeded')
    expect(stages().get('fix:android')?.status).toBe('skipped')
    // Finding ids are content hashes assigned by the stage; the description is what the human accepted.
    const result = stages().get('critique:android')?.result as {
      acceptedDeviations?: { id: string; description: string }[]
    }
    expect(result.acceptedDeviations?.map((d) => d.description)).toEqual([
      same.findings[0]!.description,
    ])
  })

  it('treats any answer but reject as acceptance, so "approve" from a CLI or script does not rerun the critic', async () => {
    const same = verdict([blocking('missing tag')])
    const { stages, orch, run, store } = await runWith(criticScript([same, same, same]))
    expect(store.getRun(run.id)?.status).toBe('waiting_human')
    await orch.answer(run.id, 'critique:android', 'approve')
    expect(stages().get('critique:android')?.status).toBe('succeeded')
    expect((stages().get('critique:android')?.result as { decision?: string }).decision).toBe(
      'accepted',
    )
  })
})
