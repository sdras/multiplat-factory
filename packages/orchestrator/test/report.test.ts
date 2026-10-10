import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CriticOutput, MpfConfig, RunEventBus, SqliteRunStore, type Stage } from '@mpf/core'
import type { StageRunnerRegistry } from '@mpf/harness'
import { androidTarget, type TargetAdapter, type TestOutcome } from '@mpf/adapters'
import type { AgentFn } from '@mpf/analyzer'
import { Orchestrator } from '../src/runner.ts'
import { critiqueStage, fixStage } from '../src/stages/critic.ts'
import { reportStage } from '../src/stages/report.ts'
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
  state: {
    entities: {},
    storeStyle: 'x',
    persistence: [
      {
        mechanism: 'localstorage',
        keys: [{ key: 'counter.state', shape: '{count}', wireFormatPins: ['JSON object'] }],
      },
    ],
  },
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
      title: 'Add increments',
      screen: 'home',
      priority: 'must',
      category: 'state',
      steps: [{ op: 'tap', element: 'add' }],
      evidence: [],
      verifiedOnSource: true,
    },
    {
      id: 'B-002',
      title: 'Survives restart',
      screen: 'home',
      priority: 'should',
      category: 'state',
      steps: [{ op: 'restart' }],
      evidence: [],
      verifiedOnSource: false,
    },
  ],
  invariants: ['count is never negative'],
  seedData: {},
}
/** The plan names a package and paths the scaffold never uses; the report must not repeat them as fact. */
const PLAN = {
  targets: [
    {
      target: 'android',
      uiFramework: 'Compose',
      layout: 'single activity under app/src/main/java/dev/example/counter',
      stateStrategy: 'ViewModel + DataStore',
      screenMap: [
        { screen: 'home', file: 'app/src/main/java/dev/example/counter/Home.kt', notes: 'root' },
        { screen: 'settings', file: 'Settings.kt', notes: 'planned only' },
      ],
      persistenceMap: [
        { sourceKey: 'counter.state', mechanism: 'DataStore', sameWireFormat: true },
      ],
      integrationMap: [],
      deviations: [{ what: 'No hover states', why: 'touch UI', accepted: true }],
    },
    {
      target: 'ios',
      uiFramework: 'SwiftUI',
      layout: 'x',
      stateStrategy: 's',
      screenMap: [],
      persistenceMap: [],
      integrationMap: [],
      deviations: [],
    },
  ],
  core: { enabled: false, rationale: 'r', functions: [] },
  testPlan: { unit: [], e2e: ['B-001'], parity: [] },
  estimate: { stages: 1, costUsd: 1, minutes: 1 },
  questionsForHuman: ['Keep the confetti animation?'],
}

/** What a generated Android workspace looks like: the id in Gradle differs from both the plan and the scaffold default. */
const SHIPPED_ID = 'app.mpf.counterport'
const PKG = 'app/src/main/kotlin/app/mpf/counterport'
const HOME = `${PKG}/ui/screens/Home.kt`
const MISSING = `${PKG}/ui/Missing.kt`
const WORKSPACE_FILES: Record<string, string> = {
  'settings.gradle.kts': 'rootProject.name = "counter"\ninclude(":app")\n',
  'app/build.gradle.kts': `android {\n    namespace = "${SHIPPED_ID}"\n    compileSdk = 36\n    defaultConfig {\n        applicationId = "${SHIPPED_ID}"\n        minSdk = 24\n    }\n}\n`,
  'app/src/main/AndroidManifest.xml': '<manifest />',
  'app/src/main/res/values/strings.xml': '<resources />',
  [`${PKG}/MainActivity.kt`]: 'class MainActivity',
  [HOME]: '@Composable fun Home() {}',
  [`app/src/test/kotlin/app/mpf/counterport/ScaffoldTest.kt`]: 'class ScaffoldTest',
  'maestro/B-001.yaml': 'appId: x',
  'MPF.md': '#',
  // build output, caches, and evidence that must stay out of the file map
  'app/build/outputs/apk/debug/app-debug.apk': 'apk',
  'app/build/intermediates/x/y.bin': 'bin',
  '.gradle/8.14/fileHashes/fileHashes.bin': 'bin',
  'maestro-debug/2026/hierarchy.txt': 'tree',
  '.git/HEAD': 'ref',
}

const pass = (kind: TestOutcome['kind']): TestOutcome => ({
  kind,
  status: 'pass',
  cases: [
    { id: 'c', name: 'c', behaviorId: 'B-001', status: 'pass', durationMs: 1, artifacts: [] },
  ],
  summary: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
})

