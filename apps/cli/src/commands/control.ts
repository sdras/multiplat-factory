import { defineCommand } from 'citty'
import { join } from 'pathe'
import type { Artifact, Run, Stage } from '@mpf/core'
import { api, config, ensureDaemon, log } from './shared.ts'

async function withDaemon<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const cfg = await config()
  const { url, embedded } = await ensureDaemon(cfg)
  try {
    return await fn(url)
  } finally {
    await embedded?.close()
  }
}

export const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show a run and its stages' },
  args: { run: { type: 'positional', description: 'Run id', required: true } },
  async run({ args }) {
    await withDaemon(async (url) => {
      const { run, stages, artifacts } = await api<{
        run: Run
        stages: Stage[]
        artifacts: Artifact[]
      }>(url, `/runs/${args.run}`)
      log.info(
        `${run.id} ${run.status} $${run.costUsd.toFixed(2)} ${run.source.locator} -> ${run.targets.join(',')}`,
      )
      for (const s of stages) {
        const extra = s.error ? ` (${s.error.message})` : s.skipReason ? ` (${s.skipReason})` : ''
        console.log(`  ${s.status.padEnd(13)} ${s.id}${extra}`)
      }
      if (run.summary) console.log(`\nResult: ${run.summary}`)
      // The report may have run more than once; show the latest PORT.md per target.
      const readmes = new Map(
        artifacts
          .filter((a) => a.kind === 'port-readme')
          .map((a) => [String(a.meta.target ?? ''), a]),
      )
      for (const [target, a] of readmes)
        console.log(`  ${target.padEnd(8)} ${join(run.runDir, a.relPath)}`)
    })
  },
})

export const resumeCommand = defineCommand({
  meta: { name: 'resume', description: 'Resume a paused run (also continues past a --until stop)' },
  args: { run: { type: 'positional', description: 'Run id', required: true } },
  async run({ args }) {
    await withDaemon(async (url) => {
      await api(url, `/runs/${args.run}/resume`, { method: 'POST' })
      log.success(`resumed ${args.run}; follow it at ${url}/runs/${args.run}`)
    })
  },
})

export const answerCommand = defineCommand({
  meta: {
    name: 'answer',
    description: 'Answer a stage that is waiting for a decision (approve, reject, accept)',
  },
  args: {
    run: { type: 'positional', description: 'Run id', required: true },
    stage: {
      type: 'positional',
      description: 'Stage id, e.g. plan or critique:android',
      required: true,
    },
    choice: { type: 'positional', description: 'Choice id offered by the stage', required: true },
    note: { type: 'string', description: 'Optional note for the worker' },
  },
  async run({ args }) {
    await withDaemon(async (url) => {
      await api(url, `/runs/${args.run}/stages/${args.stage}/answer`, {
        method: 'POST',
        body: JSON.stringify({ choice: args.choice, note: args.note }),
      })
      log.success(`answered ${args.stage} with "${args.choice}"`)
    })
  },
})

export const rerunCommand = defineCommand({
  meta: { name: 'rerun', description: 'Re-run one stage and everything downstream of it' },
  args: {
    run: { type: 'positional', description: 'Run id', required: true },
    stage: { type: 'positional', description: 'Stage id', required: true },
  },
  async run({ args }) {
    await withDaemon(async (url) => {
      await api(url, `/runs/${args.run}/stages/${args.stage}/rerun`, { method: 'POST' })
      log.success(
        `re-running ${args.stage} and its dependents; follow it at ${url}/runs/${args.run}`,
      )
    })
  },
})

export const instructCommand = defineCommand({
  meta: { name: 'instruct', description: 'Queue an instruction for a running or upcoming stage' },
  args: {
    run: { type: 'positional', description: 'Run id', required: true },
    stage: { type: 'positional', description: 'Stage id', required: true },
    text: { type: 'positional', description: 'Instruction text', required: true },
  },
  async run({ args }) {
    await withDaemon(async (url) => {
      await api(url, `/runs/${args.run}/stages/${args.stage}/instruct`, {
        method: 'POST',
        body: JSON.stringify({ text: args.text }),
      })
      log.success(`instruction queued for ${args.stage}`)
    })
  },
})
