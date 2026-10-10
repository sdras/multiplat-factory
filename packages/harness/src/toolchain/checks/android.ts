import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { tryOutput } from '../../exec.ts'
import { type CheckContext, type CheckFn, missing, ok, warn } from '../types.ts'

/** JDK majors the pinned Gradle/AGP pair can run on. Newer JDKs fail inside Gradle with an opaque error. */
export const JDK_MIN = 17
export const JDK_MAX = 24

export interface JavaCandidate {
  home: string
  major: number
  versionLine: string
}

/** Every JDK we can find, explicit settings first. Never assumes one install location. */
export async function findJavaCandidates(ctx: CheckContext): Promise<JavaCandidate[]> {
  const { env, toolchain, platform } = ctx
  const homes: string[] = []
  const add = (h: string | undefined) => {
    if (h && existsSync(join(h, 'bin', 'java')) && !homes.includes(h)) homes.push(h)
  }
  add(toolchain.javaHome)
  add(env.JAVA_HOME)
  if (platform === 'darwin') {
    for (const v of ['21', '17', '24', '23', '22', '17+'])
      add(await tryOutput('/usr/libexec/java_home', ['-v', v], env))
    for (const formula of ['openjdk@21', 'openjdk@17', 'openjdk'])
      add(await tryOutput('brew', ['--prefix', formula], env))
  }
  if (platform === 'linux') {
    for (const base of ['/usr/lib/jvm', '/opt/java']) {
      if (existsSync(base)) for (const d of readdirSync(base)) add(join(base, d))
    }
  }
  const out: JavaCandidate[] = []
  for (const home of homes) {
    const versionLine = await javaVersionLine(join(home, 'bin', 'java'), env)
    if (!versionLine) continue
    const major = Number(/version "(\d+)/.exec(versionLine)?.[1] ?? 0)
    out.push({ home, major, versionLine })
  }
  return out
}

/** Prefer the newest supported JDK; fall back to an explicit but unsupported one so the doctor can explain. */
export async function resolveJavaHome(ctx: CheckContext): Promise<string | undefined> {
  const candidates = await findJavaCandidates(ctx)
  const supported = candidates
    .filter((c) => c.major >= JDK_MIN && c.major <= JDK_MAX)
    .sort((a, b) => b.major - a.major)
  return supported[0]?.home ?? candidates[0]?.home
}

export const javaCheck: CheckFn = async (ctx) => {
  const candidates = await findJavaCandidates(ctx)
  if (!candidates.length) {
    return missing(
      'java',
      `Java (JDK ${JDK_MIN}-${JDK_MAX})`,
      'No JDK found (JAVA_HOME unset and none discoverable)',
      {
        affects: ['android'],
        fix: {
          brew: 'brew install openjdk@21',
          apt: 'sudo apt install openjdk-21-jdk',
          winget: 'winget install EclipseAdoptium.Temurin.21.JDK',
        },
      },
    )
  }
  const supported = candidates
    .filter((c) => c.major >= JDK_MIN && c.major <= JDK_MAX)
    .sort((a, b) => b.major - a.major)
  const best = supported[0]
  if (!best) {
    const found = candidates.map((c) => `${c.major} at ${c.home}`).join(', ')
    return missing(
      'java',
      `Java (JDK ${JDK_MIN}-${JDK_MAX})`,
      `Only unsupported JDKs found (${found}); Gradle needs ${JDK_MIN}-${JDK_MAX}`,
      {
        affects: ['android'],
        fix: {
          brew: 'brew install openjdk@21',
          apt: 'sudo apt install openjdk-21-jdk',
          winget: 'winget install EclipseAdoptium.Temurin.21.JDK',
        },
      },
    )
  }
  const exported = ctx.env.JAVA_HOME === best.home || ctx.toolchain.javaHome === best.home
  const detail = `${best.versionLine} at ${best.home}${exported ? '' : ' (mpf sets JAVA_HOME for its builds)'}`
  return ok('java', `Java (JDK ${JDK_MIN}-${JDK_MAX})`, detail, {
    version: String(best.major),
    affects: ['android'],
  })
}

/** `java -version` prints to stderr. */
async function javaVersionLine(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const { runProcess } = await import('../../exec.ts')
  try {
    const r = await runProcess({ command: bin, args: ['-version'], env, timeoutMs: 15_000 })
    if (r.exitCode !== 0) return undefined
    return (r.stderr || r.stdout).split('\n')[0]?.trim()
  } catch {
    return undefined
  }
}

export function resolveAndroidHome(ctx: CheckContext, brewPrefix?: string): string | undefined {
  const { env, toolchain, platform } = ctx
  const candidates = [
    toolchain.androidHome,
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    platform === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk') : undefined,
    platform === 'linux' ? join(homedir(), 'Android', 'Sdk') : undefined,
    platform === 'win32' && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
    brewPrefix ? join(brewPrefix, 'share', 'android-commandlinetools') : undefined,
  ]
  return candidates.find((p): p is string => Boolean(p) && existsSync(p!))
}

export const androidCheck: CheckFn = async (ctx) => {
  const brewPrefix =
    ctx.platform === 'darwin' ? await tryOutput('brew', ['--prefix'], ctx.env) : undefined
  const sdk = resolveAndroidHome(ctx, brewPrefix)
  if (!sdk) {
    return missing(
      'android',
      'Android SDK',
      'No SDK found (ANDROID_HOME unset, no default location)',
      {
        affects: ['android'],
        fix: {
          brew: 'brew install --cask android-commandlinetools && export ANDROID_HOME=$(brew --prefix)/share/android-commandlinetools',
          manual: 'Install Android Studio or command-line tools; set ANDROID_HOME',
        },
      },
    )
  }
  const has = (rel: string) => existsSync(join(sdk, rel))
  const list = (rel: string) =>
    has(rel) ? readdirSync(join(sdk, rel)).filter((n) => !n.startsWith('.')) : []
  const platforms = list('platforms')
  const buildTools = list('build-tools')
  const systemImages = list('system-images')
  const parts: string[] = []
  const gaps: string[] = []
  if (has('platform-tools/adb') || has('platform-tools/adb.exe')) parts.push('adb')
  else gaps.push('platform-tools')
  if (platforms.length) parts.push(`platforms ${platforms.join(',')}`)
  else gaps.push('a platform (e.g. platforms;android-36)')
  if (buildTools.length) parts.push(`build-tools ${buildTools.join(',')}`)
  else gaps.push('build-tools')
  if (has('emulator/emulator') || has('emulator/emulator.exe')) parts.push('emulator')
  else gaps.push('emulator')
  if (systemImages.length) parts.push(`system-images ${systemImages.join(',')}`)
  else gaps.push('a system image')
  const arch = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
  const fixPkgs = `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "emulator" "system-images;android-36;google_apis;${arch}"`
  const detail = `${sdk}: ${parts.join(', ') || 'empty'}`
  if (
    gaps.includes('platform-tools') ||
    gaps.includes('build-tools') ||
    gaps.some((g) => g.startsWith('a platform'))
  ) {
    return missing('android', 'Android SDK', `${detail}; missing ${gaps.join(', ')}`, {
      affects: ['android'],
      fix: { manual: fixPkgs },
    })
  }
  if (gaps.length) {
    return warn(
      'android',
      'Android SDK',
      `${detail}; builds work, but ${gaps.join(' and ')} needed for device tests`,
      {
        affects: ['android-e2e'],
        fix: {
          manual: `${fixPkgs} && avdmanager create avd -n mpf-api36 -k "system-images;android-36;google_apis;${arch}"`,
        },
      },
    )
  }
  return ok('android', 'Android SDK', detail, { affects: ['android'] })
}
