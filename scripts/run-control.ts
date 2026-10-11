/**
 * Drive an existing run without the daemon (handy while iterating on stages).
 *
 *   MPF_HOME=... pnpm tsx scripts/run-control.ts <runId> resume [--until <stage>] [--budget <usd>] [--core auto|always|never]
 *   MPF_HOME=... pnpm tsx scripts/run-control.ts <runId> rerun <stageId> [--approve] [--until <stage>]
 *   MPF_HOME=... pnpm tsx scripts/run-control.ts <runId> answer <stageId> <choice> [note]
 *   MPF_HOME=... pnpm tsx scripts/run-control.ts <runId> status
 *   MPF_HOME=... pnpm tsx scripts/run-control.ts new <source> --to ios,android [--until <stage>] [--budget <usd>] [--core auto|always|never] [--yes]
 */
import { RunEventBus, SqliteRunStore, dbPath, loadConfig, mpfHome, type Event } from '@mpf/core'
import { Orchestrator, realRegistry } from '@mpf/orchestrator'

const argv = process.argv.slice(2)
const creating = argv[0] === 'new'
const [runId, action, ...rest] = creating ? ['', 'new', ...argv.slice(1)] : argv
if ((!runId && !creating) || !action) {
  console.error(
    'usage: run-control <runId> <resume|rerun <stageId>|answer <stageId> <choice> [note]|status> [--approve] [--until <stage>]',
  )
  process.exit(2)
}
const flag = (name: string) => {
  const i = rest.indexOf(name)
  return i >= 0 ? (rest[i + 1] ?? '') : undefined
}
const approve = rest.includes('--approve')
const until = flag('--until')
const VALUE_FLAGS = ['--until', '--to', '--budget', '--core']
const positional = rest.filter(
  (a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(rest[i - 1] ?? ''),
)

const config = await loadConfig()
const home = mpfHome()
const store = new SqliteRunStore(dbPath(home))
const bus = new RunEventBus(store)
bus.subscribe(runId, (e: Event) => {
  if (e.type === 'stage.status' && !['pending', 'queued'].includes(e.stage.status)) {
    console.log(
      `[${e.stage.status}] ${e.stage.id}${e.stage.error ? ` (${e.stage.error.message})` : ''}${e.stage.skipReason ? ` (${e.stage.skipReason})` : ''}`,
    )
  }
  if (e.type === 'log' && e.level !== 'debug') console.log(`[${e.level}] ${e.message}`)
  if (e.type === 'human.required') console.log(`[human] ${e.reason}`)
  if (e.type === 'cost.update') console.log(`[cost] run total $${e.runCostUsd.toFixed(2)}`)
  if (e.type === 'test.result')
    console.log(
      `[test] ${e.result.target} ${e.result.kind}: ${e.result.status} ${e.result.summary.passed}/${e.result.summary.total}`,
    )
  if (e.type === 'build.result')
    console.log(`[build] ${e.ok ? 'ok' : `failed (${e.errors} errors)`}`)
})
const orch = new Orchestrator({ store, bus, config, registry: realRegistry(config), dataDir: home })

if (creating) {
  // A new run driven by this process on the current code, without the daemon.
  const { resolve } = await import('pathe')
  const source = positional[0]
  const to = flag('--to')
  if (!source || !to) throw new Error('new needs <source> --to <targets>')
  const budget = flag('--budget')
  const created = orch.createRun({
    source: { locator: /^(?:https?:|git@)/.test(source) ? source : resolve(source) },
    targets: to
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean) as never,
    options: {
      ...(budget ? { budgetUsd: Number(budget) } : {}),
      ...(flag('--core') ? { coreMode: flag('--core') as 'auto' | 'always' | 'never' } : {}),
      ...(rest.includes('--yes')
        ? { checkpoints: { planApproval: false, beforeFixLoop: false } }
        : {}),
      ...(until ? { until } : {}),
    },
  })
  console.log(`[run] ${created.id} ${created.source.locator} -> ${created.targets.join(',')}`)
  bus.subscribe(created.id, (e: Event) => {
    if (e.type === 'stage.status' && !['pending', 'queued'].includes(e.stage.status))
      console.log(
        `[${e.stage.status}] ${e.stage.id}${e.stage.error ? ` (${e.stage.error.message})` : ''}${e.stage.skipReason ? ` (${e.stage.skipReason})` : ''}`,
      )
    if (e.type === 'log' && e.level !== 'debug') console.log(`[${e.level}] ${e.message}`)
    if (e.type === 'cost.update') console.log(`[cost] run total $${e.runCostUsd.toFixed(2)}`)
    if (e.type === 'test.result')
      console.log(
        `[test] ${e.result.target} ${e.result.kind}: ${e.result.status} ${e.result.summary.passed}/${e.result.summary.total}`,
      )
  })
  await orch.start(created.id)
  const done = store.getRun(created.id)!
  console.log(`[run] ${done.status} $${done.costUsd.toFixed(2)}`)
  process.exit(done.status === 'succeeded' || done.status === 'paused' ? 0 : 1)
}

const run = store.getRun(runId)
if (!run) {
  console.error(`run ${runId} not found in ${home}`)
  process.exit(1)
}
const budget = flag('--budget')
if (until !== undefined || budget || flag('--core')) {
  store.updateRun({
    ...run,
    options: {
      ...run.options,
      ...(until !== undefined ? { until: until || undefined } : {}),
      ...(budget ? { budgetUsd: Number(budget) } : {}),
      ...(flag('--core') ? { coreMode: flag('--core') as 'auto' | 'always' | 'never' } : {}),
    },
  })
}

async function autoApprove() {
  const current = store.getRun(runId)!
  if (current.status !== 'waiting_human' || !approve) return
  const waiting = store.listStages(runId).find((s) => s.status === 'waiting_human')
  if (!waiting) return
  // A plan is approved; a critic escalation is accepted (what is left becomes a documented deviation).
  const choice = waiting.kind === 'critique' ? 'accept' : 'approve'
  console.log(`[auto] answering ${waiting.id} with ${choice}`)
  await orch.answer(runId, waiting.id, choice)
}

switch (action) {
  case 'status':
    console.log(
      JSON.stringify(
        {
          run: store.getRun(runId),
          stages: store.listStages(runId).map((s) => `${s.id}: ${s.status}`),
        },
        null,
        2,
      ),
    )
    break
  case 'resume':
    await orch.resume(runId)
    await autoApprove()
    break
  case 'rerun': {
    const stageId = positional[0]
    if (!stageId) throw new Error('rerun needs a stageId')
    await orch.rerun(runId, stageId)
    await autoApprove()
    break
  }
  case 'answer': {
    const [stageId, choice, note] = positional
    if (!stageId || !choice) throw new Error('answer needs <stageId> <choice>')
    await orch.answer(runId, stageId, choice, note)
    break
  }
  default:
    throw new Error(`unknown action ${action}`)
}
const final = store.getRun(runId)!
console.log(`run ${runId}: ${final.status}, cost $${final.costUsd.toFixed(2)}`)
store.close()
process.exit(['succeeded', 'paused', 'waiting_human', 'partial'].includes(final.status) ? 0 : 1)
