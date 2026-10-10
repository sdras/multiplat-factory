import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AppSpec, BehaviorSpec, MpfConfig, PortPlan, RunEventBus, SqliteRunStore } from '@mpf/core'
import type { StageRunnerRegistry } from '@mpf/harness'
import type { AgentFn } from '@mpf/analyzer'
import {
  behaviorsStage,
  ingestStage,
  inventoryStage,
  observeStage,
  planStage,
  specStage,
} from '@mpf/analyzer'
import { Orchestrator } from '../src/runner.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', '..', '..', 'fixtures', 'inhouse', 'web-vanilla-counter')

/** Canned analysis for the counter fixture, shaped like a real worker's structured output. */
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
      id: 'counter',
      name: 'Counter',
      route: '#/',
      purpose: 'Count up and down',
      elements: [
        {
          id: 'count-value',
          kind: 'text',
          label: 'Count',
          testId: 'count-value',
          bindsTo: 'count',
        },
        { id: 'count-parity', kind: 'text', label: 'Parity', testId: 'count-parity' },
        { id: 'increment', kind: 'button', label: '+', testId: 'increment', action: 'adds step' },
        {
          id: 'decrement',
          kind: 'button',
          label: '−',
          testId: 'decrement',
          action: 'subtracts step',
        },
        { id: 'reset', kind: 'button', label: 'Reset', testId: 'reset' },
        { id: 'nav-settings', kind: 'link', label: 'Settings', testId: 'nav-settings' },
      ],
      navigatesTo: ['settings'],
    },
    {
      id: 'settings',
      name: 'Settings',
      route: '#/settings',
      purpose: 'Choose the step size',
      elements: [
        {
          id: 'step-input',
          kind: 'input',
          label: 'Step size',
          testId: 'step-input',
          bindsTo: 'step',
        },
        { id: 'save-step', kind: 'button', label: 'Save', testId: 'save-step' },
        { id: 'step-saved', kind: 'text', label: 'Saved', testId: 'step-saved' },
        { id: 'nav-counter', kind: 'link', label: 'Counter', testId: 'nav-counter' },
      ],
      navigatesTo: ['counter'],
    },
  ],
  navigation: {
    style: 'routes',
    root: 'counter',
    edges: [{ from: 'counter', to: 'settings', trigger: 'nav-settings' }],
  },
  state: {
    entities: { state: '{ count: number, step: number }' },
    storeStyle: 'module-level object',
    persistence: [
      {
        mechanism: 'localstorage',
        keys: [
          {
            key: 'counter.state',
            shape: '{count:number,step:number}',
            wireFormatPins: ['JSON object with count and step'],
          },
        ],
      },
    ],
  },
  logic: [
    {
      id: 'clamp',
      file: 'main.js',
      symbol: 'clampCount',
      purity: 'pure',
      loc: 3,
      inputs: 'number',
      outputs: 'number',
      description: 'count never below zero',
      coreCandidate: true,
    },
  ],
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
      title: 'Increment adds the step',
      screen: 'counter',
      priority: 'must',
      category: 'state',
      steps: [
        { op: 'tap', element: 'increment' },
        { op: 'expectText', element: 'count-value', text: '1', exact: true },
      ],
      evidence: ['main.js:34'],
      verifiedOnSource: false,
    },
    {
      id: 'B-002',
      title: 'Count never goes below zero',
      screen: 'counter',
      priority: 'must',
      category: 'logic',
      steps: [
        { op: 'tap', element: 'decrement' },
        { op: 'expectText', element: 'count-value', text: '0', exact: true },
      ],
      evidence: ['main.js:26'],
      verifiedOnSource: false,
    },
    {
      id: 'B-003',
      title: 'Count survives a restart',
      screen: 'counter',
      priority: 'must',
      category: 'persistence',
      steps: [
        { op: 'tap', element: 'increment' },
        { op: 'restart' },
        { op: 'expectText', element: 'count-value', text: '1', exact: true },
      ],
      evidence: ['main.js:20'],
      verifiedOnSource: false,
    },
    {
      id: 'B-004',
      title: 'Saving a step changes the increment',
      screen: 'settings',
      priority: 'must',
      category: 'state',
      steps: [
        { op: 'type', element: 'step-input', text: '5' },
        { op: 'tap', element: 'save-step' },
        { op: 'expectVisible', element: 'step-saved' },
        { op: 'navigate', screen: 'counter' },
        { op: 'tap', element: 'increment' },
        { op: 'expectText', element: 'count-value', text: '5', exact: true },
      ],
      evidence: ['main.js:60'],
      verifiedOnSource: false,
    },
  ],
  invariants: ['storage key counter.state keeps {count, step}'],
  seedData: { 'counter.state': { count: 0, step: 1 } },
}

const PLAN = {
  targets: [
    {
      target: 'android',
      uiFramework: 'Jetpack Compose',
      layout: 'single module',
      stateStrategy: 'ViewModel + DataStore',
      screenMap: [
        { screen: 'counter', file: 'ui/CounterScreen.kt' },
        { screen: 'settings', file: 'ui/SettingsScreen.kt' },
      ],
      persistenceMap: [
        { sourceKey: 'counter.state', mechanism: 'datastore', sameWireFormat: true },
      ],
      integrationMap: [],
      deviations: [],
    },
  ],
  core: { enabled: false, rationale: 'three lines of logic', functions: [] },
  testPlan: {
    unit: ['clampCount'],
    e2e: ['B-001', 'B-002', 'B-003', 'B-004'],
    parity: ['clampCount'],
  },
  estimate: { stages: 12, costUsd: 4, minutes: 20 },
  questionsForHuman: [],
}

