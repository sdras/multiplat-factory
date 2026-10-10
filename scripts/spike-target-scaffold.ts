/**
 * Target spike: does the green scaffold build, unit-test, launch on a device, and pass a
 * trivial Maestro flow on this machine, with no LLM involved?
 *
 *   MPF_SPIKE_DIR=/tmp/spike pnpm tsx scripts/spike-target-scaffold.ts --target android|ios|web [--e2e] [--core] [--framework vanilla|react|vue]
 *
 * `--core` first builds a one-function shared core (Rust -> wasm32) and embeds it, so the
 * target's unit tests also run the generated host binding and the golden-vector parity test
 * (Chicory on the JVM, WasmKit on the simulator, WebAssembly in vitest).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import {
  CoreManifest,
  MpfConfig,
  RunOptions,
  type AppSpec,
  type BehaviorSpec,
  type Run,
  type Target,
  type TargetPlan,
} from '@mpf/core'
import { hasWasmTarget, rustTools } from '@mpf/harness'
import { getTargetAdapter, type CoreHandoff, type TargetContext } from '@mpf/adapters'
import { buildCoreWasm, coreFiles, testCore, writeVectorSets } from '@mpf/wasm-core'

const targetArg = process.argv[process.argv.indexOf('--target') + 1]
const target = (
  ['android', 'ios', 'web'].includes(targetArg ?? '') ? targetArg : 'android'
) as Target
const dir = process.env.MPF_SPIKE_DIR ?? join(tmpdir(), `mpf-${target}-spike`)
const e2e = process.argv.includes('--e2e')
const withCore = process.argv.includes('--core')
/** Web only: which scaffold flavor to ask for (vanilla, react, vue). */
const framework = process.argv.includes('--framework')
  ? (process.argv[process.argv.indexOf('--framework') + 1] ?? 'native')
  : 'native'
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const spec: AppSpec = {
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
      purpose: 'count',
      elements: [{ id: 'count-value', kind: 'text', label: 'Count', testId: 'count-value' }],
      navigatesTo: ['settings'],
    },
    {
      id: 'settings',
      name: 'Settings',
      route: '#/settings',
      purpose: 'step',
      // the placeholder scaffold tags each screen container screen-<id>; alias it so a flow can assert it
      elements: [
        {
          id: 'screen-settings',
          kind: 'custom',
          label: 'Settings screen',
          testId: 'screen-settings',
        },
      ],
      navigatesTo: ['counter'],
    },
  ],
  navigation: { style: 'routes', root: 'counter', edges: [] },
  state: { entities: {}, storeStyle: 'module', persistence: [] },
  logic: [],
  integrations: [],
  assets: [],
  permissions: [],
  platformFeatures: [],
  unknowns: [],
}
const behaviors: BehaviorSpec = {
  behaviors: [
    {
      id: 'B-001',
      title: 'Settings screen is reachable',
      screen: 'settings',
      priority: 'must',
      category: 'nav',
      steps: [{ op: 'expectVisible', element: 'screen-settings' }],
      evidence: [],
      verifiedOnSource: false,
    },
  ],
  invariants: [],
  seedData: {},
}
const run: Run = {
  id: 'spike',
  createdAt: 'x',
  updatedAt: 'x',
  status: 'running',
  source: { locator: '.' },
  targets: [target],
  options: RunOptions.parse({ coreMode: withCore ? 'always' : 'never' }),
  runDir: dir,
  costUsd: 0,
}
const plan: TargetPlan = {
  target,
  uiFramework: framework,
  layout: 'scaffold',
  screenMap: [],
  stateStrategy: 'x',
  persistenceMap: [],
  integrationMap: [],
  deviations: [],
}
const config = MpfConfig.parse({})
const adapter = getTargetAdapter(target)
if (!adapter) {
  console.log(`[adapter] none for ${target}`)
  process.exit(1)
}
const avail = await adapter.available(config, process.env)
console.log('[available]', avail.ok, avail.reason ?? '')
if (!avail.ok) process.exit(1)

