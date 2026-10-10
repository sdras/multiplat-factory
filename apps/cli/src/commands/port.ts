import { defineCommand } from 'citty'
import { resolve } from 'pathe'
import { STAGE_CATALOG, applyEvent, emptyView, type Event, type Run, type RunView } from '@mpf/core'
import { api, config, ensureDaemon, log } from './shared.ts'

export const portCommand = defineCommand({
  meta: { name: 'port', description: 'Port a source app to one or more targets' },
  args: {
    source: {
      type: 'positional',
      description: 'Path or git URL of the source app',
      required: true,
    },
    to: { type: 'string', description: 'Comma-separated targets: web,ios,android', required: true },
    budget: { type: 'string', description: 'Budget cap in USD' },
    core: { type: 'string', description: 'Shared WASM core: auto | always | never' },
    yes: { type: 'boolean', description: 'Skip human checkpoints (auto-approve the plan)' },
    fake: {
      type: 'boolean',
      description: 'Run the fake pipeline (no LLM, no toolchains) to exercise the factory',
    },
    detach: { type: 'boolean', description: 'Create the run and return immediately' },
    until: {
      type: 'string',
      description: 'Stop after this stage kind (e.g. plan) and leave the run paused',
    },
    'web-framework': {
      type: 'string',
      description:
        'Web target flavor: vanilla | react | vue | svelte (default: what the plan suggests)',
    },
  },
  async run({ args }) {
    const cfg = await config()
    const targets = String(args.to)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const locator = /^(?:https?:|git@)/.test(args.source) ? args.source : resolve(args.source)
    const { url, embedded } = await ensureDaemon(cfg)
    try {
      const run = await api<Run>(url, '/runs', {
        method: 'POST',
        body: JSON.stringify({
          source: { locator },
          targets,
          options: {
            ...(args.budget ? { budgetUsd: Number(args.budget) } : {}),
            ...(args.core ? { coreMode: args.core } : {}),
            ...(args.yes ? { checkpoints: { planApproval: false, beforeFixLoop: false } } : {}),
            ...(args.until ? { until: args.until } : {}),
            ...(args['web-framework'] ? { webFramework: args['web-framework'] } : {}),
            fake: Boolean(args.fake),
          },
        }),
      })
      log.success(`run ${run.id} created (${run.targets.join(', ')})`)
      log.info(`dashboard: ${url}/runs/${run.id}`)
      if (args.detach) return
      const view = await follow(url, run.id)
      printSummary(view)
      const stoppedAsAsked = args.until && view.run?.status === 'paused'
      if (stoppedAsAsked)
        log.success(
          `stopped after "${args.until}" as requested; resume from the dashboard to continue`,
        )
      if (view.run?.status !== 'succeeded' && !stoppedAsAsked) process.exitCode = 1
    } finally {
      await embedded?.close()
    }
  },
})

/** Stream events until the run settles; print compact progress to the terminal. */
async function follow(url: string, runId: string): Promise<RunView> {
  const res = await fetch(`${url}/api/v1/runs/${runId}/events?after=-1`)
  if (!res.ok || !res.body) throw new Error(`cannot stream events: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let view = emptyView()
  const seenStage = new Map<string, string>()
  const settled = new Set([
    'succeeded',
    'partial',
    'failed',
    'cancelled',
    'waiting_human',
    'paused',
  ])
  outer: for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n')
      if (!data || frame.includes('event: ping')) continue
      const event = JSON.parse(data) as Event
      view = applyEvent(view, event)
      report(event, seenStage)
      if (event.type === 'run.status' && settled.has(event.run.status) && event.seq > 0) {
        if (event.run.status === 'waiting_human') {
          log.warn(
            `run is waiting for you: open ${url}/runs/${runId} to answer, or re-run with --yes`,
          )
        }
        break outer
      }
    }
  }
  await reader.cancel().catch(() => {})
  return view
}

function report(e: Event, seen: Map<string, string>) {
  switch (e.type) {
    case 'stage.status': {
      const prev = seen.get(e.stage.id)
      if (prev === e.stage.status) return
      seen.set(e.stage.id, e.stage.status)
      if (e.stage.status === 'pending' || e.stage.status === 'queued') return
      const title =
        STAGE_CATALOG[e.stage.kind].title + (e.stage.target ? ` [${e.stage.target}]` : '')
      const extra = e.stage.skipReason
        ? ` (${e.stage.skipReason})`
        : e.stage.error
          ? ` (${e.stage.error.message})`
          : ''
      log.info(`${e.stage.status.padEnd(13)} ${title}${extra}`)
      return
    }
    case 'log':
      if (e.level === 'warn' || e.level === 'error') log[e.level](e.message)
      return
    case 'human.required':
      log.warn(`needs a decision: ${e.reason}`)
      return
    case 'cost.update':
      return
    default:
      return
  }
}

function printSummary(view: RunView) {
  const run = view.run
  if (!run) return
  const counts = view.stages.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1
    return acc
  }, {})
  console.log('')
  log.info(`run ${run.id}: ${run.status}  cost $${run.costUsd.toFixed(2)}`)
  log.info(
    `stages: ${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  )
  if (view.artifacts.length)
    log.info(`artifacts: ${view.artifacts.map((a) => a.relPath).join(', ')}`)
}
