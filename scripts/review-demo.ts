/** Isolated review UI demo. Usage: pnpm tsx scripts/review-demo.ts /path/to/screenshot.png [port] */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { MpfConfig, PortPlan, newId } from '@mpf/core'
import { startDaemon } from '../apps/server/src/daemon.ts'
const screenshot = process.argv[2]
if (!screenshot) throw new Error('Provide a PNG screenshot for the isolated preview.')
const dataDir = mkdtempSync(join(tmpdir(), 'mpf-review-demo-'))
const daemon = await startDaemon({
  config: MpfConfig.parse({ server: { port: Number(process.argv[3] ?? 4312) } }),
  dataDir,
  registry: {},
  dashboardDir: resolve('apps/dashboard/.output/public'),
})
const run = daemon.orchestrator.createRun({
  source: { locator: './review-demo' },
  targets: ['web'],
  options: { fake: true, coreMode: 'never', budgetUsd: 20 },
})
mkdirSync(join(run.runDir, 'source'), { recursive: true })
writeFileSync(
  join(run.runDir, 'source', 'README.md'),
  'Isolated review demo. No model or toolchain calls.',
)
const plan = PortPlan.parse({
  targets: [
    {
      target: 'web',
      uiFramework: 'React',
      layout: 'A responsive task list with filters and a desktop sidebar.',
      screenMap: [
        {
          screen: 'tasks',
          file: 'src/App.tsx',
          notes: 'Retain task creation, completion and filtering.',
        },
      ],
      stateStrategy: 'Local state with browser persistence',
      persistenceMap: [],
      integrationMap: [],
    },
  ],
  core: { enabled: false, rationale: 'The task list does not need shared compiled logic.' },
  testPlan: { unit: ['task operations'], e2e: ['add-task', 'filter-tasks'], parity: [] },
  estimate: { stages: 12, costUsd: 10, minutes: 6 },
  questionsForHuman: [],
})
writeFileSync(join(run.runDir, 'portplan.json'), JSON.stringify(plan))
for (const a of [
  {
    id: newId(),
    runId: run.id,
    stageId: 'plan',
    kind: 'portplan' as const,
    relPath: 'portplan.json',
    mime: 'application/json',
    createdAt: run.createdAt,
    meta: {},
  },
  ...(['source', 'web'] as const).map((target) => ({
    id: newId(),
    runId: run.id,
    stageId: target === 'source' ? 'observe' : 'test:web',
    kind: target === 'source' ? ('source-screenshot' as const) : ('target-screenshot' as const),
    relPath: `${target}.png`,
    mime: 'image/png',
    createdAt: run.createdAt,
    meta: { screenId: 'tasks', ...(target === 'web' ? { target } : {}) },
  })),
]) {
  if (a.mime === 'image/png') copyFileSync(resolve(screenshot), join(run.runDir, a.relPath))
  daemon.store.addArtifact(a)
  daemon.bus.emit(run.id, a.stageId, { type: 'artifact.added', artifact: a })
}
await daemon.orchestrator.start(run.id)
console.log(JSON.stringify({ url: `${daemon.url}/runs/${run.id}/tests`, runId: run.id, dataDir }))
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void daemon.close().then(() => process.exit(0))
  })
