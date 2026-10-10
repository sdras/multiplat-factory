import { join } from 'pathe'
import type { MpfConfig } from '@mpf/core'
import { which } from '../exec.ts'
import { resolveJavaHome } from '../toolchain/checks/android.ts'

export interface MaestroTools {
  bin: string
  env: NodeJS.ProcessEnv
}

/**
 * Maestro is a JVM tool: it needs a JDK on both iOS and Android hosts. Resolve the
 * binary and a supported JDK generically so neither adapter carries machine paths.
 */
export async function maestroTools(
  config: MpfConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MaestroTools | undefined> {
  const bin = config.toolchain.maestro ?? (await which('maestro', env))
  if (!bin) return undefined
  const javaHome = await resolveJavaHome({
    env,
    platform: process.platform,
    toolchain: config.toolchain,
  })
  const merged: NodeJS.ProcessEnv = { ...env }
  if (javaHome) {
    merged.JAVA_HOME = javaHome
    merged.PATH = [join(javaHome, 'bin'), env.PATH ?? ''].filter(Boolean).join(':')
  }
  return { bin, env: merged }
}