/** A fake Android adapter whose scaffold writes a realistic tree and whose docs come from the real adapter (it reads the workspace). */
function fakeAndroid(files: Record<string, string> = WORKSPACE_FILES): TargetAdapter {
  return {
    id: 'fake-android',
    target: 'android',
    bashAllow: [],
    async available() {
      return { ok: true, env: process.env }
    },
    async scaffold(ctx) {
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(dirname(join(ctx.workspace, rel)), { recursive: true })
        writeFileSync(join(ctx.workspace, rel), body)
      }
      return { files: Object.keys(files) }
    },
    workerPrompt() {
      return 'conventions'
    },
    async build() {
      return {
        ok: true,
        diagnostics: [],
        product: 'app/build/outputs/apk/debug/app-debug.apk',
        durationMs: 1,
        logTail: '',
      }
    },
    async unitTest() {
      return pass('unit')
    },
    async compileFlows() {
      return [{ behaviorId: 'B-001', path: 'maestro/B-001.yaml' }]
    },
    async e2e(ctx) {
      mkdirSync(join(ctx.workspace, 'screenshots'), { recursive: true })
      writeFileSync(join(ctx.workspace, 'screenshots/home.png'), 'png')
      return {
        launch: pass('launch'),
        flows: pass('e2e'),
        screenshots: [{ screenId: 'home', file: 'screenshots/home.png' }],
      }
    },
    docs: (ctx) => androidTarget.docs!(ctx),
  }
}

const critic: AgentFn = async (o) => {
  if (o.outputSchema === CriticOutput) {
    const out: CriticOutput = {
      scores: { fidelity: 4, idiomatic: 4, testAdequacy: 3, parityDocs: 5, buildHealth: 5 },
      findings: [
        {
          id: 'adv-1',
          severity: 'advisory',
          category: 'idiomatic',
          file: 'Home.kt',
          line: 12,
          description: 'Prefer a Scaffold',
          suggestedFix: 'wrap in Scaffold',
          evidence: 'Home.kt:12',
        },
      ],
      confidence: 0.9,
      acceptedDeviationsSeen: ['No hover states'],
      summary: 'Faithful port with one style nit.',
    }
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
      filesWritten: [HOME, './MPF.md', MISSING],
      behaviorsCovered: ['B-001', 'B-002'],
      deviations: [{ what: 'Restart uses process death', why: 'Android has no page reload' }],
      notes: 'Used DataStore.',
    },
    costUsd: 0.05,
    numTurns: 3,
    sessionId: 'gen',
    denials: 0,
  }
}

