import { defineCommand } from 'citty'
import { runDoctor } from '@mpf/harness'
import {
  defaultModelsFor,
  isTrustedModel,
  resolveLlm,
  type ModelConfig,
  type ToolchainCheck,
} from '@mpf/core'
import { describeProbe, probeModel } from '@mpf/llm'
import { config } from './shared.ts'

const ICON: Record<ToolchainCheck['status'], string> = { ok: '✔', warn: '▲', missing: '✘' }

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check toolchains and credentials; explain what each gap disables',
  },
  args: {
    json: { type: 'boolean', description: 'Print the report as JSON' },
    probe: {
      type: 'boolean',
      description:
        'Run a short tool task on each configured model that is not a known frontier tier (a few cents on a paid provider)',
    },
  },
  async run({ args }) {
    const cfg = await config()
    const report = await runDoctor(cfg)
    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log(
      `multiplat-factory doctor  (${report.host.os}/${report.host.arch}, node ${report.host.node})\n`,
    )
    for (const c of report.checks) {
      console.log(`${ICON[c.status]} ${c.label.padEnd(20)} ${c.detail}`)
      if (c.status !== 'ok' && c.fix) {
        const hint = c.fix.brew ?? c.fix.apt ?? c.fix.winget ?? c.fix.manual
        if (hint) console.log(`    fix: ${hint}`)
      }
    }
    console.log(`\nTargets available here: ${report.availableTargets.join(', ') || 'none'}`)
    console.log(`Model backend: ${report.llmBackend}`)
    const missing = report.checks.filter((c) => c.status === 'missing')
    if (missing.length) process.exitCode = 1
    if (args.probe) await probeConfiguredModels(cfg)
  },
})

/** The same check a run makes before its first worker, for every distinct configured model. */
async function probeConfiguredModels(cfg: Awaited<ReturnType<typeof config>>): Promise<void> {
  const llm = resolveLlm(cfg.llm)
  const models = { ...defaultModelsFor(llm), ...cfg.models }
  const roles = (['generate', 'critic', 'cheap'] as const).filter((r) => models[r])
  const byModel = new Map<string, Array<keyof ModelConfig>>()
  for (const role of roles)
    byModel.set(models[role]!, [...(byModel.get(models[role]!) ?? []), role])
  console.log('')
  for (const [model, forRoles] of byModel) {
    if (isTrustedModel(model)) {
      console.log(`${ICON.ok} ${model} (${forRoles.join(', ')}): a frontier tier, no probe needed`)
      continue
    }
    if (llm.backend === 'agent-sdk') {
      console.log(
        `${ICON.warn} ${model} (${forRoles.join(', ')}): not probed on the Claude backend`,
      )
      continue
    }
    const probe = await probeModel({ llm: cfg.llm, model, role: forRoles[0] })
    const icon = probe.level === 'ok' ? ICON.ok : probe.level === 'warn' ? ICON.warn : ICON.missing
    console.log(`${icon} ${describeProbe(probe)}`)
    if (probe.level === 'error') process.exitCode = 1
  }
}
