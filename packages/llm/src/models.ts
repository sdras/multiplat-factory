import type { Effort, MpfConfig } from '@mpf/core'

export type ModelRole = 'generate' | 'critic' | 'cheap'

export const DEFAULT_MODELS: Record<ModelRole, string> = {
  generate: 'claude-opus-5',
  critic: 'claude-opus-5',
  cheap: 'claude-sonnet-5',
}

export function resolveModel(role: ModelRole, config?: Pick<MpfConfig, 'models'>): string {
  return config?.models?.[role] ?? DEFAULT_MODELS[role]
}

export type { Effort }
