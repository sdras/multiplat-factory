import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { join } from 'pathe'

/**
 * Per-user data directory. Resolution order:
 *   $MPF_HOME -> $XDG_DATA_HOME/mpf -> ~/.mpf
 * Never inside the repo, never a hardcoded machine path.
 */
export function mpfHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MPF_HOME) return env.MPF_HOME
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'mpf')
  return join(homedir(), '.mpf')
}

export function runsDir(home = mpfHome()): string {
  return join(home, 'runs')
}

export function runDir(runId: string, home = mpfHome()): string {
  return join(runsDir(home), runId)
}

export function dbPath(home = mpfHome()): string {
  return join(home, 'mpf.sqlite')
}

export function cacheDir(home = mpfHome()): string {
  return join(home, 'cache')
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}
