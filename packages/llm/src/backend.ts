import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'pathe'

export type LlmBackend = 'messages' | 'agent-sdk' | 'none'

/**
 * Which backend a plain Node process can use right now.
 * `messages` needs an API key or an `ant auth login` profile.
 * `agent-sdk` reuses a Claude Code login through the bundled runtime.
 * Callers that need certainty should run `mpf doctor`, which also probes Claude Code.
 */
export function detectBackend(env: NodeJS.ProcessEnv = process.env): LlmBackend {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'messages'
  const profileDir = join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'anthropic')
  if (existsSync(profileDir)) return 'messages'
  const claudeDir = join(homedir(), '.claude')
  if (existsSync(claudeDir)) return 'agent-sdk'
  return 'none'
}
