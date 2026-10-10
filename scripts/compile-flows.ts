/**
 * Recompile one target's end-to-end flows for an existing run from its BehaviorSpec,
 * without touching a device. Handy after changing the flow compiler or a target adapter.
 *
 *   MPF_HOME=... pnpm tsx scripts/compile-flows.ts <runId> <target>
 */
import { readFileSync } from 'node:fs'
import { join } from 'pathe'
import {
  SqliteRunStore,
  dbPath,
  loadConfig,
  mpfHome,
  type AppSpec,
  type BehaviorSpec,
  type PortPlan,
  type Target,
} from '@mpf/core'
import { getTargetAdapter, type TargetContext } from '@mpf/adapters'

const [runId, target] = process.argv.slice(2) as [string?, Target?]
if (!runId || !target) {
  console.error('usage: compile-flows <runId> <target>')
  process.exit(2)
}
const home = mpfHome()
const store = new SqliteRunStore(dbPath(home))
const run = store.getRun(runId)
if (!run) {
  console.error(`run ${runId} not found in ${home}`)
  process.exit(1)
}
const adapter = getTargetAdapter(target)
if (!adapter) {
  console.error(`no target adapter for ${target}`)
  process.exit(1)
}
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(join(run.runDir, `${name}.json`), 'utf8')) as T
const spec = read<AppSpec>('appspec')
const behaviors = read<BehaviorSpec>('behaviorspec')
const plan = read<PortPlan>('portplan').targets.find((t) => t.target === target)
if (!plan) {
  console.error(`the plan has no ${target} target`)
  process.exit(1)
}
const ctx: TargetContext = {
  run,
  spec,
  behaviors,
  plan,
  workspace: join(run.runDir, 'workspace', target),
  config: await loadConfig(),
  env: process.env,
  signal: new AbortController().signal,
  log: (m) => console.log(m),
}
const flows = await adapter.compileFlows(ctx)
for (const f of flows)
  console.log(
    `${f.behaviorId}: ${f.path ?? 'not runnable'}${f.unverifiable ? ` (${f.unverifiable})` : ''}`,
  )
console.log(
  `${flows.filter((f) => f.path).length}/${flows.length} flows compiled into ${ctx.workspace}`,
)