const stubAgent: AgentFn = async (opts) => {
  const structured =
    opts.outputSchema === AppSpec
      ? SPEC
      : opts.outputSchema === BehaviorSpec
        ? BEHAVIORS
        : opts.outputSchema === PortPlan
          ? PLAN
          : undefined
  opts.onEvent?.({ type: 'message', role: 'assistant', text: 'stub worker' })
  return {
    ok: true,
    text: '',
    structured,
    costUsd: 0.01,
    numTurns: 1,
    sessionId: 'stub-session',
    denials: 0,
  }
}

describe('real analysis pipeline on the counter fixture (stubbed LLM)', () => {
  it('ingests, inventories, specs, extracts behaviors, observes, plans, waits for approval, then stops after plan', async () => {
    const store = new SqliteRunStore(':memory:')
    const bus = new RunEventBus(store)
    const config = MpfConfig.parse({})
    const registry: StageRunnerRegistry = {
      ingest: ingestStage(),
      inventory: inventoryStage(),
      spec: specStage(config, { agent: stubAgent }),
      behaviors: behaviorsStage(config, { agent: stubAgent }),
      observe: observeStage(),
      plan: planStage(config, {
        agent: stubAgent,
        doctor: async () => ({
          generatedAt: 'x',
          host: { os: 'x', arch: 'x', node: 'x' },
          checks: [],
          availableTargets: ['web'],
          llmBackend: 'none',
        }),
      }),
    }
    const orch = new Orchestrator({
      store,
      bus,
      config,
      registry,
      dataDir: mkdtempSync(join(tmpdir(), 'mpf-real-')),
    })
    const run = orch.createRun({
      source: { locator: fixture },
      targets: ['android'],
      options: { coreMode: 'never', until: 'plan' },
    })
    await orch.start(run.id)

    const stages = new Map(store.listStages(run.id).map((s) => [s.id, s]))
    expect(stages.get('ingest')?.status).toBe('succeeded')
    expect(stages.get('inventory')?.status).toBe('succeeded')
    expect(stages.get('spec')?.status).toBe('succeeded')
    expect(stages.get('behaviors')?.status).toBe('succeeded')
    expect(stages.get('observe')?.status).toBe('succeeded')
    expect(stages.get('plan')?.status).toBe('waiting_human')
    expect(store.getRun(run.id)?.status).toBe('waiting_human')
    expect(store.getRun(run.id)?.source.adapterId).toBe('web-static')

    const dir = store.getRun(run.id)!.runDir
    for (const f of [
      'source/index.html',
      'detection.json',
      'inventory.json',
      'appspec.json',
      'behaviorspec.json',
      'portplan.json',
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true)
    }
    const observed = stages.get('observe')?.result as {
      verified: number
      total: number
      failures: { id: string; error: string }[]
    }
    console.log('observe result:', JSON.stringify(observed))
    expect(observed.total).toBe(4)
    // With Chromium installed every behavior verifies on the real fixture; without it, none do but the stage still succeeds.
    if (observed.verified > 0) {
      expect(observed.failures, JSON.stringify(observed.failures)).toEqual([])
      expect(observed.verified).toBe(4)
      const bs = JSON.parse(readFileSync(join(dir, 'behaviorspec.json'), 'utf8')) as {
        behaviors: { verifiedOnSource: boolean }[]
      }
      expect(bs.behaviors.every((b) => b.verifiedOnSource)).toBe(true)
      expect(
        store.listArtifacts(run.id).filter((a) => a.kind === 'source-screenshot').length,
      ).toBeGreaterThanOrEqual(6)
    }

    await orch.answer(run.id, 'plan', 'approve')
    expect(store.getStage(run.id, 'plan')?.status).toBe('succeeded')
    expect(store.getRun(run.id)?.status).toBe('paused')
    // `until: 'plan'` stops before anything downstream is scheduled
    expect(['pending', 'paused']).toContain(store.getStage(run.id, 'generate:android')?.status)
    store.close()
  }, 120_000)

  it('blocks immediately on an unsupported or missing source', async () => {
    const store = new SqliteRunStore(':memory:')
    const bus = new RunEventBus(store)
    const config = MpfConfig.parse({})
    const orch = new Orchestrator({
      store,
      bus,
      config,
      registry: { ingest: ingestStage() },
      dataDir: mkdtempSync(join(tmpdir(), 'mpf-real-')),
    })
    const run = orch.createRun({
      source: { locator: '/definitely/not/here' },
      targets: ['web'],
      options: { coreMode: 'never' },
    })
    await orch.start(run.id)
    const ingest = store.getStage(run.id, 'ingest')
    expect(ingest?.status).toBe('blocked')
    expect(ingest?.attempt).toBe(1)
    expect(ingest?.error?.class).toBe('unsupported-source')
    expect(store.getRun(run.id)?.status).toBe('failed')
    store.close()
  })
})
