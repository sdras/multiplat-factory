import type { MpfConfig, ToolchainCheck } from '@mpf/core'

export interface CheckContext {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  toolchain: MpfConfig['toolchain']
}

export type CheckFn = (ctx: CheckContext) => Promise<ToolchainCheck>

export function ok(
  id: string,
  label: string,
  detail: string,
  extra: Partial<ToolchainCheck> = {},
): ToolchainCheck {
  return { id, label, status: 'ok', detail, affects: [], ...extra }
}

export function warn(
  id: string,
  label: string,
  detail: string,
  extra: Partial<ToolchainCheck> = {},
): ToolchainCheck {
  return { id, label, status: 'warn', detail, affects: [], ...extra }
}

export function missing(
  id: string,
  label: string,
  detail: string,
  extra: Partial<ToolchainCheck> = {},
): ToolchainCheck {
  return { id, label, status: 'missing', detail, affects: [], ...extra }
}
