import type { MpfConfig, ToolchainCheck } from '@mpf/core'

export interface CheckContext {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  toolchain: MpfConfig['toolchain']
  /** The LLM settings the factory would run with; the model-access check resolves a backend from them. */
  llm: MpfConfig['llm']
  /** Per-role model overrides from the config; unset roles take the provider's defaults. */
  models: MpfConfig['models']
  /** Tests inject a fake; checks default to `globalThis.fetch` when it is left undefined. */
  fetch?: typeof globalThis.fetch
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
