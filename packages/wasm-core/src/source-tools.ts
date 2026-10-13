import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'pathe'
import type { MpfConfig, Platform } from '@mpf/core'
import { androidTools, gradleWrapperVersion, xcodeTools } from '@mpf/harness'

/** What a core worker needs to run the source's own logic for `executed` vectors. */
export interface SourceToolEnv {
  env: NodeJS.ProcessEnv
  /** Directories the worker may read besides the source: dependency caches its harness compiles against. */
  readDirs: string[]
  /** One paragraph for the worker's prompt naming the tools and where the jars live. */
  note: string
}

interface Deps {
  androidTools: typeof androidTools
  xcodeTools: typeof xcodeTools
  exists: (p: string) => boolean
  home: () => string
}

/**
 * The toolchain a core worker gets for the source platform: the JDK the harness resolves for the
 * source's Gradle version (`JAVA_HOME`, `javac` and `java` on PATH) plus read access to the Gradle
 * cache where the source's third-party jars live, or Xcode's toolchain (`DEVELOPER_DIR`, `swiftc`
 * on PATH). The first Java-source core run recorded 160 derived vectors and 0 executed because the
 * worker's shell had the macOS `java` stub, no `JAVA_HOME`, and no way to reach `org.json`.
 */
export async function sourceToolEnv(
  platform: Platform,
  config: MpfConfig,
  sourceDir: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<Deps> = {},
): Promise<SourceToolEnv> {
  const d: Deps = { androidTools, xcodeTools, exists: existsSync, home: homedir, ...deps }
  if (platform === 'android') {
    const gradleVersion = gradleWrapperVersion(sourceDir)
    const tools = await d.androidTools(config, env, gradleVersion ? { gradleVersion } : {})
    const cache = join(env.GRADLE_USER_HOME ?? join(d.home(), '.gradle'), 'caches')
    const readDirs = d.exists(cache) ? [cache] : []
    if (!tools?.javaHome) {
      return {
        env,
        readDirs,
        note: 'No JDK was found for this source; `javac` and `java` are not available, so vectors stay "derived" unless the source ships a script runner.',
      }
    }
    return {
      env: tools.env,
      readDirs,
      note: [
        `JAVA_HOME is ${tools.javaHome}${tools.javaMajor ? ` (JDK ${tools.javaMajor})` : ''}; \`javac\` and \`java\` from it are on PATH.`,
        readDirs.length
          ? `Third-party jars the source compiles against are readable under ${cache}/modules-2/files-2.1 (find one with \`find ${cache}/modules-2/files-2.1 -name '<artifact>-*.jar'\`) and go on \`-cp\`.`
          : 'No Gradle cache was found, so compile only the files that need nothing beyond the JDK.',
      ].join(' '),
    }
  }
  if (platform === 'ios') {
    const xcode = await d.xcodeTools(config, env)
    if (!xcode) {
      return {
        env,
        readDirs: [],
        note: 'No Xcode was found; `swiftc` is not available, so vectors stay "derived".',
      }
    }
    const bins = [
      join(xcode.developerDir, 'Toolchains/XcodeDefault.xctoolchain/usr/bin'),
      join(xcode.developerDir, 'usr/bin'),
    ]
    return {
      env: { ...xcode.env, PATH: [...bins, env.PATH ?? ''].filter(Boolean).join(':') },
      readDirs: [],
      note: `DEVELOPER_DIR is ${xcode.developerDir}; \`swiftc\`, \`swift\`, and \`clang\` from its toolchain are on PATH (\`xcrun swiftc\` and \`xcrun clang\` work too).`,
    }
  }
  return { env, readDirs: [], note: '' }
}
