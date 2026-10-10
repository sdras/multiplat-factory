import { existsSync } from 'node:fs'
import { join } from 'pathe'
import { runProcess } from '@mpf/harness'

export interface PackageManager {
  name: 'pnpm' | 'yarn' | 'bun' | 'npm'
  bin: string
  installArgs: string[]
  run(script: string, extra?: string[]): { command: string; args: string[] }
}

/** Pick the package manager from the lockfile; fall back to npm. */
export function detectPackageManager(dir: string): PackageManager {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    return {
      name: 'pnpm',
      bin: 'pnpm',
      installArgs: ['install'],
      run: (s, x = []) => ({ command: 'pnpm', args: ['run', s, ...x] }),
    }
  }
  if (existsSync(join(dir, 'yarn.lock'))) {
    return {
      name: 'yarn',
      bin: 'yarn',
      installArgs: ['install'],
      run: (s, x = []) => ({ command: 'yarn', args: ['run', s, ...x] }),
    }
  }
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) {
    return {
      name: 'bun',
      bin: 'bun',
      installArgs: ['install'],
      run: (s, x = []) => ({ command: 'bun', args: ['run', s, ...(x.length ? ['--', ...x] : [])] }),
    }
  }
  return {
    name: 'npm',
    bin: 'npm',
    installArgs: ['install', '--no-audit', '--no-fund'],
    run: (s, x = []) => ({ command: 'npm', args: ['run', s, ...(x.length ? ['--', ...x] : [])] }),
  }
}

/** Install dependencies once, only when node_modules is missing. */
export async function ensureInstalled(
  dir: string,
  log: (m: string) => void,
  signal?: AbortSignal,
): Promise<PackageManager> {
  const pm = detectPackageManager(dir)
  if (existsSync(join(dir, 'node_modules'))) return pm
  log(`installing dependencies with ${pm.name}`)
  const r = await runProcess({
    command: pm.bin,
    args: pm.installArgs,
    cwd: dir,
    timeoutMs: 10 * 60_000,
    signal,
    env: { ...process.env, CI: '1' },
  })
  if (r.exitCode !== 0)
    throw new Error(`${pm.name} install failed (exit ${r.exitCode}):\n${r.stderr.slice(-1500)}`)
  return pm
}

/** Absolute path of a local binary under node_modules/.bin, if present. */
export function localBin(dir: string, name: string): string | undefined {
  const p = join(dir, 'node_modules', '.bin', name)
  return existsSync(p) ? p : undefined
}
