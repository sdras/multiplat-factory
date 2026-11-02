import type { MpfConfig, ToolchainCheck, ToolchainReport } from '@mpf/core'
import { androidCheck, javaCheck } from './checks/android.ts'
import {
  gitCheck,
  gradleCheck,
  maestroCheck,
  nodeCheck,
  packageManagerCheck,
  rustCheck,
} from './checks/basics.ts'
import { llmCheck } from './checks/llm.ts'
import { playwrightCheck } from './checks/playwright.ts'
import { xcodeCheck } from './checks/xcode.ts'
import type { CheckContext, CheckFn } from './types.ts'

export const ALL_CHECKS: CheckFn[] = [
  nodeCheck,
  gitCheck,
  packageManagerCheck,
  llmCheck,
  xcodeCheck,
  javaCheck,
  androidCheck,
  gradleCheck,
  rustCheck,
  maestroCheck,
  playwrightCheck,
]

export async function runDoctor(
  config: MpfConfig,
  env: NodeJS.ProcessEnv = process.env,
  checks: CheckFn[] = ALL_CHECKS,
): Promise<ToolchainReport> {
  const ctx: CheckContext = {
    env,
    platform: process.platform,
    toolchain: config.toolchain,
    llm: config.llm,
    models: config.models,
  }
  const results = await Promise.all(
    checks.map(async (c) => {
      try {
        return await c(ctx)
      } catch (err) {
        return {
          id: c.name || 'check',
          label: c.name || 'check',
          status: 'warn' as const,
          detail: `check crashed: ${(err as Error).message}`,
          affects: [],
        }
      }
    }),
  )
  return {
    generatedAt: new Date().toISOString(),
    host: { os: process.platform, arch: process.arch, node: process.versions.node },
    checks: results,
    availableTargets: deriveTargets(results),
    llmBackend: deriveLlm(results),
  }
}

function byId(checks: ToolchainCheck[], id: string) {
  return checks.find((c) => c.id === id)
}

export function deriveTargets(checks: ToolchainCheck[]): ToolchainReport['availableTargets'] {
  const out: ToolchainReport['availableTargets'] = []
  const node = byId(checks, 'node')?.status === 'ok'
  if (node && byId(checks, 'pm')?.status === 'ok') out.push('web')
  if (node && byId(checks, 'xcode')?.status !== 'missing' && byId(checks, 'xcode')) out.push('ios')
  if (
    node &&
    byId(checks, 'java')?.status === 'ok' &&
    byId(checks, 'android') &&
    byId(checks, 'android')?.status !== 'missing'
  )
    out.push('android')
  return out
}

export function deriveLlm(checks: ToolchainCheck[]): ToolchainReport['llmBackend'] {
  const c = byId(checks, 'llm')
  if (!c || c.status === 'missing') return 'none'
  if (c.version === 'messages') return 'messages'
  if (c.version === 'openai-compatible') return 'openai-compatible'
  return 'agent-sdk'
}
