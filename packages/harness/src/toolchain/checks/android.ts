import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mpfHome } from '@mpf/core'
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
  // JDKs dropped under <MPF_HOME>/jdks (a tarball unpacked there needs no package manager and no
  // sudo): either the unpacked folder itself or its macOS `Contents/Home`.
  const dropped = join(mpfHome(env), 'jdks')
  if (existsSync(dropped))
    for (const d of readdirSync(dropped)) {
      add(join(dropped, d, 'Contents', 'Home'))
      add(join(dropped, d))
    }
  if (platform === 'darwin') {
    for (const v of ['21', '17', '11', '1.8', '24', '23', '22', '17+'])
      add(await tryOutput('/usr/libexec/java_home', ['-v', v], env))
    for (const formula of ['openjdk@21', 'openjdk@17', 'openjdk@11', 'openjdk@8', 'openjdk'])
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
    // JDK 8 reports itself as "1.8.0_x"; everything after it as "17.0.x".
    const major = Number(/version "(?:1\.)?(\d+)/.exec(versionLine)?.[1] ?? 0)
    out.push({ home, major, versionLine })
  }
  return out
}

/**
 * Prefer the newest JDK in the wanted range (the factory's own Gradle by default, a source app's
 * wrapper when given); fall back to an explicit but unsupported one so the doctor can explain.
 */
export async function resolveJava(
  ctx: CheckContext,
  range: { min: number; max: number } = { min: JDK_MIN, max: JDK_MAX },
): Promise<{ home: string; major: number; inRange: boolean } | undefined> {
  const candidates = await findJavaCandidates(ctx)
  const supported = candidates
    .filter((c) => c.major >= range.min && c.major <= range.max)
    .sort((a, b) => b.major - a.major)
  const best = supported[0]
  if (best) return { home: best.home, major: best.major, inRange: true }
  const any = candidates[0]
  return any ? { home: any.home, major: any.major, inRange: false } : undefined
}

export async function resolveJavaHome(
  ctx: CheckContext,
  range?: { min: number; max: number },
): Promise<string | undefined> {
  return (await resolveJava(ctx, range))?.home
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

/** The Gradle version a project's wrapper pins (`distributionUrl=...gradle-7.2-bin.zip`), if any. */
export function gradleWrapperVersion(projectDir: string): string | undefined {
  const file = join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.properties')
  if (!existsSync(file)) return undefined
  const m = /distributionUrl=.*gradle-(\d+(?:\.\d+){1,2})-/.exec(readFileSync(file, 'utf8'))
  return m?.[1]
}

/**
 * The JDK majors a Gradle version runs on. A source app brings its own wrapper, and Gradle refuses
 * class files newer than it knows ("Unsupported class file major version 65" is Gradle 7.2 meeting
 * JDK 21), so the harness has to hand it a JDK from this range rather than the newest it has.
 * Gradle's compatibility table: 7.0-7.2 up to 16, 7.3 adds 17, 7.5 18, 7.6 19, 8.3 20, 8.5 21,
 * 8.8 22, 8.10 23, 8.14 24. AGP 8 (Gradle 8) needs 17 and AGP 7 needs 11 at the low end.
 */
/** The Homebrew formula that provides a JDK inside the range, for the doctor's and the adapters' hints. */
export function jdkFormulaFor(range: { min: number; max: number }): string {
  const major = [21, 17, 11, 8].find((v) => v >= range.min && v <= range.max) ?? range.max
  return `openjdk@${major}`
}

export function gradleJdkRange(gradleVersion: string): { min: number; max: number } {
  const [major = 0, minor = 0] = gradleVersion.split('.').map((n) => Number.parseInt(n, 10))
  const at = (m: number, n: number) => major > m || (major === m && minor >= n)
  const max = at(8, 14)
    ? 24
    : at(8, 10)
      ? 23
      : at(8, 8)
        ? 22
        : at(8, 5)
          ? 21
          : at(8, 3)
            ? 20
            : at(7, 6)
              ? 19
              : at(7, 5)
                ? 18
                : at(7, 3)
                  ? 17
                  : at(7, 0)
                    ? 16
                    : at(6, 7)
                      ? 15
                      : at(6, 3)
                        ? 14
                        : at(6, 0)
                          ? 13
                          : at(5, 4)
                            ? 12
                            : at(5, 0)
                              ? 11
                              : at(4, 7)
                                ? 10
                                : at(4, 3)
                                  ? 9
                                  : 8
  // AGP 8 (Gradle 8) needs 17, AGP 7 needs 11, and the Gradle 4/5/6 era built on 8.
  return { min: major >= 8 ? 17 : major >= 7 ? 11 : 8, max }
}
