import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'pathe'
import type { MpfConfig } from '@mpf/core'
import { tryOutput, which } from '../exec.ts'

export interface RustTools {
  cargo: string
  rustup?: string
  /** Environment with the toolchain's bin directory first on PATH. */
  env: NodeJS.ProcessEnv
  version?: string
}

/**
 * Find cargo: config override, PATH, then the two places rustup installs to without
 * touching the shell profile (`~/.cargo/bin` from rustup.rs, `<brew prefix>/opt/rustup/bin`
 * from Homebrew). Never a hardcoded machine path.
 */
export async function rustTools(
  config: Pick<MpfConfig, 'toolchain'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RustTools | undefined> {
  const candidates: string[] = []
  if (config.toolchain.cargo) candidates.push(config.toolchain.cargo)
  const onPath = await which('cargo', env)
  if (onPath) candidates.push(onPath)
  candidates.push(join(env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', 'cargo'))
  const brew = env.HOMEBREW_PREFIX ?? (await tryOutput('brew', ['--prefix'], env))
  if (brew) candidates.push(join(brew, 'opt', 'rustup', 'bin', 'cargo'))
  candidates.push('/usr/local/opt/rustup/bin/cargo', '/opt/homebrew/opt/rustup/bin/cargo')
  const cargo = candidates.find((c) => existsSync(c))
  if (!cargo) return undefined
  const bin = dirname(cargo)
  const path = [bin, env.PATH ?? ''].filter(Boolean).join(delimiter)
  const toolEnv = { ...env, PATH: path }
  const rustupPath = join(bin, 'rustup')
  const rustup = existsSync(rustupPath) ? rustupPath : await which('rustup', toolEnv)
  const version = await tryOutput(cargo, ['--version'], toolEnv)
  return { cargo, rustup, env: toolEnv, version }
}

export async function hasWasmTarget(tools: RustTools): Promise<boolean> {
  if (!tools.rustup) return false
  const list = (await tryOutput(tools.rustup, ['target', 'list', '--installed'], tools.env)) ?? ''
  return list.includes('wasm32-unknown-unknown')
}
