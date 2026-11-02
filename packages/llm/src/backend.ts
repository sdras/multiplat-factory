import { detectClaudeAccess, type ClaudeAccess } from '@mpf/core'

export type LlmBackend = ClaudeAccess

/** Which Claude access a plain Node process has; `resolveLlm` in `@mpf/core` chooses the backend. */
export function detectBackend(env: NodeJS.ProcessEnv = process.env): LlmBackend {
  return detectClaudeAccess(env)
}
