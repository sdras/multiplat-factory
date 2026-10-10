import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { tryOutput, which } from '../../exec.ts'
import { type CheckFn, missing, ok, warn } from '../types.ts'

/**
 * Which LLM backend can run here:
 *  - messages: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile
 *  - agent-sdk: Claude Code is installed and logged in (the Agent SDK reuses that login)
 */
export const llmCheck: CheckFn = async ({ env }) => {
  const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)
  const profileDir = join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'anthropic')
  const hasProfile = existsSync(profileDir)
  const claude = await which('claude', env)
  let claudeLoggedIn: boolean
  let via = 'Claude Code login'
  if (claude) {
    const status = await tryOutput(claude, ['auth', 'status'], env, 20_000)
    claudeLoggedIn = parseLoggedIn(status)
  } else {
    // The Agent SDK bundles its own runtime, so a login counts even when the `claude` binary is not on PATH.
    claudeLoggedIn = await storedClaudeCredentials(env)
    if (claudeLoggedIn)
      via = 'Claude Code credentials (stored login; claude binary not on PATH in this shell)'
  }
  if (hasKey || hasProfile) {
    const via = hasKey ? 'API key in environment' : 'ant auth profile'
    const extra = claudeLoggedIn ? '; Claude Code login also available for workers' : ''
    return ok('llm', 'Claude access', `${via}${extra}`, {
      affects: ['llm'],
      // encode backend choice for the doctor summary
      version: 'messages',
    })
  }
  if (claudeLoggedIn) {
    return ok('llm', 'Claude access', `${via} (Agent SDK backend for workers and critic)`, {
      affects: ['llm'],
      version: 'agent-sdk',
    })
  }
  if (claude) {
    return warn(
      'llm',
      'Claude access',
      'Claude Code found but login could not be confirmed; run `claude` once to log in, or set ANTHROPIC_API_KEY',
      {
        affects: ['llm'],
        version: 'agent-sdk',
        fix: { manual: 'claude   # then /login' },
      },
    )
  }
  return missing('llm', 'Claude access', 'No API key, no ant profile, no Claude Code login', {
    affects: ['llm'],
    version: 'none',
    fix: {
      manual: 'export ANTHROPIC_API_KEY=...  or  npm i -g @anthropic-ai/claude-code && claude',
    },
  })
}

/** Claude Code keeps OAuth credentials in the macOS keychain or in ~/.claude/.credentials.json elsewhere. Never reads the secret. */
async function storedClaudeCredentials(env: NodeJS.ProcessEnv): Promise<boolean> {
  const home = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  if (existsSync(join(home, '.credentials.json'))) return true
  if (process.platform === 'darwin') {
    const found = await tryOutput(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      env,
      10_000,
    )
    return found !== undefined
  }
  return false
}

/** `claude auth status` prints JSON with `loggedIn`; older builds print prose. */
function parseLoggedIn(output: string | undefined): boolean {
  if (!output) return false
  try {
    const json = JSON.parse(output) as { loggedIn?: boolean }
    if (typeof json.loggedIn === 'boolean') return json.loggedIn
  } catch {
    /* not JSON */
  }
  return !/not logged in|no credentials|logged out/i.test(output)
}