/** Run the fake pipeline for android (available) and ios (no toolchain) through to the report stage. */
async function runPipeline(android: TargetAdapter) {
  const ios: TargetAdapter = {
    ...android,
    id: 'fake-ios',
    target: 'ios',
    async available() {
      return { ok: false, reason: 'no Xcode on this host', env: process.env }
    },
  }
  const adapters = new Map<string, TargetAdapter>([
    ['android', android],
    ['ios', ios],
  ])
  const store = new SqliteRunStore(':memory:')
  const bus = new RunEventBus(store)
  const config = MpfConfig.parse({})
  const deps = { agent: critic, adapterFor: (t: string) => adapters.get(t) }
  const registry: StageRunnerRegistry = {
    generate: generateStage(config, deps),
    build: buildStage(config, deps),
    test: testStage(config, deps),
    critique: critiqueStage(config, deps),
    fix: fixStage(config, deps),
    report: reportStage(deps),
  }
  const orch = new Orchestrator({
    store,
    bus,
    config,
    registry,
    dataDir: mkdtempSync(join(tmpdir(), 'mpf-report-')),
  })
  const run = orch.createRun({
    source: { locator: '.' },
    targets: ['android', 'ios'],
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
  await orch.start(run.id)
  return { store, run, md: readFileSync(join(run.runDir, 'workspace/android/PORT.md'), 'utf8') }
}

describe('report stage', () => {
  it('writes PORT.md per built target, report.json, and a one-line run summary', async () => {
    const { store, run, md } = await runPipeline(fakeAndroid())

    const stages = new Map(store.listStages(run.id).map((s) => [s.id, s]))
    expect(stages.get('report')?.status).toBe('succeeded')
    expect(stages.get('generate:ios')?.status).toBe('skipped')

    expect(md).toContain('# Counter — android port')
    expect(md).toContain('./gradlew assembleDebug')
    expect(md).toContain('Product: `app/build/outputs/apk/debug/app-debug.apk`')
    expect(md).toContain('- `counter.state` → DataStore (same wire format)')
    expect(md).toContain('| B-001 | Add increments | must | yes | pass |')
    expect(md).toContain('| B-002 | Survives restart | should | no | implemented, not run |')
    expect(md).toContain('- count is never negative')
    expect(md).toContain('(accepted) **No hover states**')
    expect(md).toContain('**Restart uses process death**')
    expect(md).toContain('Round 1: **pass**')
    expect(md).toContain('### Advisory findings')
    expect(md).toContain('`Home.kt:12`: Prefer a Scaffold')
    expect(md).toContain('![home](screenshots/home.png)')
    expect(md).toContain('Keep the confetti animation?')
    expect(md).toContain('Used DataStore.')

    const json = JSON.parse(readFileSync(join(run.runDir, 'report.json'), 'utf8'))
    expect(
      json.targets.map((t: { target: string; outcome: string }) => [t.target, t.outcome]),
    ).toEqual([
      ['android', 'succeeded'],
      ['ios', 'skipped'],
    ])
    expect(json.targets[0].critic).toMatchObject({
      decision: 'pass',
      round: 1,
      average: 4.2,
      blocking: 0,
      advisory: 1,
    })
    expect(store.listArtifacts(run.id).some((a) => a.kind === 'run-report')).toBe(true)

    const final = store.getRun(run.id)!
    expect(final.summary).toBe(
      'android: 1/1 flows, 1/1 unit, critic pass 4.2/5; ios: skipped (ios toolchain unavailable: no Xcode on this host)',
    )
    expect(final.status).toBe('partial')
  })

  it('describes the shipped workspace, not the plan: ids from project files, files from the tree', async () => {
    const { run, md } = await runPipeline(fakeAndroid())

    // header and conventions carry the id Gradle declares, with its source; never the scaffold default or the plan's package
    expect(md).toContain(
      `UI: Compose. Application id \`${SHIPPED_ID}\` (read from \`app/build.gradle.kts\`). 9 project files in the workspace (build output excluded).`,
    )
    expect(md).toContain(
      `- Application id \`${SHIPPED_ID}\` (from \`app/build.gradle.kts\`); minSdk 24, compileSdk 36,`,
    )
    expect(md).toContain(`deep link \`mpf://${SHIPPED_ID}/<screenId>\``)
    expect(md).not.toContain('`app.mpf.counter`')
    expect(md).not.toContain('dev.example.counter`\n')

    // the file map comes from the tree, grouped, with build output and evidence left out
    const shipped = md.slice(md.indexOf('## What shipped'), md.indexOf('## Architecture map'))
    expect(shipped).toContain(
      `The generation worker reported writing 3 files; 1 of them is not in the workspace: \`${MISSING}\`.`,
    )
    expect(shipped).toContain('### App sources (4)')
    expect(shipped).toContain(`- \`${HOME}\``)
    expect(shipped).toContain('- `app/src/main/AndroidManifest.xml`')
    expect(shipped).toContain('### Unit and instrumented tests (1)')
    expect(shipped).toContain('- `app/src/test/kotlin/app/mpf/counterport/ScaffoldTest.kt`')
    expect(shipped).toContain('### End-to-end flows (1)')
    expect(shipped).toContain('- `maestro/B-001.yaml`')
    expect(shipped).toContain('### Project files (3)')
    expect(shipped).toContain('- `app/build.gradle.kts`')
    expect(shipped).toContain('- `MPF.md`')
    for (const hidden of [
      'app/build/',
      '.gradle/',
      'maestro-debug',
      'screenshots/',
      '.git/',
      'PORT.md',
    ])
      expect(shipped).not.toContain(hidden)

    // the plan's screen map stays, labeled as the plan, with where each planned file really landed
    expect(md).toContain(
      'Planned layout (from the PortPlan, before generation): single activity under app/src/main/java/dev/example/counter',
    )
    expect(md).toContain('### Screen map as planned')
    expect(md).toContain(
      `| \`home\` | \`app/src/main/java/dev/example/counter/Home.kt\` | yes, as \`${HOME}\` | root |`,
    )
    expect(md).toContain('| `settings` | `Settings.kt` | no | planned only |')
    expect(md).toContain('State (as planned): ViewModel + DataStore')

    const json = JSON.parse(readFileSync(join(run.runDir, 'report.json'), 'utf8'))
    expect(json.targets[0]).toMatchObject({ appId: SHIPPED_ID, files: 9 })
  })

  it('rolls a long group up by directory and still says the total', async () => {
    const files = { ...WORKSPACE_FILES }
    for (let i = 0; i < 30; i++) files[`${PKG}/ui/widgets/Widget${i}.kt`] = 'x'
    for (let i = 0; i < 20; i++) files[`${PKG}/data/Repo${i}.kt`] = 'x'
    const { md } = await runPipeline(fakeAndroid(files))

    expect(md).toContain('59 project files in the workspace')
    const shipped = md.slice(md.indexOf('## What shipped'), md.indexOf('## Architecture map'))
    expect(shipped).toContain('### App sources (54)')
    expect(shipped).toContain(
      `- \`${PKG}/ui/widgets/\` (30): Widget0.kt, Widget1.kt, Widget10.kt, Widget11.kt, Widget12.kt, Widget13.kt, … 24 more`,
    )
    expect(shipped).toContain(`- \`${PKG}/data/\` (20): Repo0.kt`)
    expect(shipped).toContain(`- \`${PKG}/ui/screens/\` (1): Home.kt`)
    expect(shipped).not.toContain(`- \`${HOME}\``)
    // short groups are still listed file by file
    expect(shipped).toContain('- `maestro/B-001.yaml`')
  })
})