/** A one-function core, filled the way the extraction worker would, built for real. */
async function buildSampleCore(): Promise<CoreHandoff> {
  const tools = await rustTools(config, process.env)
  if (!tools || !(await hasWasmTarget(tools))) {
    console.log('[core] cargo with the wasm32-unknown-unknown target is required for --core')
    process.exit(1)
  }
  const crate = join(dir, 'core')
  const files = coreFiles({
    appName: spec.name,
    functions: [
      {
        name: 'clampCount',
        description: 'The count never drops below zero',
        inputSchema: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
        },
        outputSchema: { type: 'integer' },
        sourceSymbols: ['main.js:clampCount'],
      },
    ],
  })
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(crate, rel)), { recursive: true })
    writeFileSync(join(crate, rel), content)
  }
  writeFileSync(
    join(crate, 'src/api/clamp_count.rs'),
    `use crate::CoreResult;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct Input { count: i64 }

pub fn call(input: Value) -> CoreResult {
    let req: Input = serde_json::from_value(input)?;
    Ok(json!(req.count.max(0)))
}
`,
  )
  writeVectorSets(crate, [
    {
      function: 'clampCount',
      vectors: [
        { id: 'positive', input: { count: 3 }, expected: 3, provenance: 'derived' },
        { id: 'zero', input: { count: 0 }, expected: 0, provenance: 'derived' },
        { id: 'negative', input: { count: -2 }, expected: 0, provenance: 'derived' },
        {
          id: 'large',
          input: { count: 9007199254740991 },
          expected: 9007199254740991,
          provenance: 'derived',
        },
      ],
    },
  ])
  const t = Date.now()
  const build = await buildCoreWasm({ cwd: crate, tools })
  if (!build.ok || !build.wasm) {
    console.log('[core] build failed', JSON.stringify(build.diagnostics, null, 2))
    process.exit(1)
  }
  const test = await testCore({ cwd: crate, tools })
  console.log(
    `[core] built ${build.wasm} and cargo test ${test.ok ? 'passed' : `failed: ${test.failures.join('; ')}`} in ${Math.round((Date.now() - t) / 1000)}s`,
  )
  if (!test.ok) process.exit(1)
  return {
    wasm: join(crate, build.wasm),
    manifest: CoreManifest.parse(JSON.parse(readFileSync(join(crate, 'manifest.json'), 'utf8'))),
    vectorsDir: join(crate, 'vectors'),
  }
}

const core = withCore ? await buildSampleCore() : undefined

const ctx: TargetContext = {
  run,
  workspace: join(dir, target),
  spec,
  behaviors,
  plan,
  core,
  config,
  env: avail.env,
  signal: new AbortController().signal,
  log: (m) => console.log('[log]', m),
  onOutput: (c) => process.stdout.write(c),
}
mkdirSync(ctx.workspace, { recursive: true })
const t0 = Date.now()
const s = await adapter.scaffold(ctx)
console.log(`[scaffold] ${s.files.length} files in ${Date.now() - t0} ms`)
const b = await adapter.build(ctx)
console.log(`[build] ok=${b.ok} in ${Math.round(b.durationMs / 1000)}s product=${b.product ?? '-'}`)
if (!b.ok) {
  console.log(JSON.stringify(b.diagnostics, null, 2))
  process.exit(1)
}
const u = await adapter.unitTest(ctx)
console.log(`[unit] ${u.status} ${u.summary.passed}/${u.summary.total} ${u.skipReason ?? ''}`)
for (const c of u.cases.filter((x) => x.status !== 'pass'))
  console.log(`  [unit:${c.status}] ${c.name}: ${(c.message ?? '').slice(0, 600)}`)
if (core) {
  const parity = u.cases.filter((c) => /parity/i.test(`${c.id} ${c.name}`))
  console.log(
    `[parity] ${parity.length} case(s): ${parity.map((c) => `${c.name}=${c.status}`).join(', ') || 'none found in the unit results'}`,
  )
}
if (e2e) {
  const flows = await adapter.compileFlows(ctx)
  console.log('[flows]', JSON.stringify(flows))
  const r = await adapter.e2e(ctx, flows)
  console.log('[launch]', r.launch.status, r.launch.cases[0]?.message ?? '')
  console.log('[flows]', r.flows.status, JSON.stringify(r.flows.summary), r.flows.skipReason ?? '')
  console.log('[screenshots]', r.screenshots.map((x) => x.file).join(', '))
}
console.log('[workspace]', ctx.workspace)
