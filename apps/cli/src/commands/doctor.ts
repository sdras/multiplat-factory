import { defineCommand } from 'citty'
import { runDoctor } from '@mpf/harness'
import type { ToolchainCheck } from '@mpf/core'
import { config } from './shared.ts'

const ICON: Record<ToolchainCheck['status'], string> = { ok: '✔', warn: '▲', missing: '✘' }

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check toolchains and credentials; explain what each gap disables',
  },
  args: {
    json: { type: 'boolean', description: 'Print the report as JSON' },
  },
  async run({ args }) {
    const report = await runDoctor(await config())
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
    console.log(`Claude backend: ${report.llmBackend}`)
    const missing = report.checks.filter((c) => c.status === 'missing')
    if (missing.length) process.exitCode = 1
  },
})
