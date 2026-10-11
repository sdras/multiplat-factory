import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'pathe'
import type { AnalysisHints } from '@mpf/core'
import {
  type AndroidTools,
  androidTools,
  derivedProductsDir,
  gradleJdkRange,
  gradleWrapperVersion,
  runProcess,
  which,
  xcodeTools,
} from '@mpf/harness'
import { gradleArgs } from '../target/gradle.ts'
import { parseJUnitXml } from '../target/junit.ts'
import { parseXcodebuildTests } from '../target/xcodebuild.ts'
import { hasFile, type DetectContext, type SourceAdapter, type TestOutcome } from '../types.ts'

/**
 * iOS and Android sources: detection and analysis hints, building the app for a simulator or
 * emulator so the observe stage can walk its behaviors with Maestro, and running the project's
 * own test suite so the port starts from a known-good baseline.
 */

const WALK_SKIP = new Set([
  'node_modules',
  '.git',
  '.gradle',
  'build',
  'DerivedData',
  'Pods',
  '.build',
  'Carthage',
  'intermediates',
])

/**
 * Source files by extension anywhere in the tree (bounded), since the detect context only lists
 * the top two levels and Java, Kotlin, and Swift sources sit several package directories deep.
 */
function sourceFiles(dir: string, exts: string[], limit = 4000, depth = 10): string[] {
  const out: string[] = []
  const walk = (d: string, left: number) => {
    if (left < 0 || out.length >= limit || !existsSync(d)) return
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      if (out.length >= limit) return
      const p = join(d, name)
      if (exts.some((e) => name.endsWith(e))) out.push(p)
      else if (!WALK_SKIP.has(name) && !name.startsWith('.') && safeIsDir(p)) walk(p, left - 1)
    }
  }
  walk(dir, depth)
  return out
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Swift and Objective-C sources, counted through the whole tree. */
function iosLanguages(ctx: DetectContext): { swift: number; objc: number } {
  return {
    swift: sourceFiles(ctx.dir, ['.swift']).length,
    objc: sourceFiles(ctx.dir, ['.m', '.mm']).length,
  }
}

function swiftUiOrUiKit(
  ctx: DetectContext,
  counts = iosLanguages(ctx),
): 'swiftui' | 'uikit' | 'mixed' {
  // Objective-C cannot use SwiftUI; a project without Swift is UIKit by construction.
  if (counts.swift === 0 && counts.objc > 0) return 'uikit'
  let swiftui = 0
  let uikit = 0
  for (const f of sourceFiles(ctx.dir, ['.swift', '.m', '.h'], 400)) {
    try {
      const text = readFileSync(f, 'utf8')
      if (/import SwiftUI/.test(text)) swiftui++
      if (/(import|@import) UIKit/.test(text) && /\bUI\w*ViewController\b/.test(text)) uikit++
    } catch {
      /* ignore */
    }
  }
  if (swiftui && uikit) return 'mixed'
  return uikit && !swiftui ? 'uikit' : 'swiftui'
}

/** Repos that generate their project with XcodeGen check in `project.yml` instead of the `.xcodeproj`. */
export function xcodegenSpec(ctx: DetectContext): string | undefined {
  for (const spec of ['project.yml', 'project.yaml']) {
    const text = ctx.exists(spec) ? ctx.read(spec) : undefined
    if (text && /^name:/m.test(text) && /^targets:/m.test(text)) return spec
  }
  return undefined
}

/**
 * The container xcodebuild should open: a top-level workspace (CocoaPods, multi-project) wins
 * over a bare project, then an XcodeGen spec. Every `.xcodeproj` also holds a
 * `project.xcworkspace`, which is not a container of its own.
 */
export function xcodeContainer(ctx: DetectContext): string | undefined {
  return (
    ctx.files.find((f) => f.endsWith('.xcworkspace') && !f.includes('.xcodeproj')) ??
    hasFile(ctx, /\.xcodeproj$/) ??
    xcodegenSpec(ctx)
  )
}

export const iosXcode: SourceAdapter = {
  id: 'ios-xcode',
  platform: 'ios',
  async detect(ctx) {
    const proj = xcodeContainer(ctx)
    if (!proj) return undefined
    const { swift, objc } = iosLanguages(ctx)
    const ui = swiftUiOrUiKit(ctx, { swift, objc })
    const generated = /\.ya?ml$/.test(proj)
    return {
      adapterId: 'ios-xcode',
      platform: 'ios',
      framework: ui,
      language: swift >= objc ? 'swift' : 'objective-c',
      entry: proj,
      score: generated ? 0.9 : 0.95,
      evidence: [
        generated ? `${proj} (XcodeGen spec)` : proj,
        `${swift} swift files`,
        `${objc} objc files`,
      ],
      supported: true,
    }
  },
  async hints(_ctx, d): Promise<AnalysisHints> {
    return {
      framework: d.framework,
      entryFiles: [d.entry],
      routeHints: [],
      stateHints: [],
      persistenceHints: [],
      integrationHints: [],
      testHooks: [],
      notes: [
        d.framework === 'uikit'
          ? 'UIKit: screens are UIViewController subclasses (and storyboards/xibs); navigation via UINavigationController/UITabBarController/segues.'
          : 'SwiftUI: screens are View structs reached via NavigationStack/TabView/sheets; state lives in @State/@Observable/@AppStorage and view models.',
        'UserDefaults/@AppStorage, SwiftData, Core Data, and Keychain are persistence mechanisms; record their keys and wire formats.',
        'Observation runs the built app on a simulator through Maestro: elements are found by accessibilityIdentifier, then by visible text. Use the identifiers the source sets as element test ids; behaviors that need seeds or deep links are unverifiable on the source.',
      ],
    }
  },
}

export const iosSwiftPM: SourceAdapter = {
  id: 'ios-swiftpm',
  platform: 'ios',
  async detect(ctx) {
    if (!ctx.exists('Package.swift') || xcodeContainer(ctx)) return undefined
    return {
      adapterId: 'ios-swiftpm',
      platform: 'ios',
      framework: swiftUiOrUiKit(ctx),
      language: 'swift',
      entry: 'Package.swift',
      score: 0.85,
      evidence: ['Package.swift'],
      supported: true,
    }
  },
  hints: iosXcode.hints,
}

export const androidGradle: SourceAdapter = {
  id: 'android-gradle',
  platform: 'android',
  async detect(ctx) {
    const settings = hasFile(ctx, /^settings\.gradle(\.kts)?$/)
    const appBuild =
      hasFile(ctx, /^app\/build\.gradle(\.kts)?$/) ?? hasFile(ctx, /^build\.gradle(\.kts)?$/)
    if (!settings && !appBuild) return undefined
    const buildText = appBuild ? (ctx.read(appBuild) ?? '') : ''
    const isAndroid =
      /com\.android\.application|android\s*\{/.test(buildText) ||
      ctx.exists('app/src/main/AndroidManifest.xml')
    if (!isAndroid) return undefined
    const compose = /compose/.test(buildText)
    const kotlin = sourceFiles(ctx.dir, ['.kt']).length
    const java = sourceFiles(ctx.dir, ['.java']).length
    return {
      adapterId: 'android-gradle',
      platform: 'android',
      framework: compose ? 'compose' : 'views',
      language: kotlin >= java ? 'kotlin' : 'java',
      entry: appBuild ?? settings ?? 'build.gradle',
      score: 0.95,
      evidence: [
        settings ?? '',
        appBuild ?? '',
        compose ? 'compose in build file' : 'no compose',
      ].filter(Boolean),
      supported: true,
    }
  },
  async hints(_ctx, d): Promise<AnalysisHints> {
    return {
      framework: d.framework,
      entryFiles: [d.entry, 'app/src/main/AndroidManifest.xml'],
      routeHints: [],
      stateHints: [],
      persistenceHints: [],
      integrationHints: [],
      testHooks: [],
      notes: [
        d.framework === 'compose'
          ? 'Jetpack Compose: screens are @Composable functions reached through NavHost routes or activity/fragment hosts; state in ViewModels and StateFlow.'
          : 'Android Views: screens are Activities and Fragments with XML layouts; navigation via Intents, FragmentManager, or the Navigation component.',
        'DataStore, SharedPreferences, Room, and SQLite are persistence mechanisms; record keys, entities, and wire formats.',
        'Observation runs the debug APK on an emulator through Maestro: elements are found by resource id (android:id) or Compose testTag, then by visible text. Use those ids as element test ids; behaviors that need seeds or deep links are unverifiable on the source.',
      ],
    }
  },
}

export const MOBILE_SOURCE_ADAPTERS: SourceAdapter[] = [iosXcode, iosSwiftPM, androidGradle]

// ---- Building source apps for observation ----

interface XcodeSelection {
  flag: '-project' | '-workspace'
  scheme: string
  targets: string[]
}

/** Pick the app scheme of an Xcode project or workspace: the one named like the project, else the first non-test scheme. */
async function xcodeScheme(
  dir: string,
  container: string,
  env: NodeJS.ProcessEnv,
): Promise<XcodeSelection | undefined> {
  const flag = container.endsWith('.xcworkspace') ? '-workspace' : '-project'
  const list = await runProcess({
    command: 'xcodebuild',
    args: ['-list', '-json', flag, container],
    cwd: dir,
    env,
    timeoutMs: 120_000,
  })
  if (list.exitCode !== 0) return undefined
  try {
    const parsed = JSON.parse(list.stdout) as {
      project?: { schemes?: string[]; targets?: string[]; name?: string }
      workspace?: { schemes?: string[]; name?: string }
    }
    const info = parsed.project ?? parsed.workspace
    const schemes = info?.schemes ?? []
    const scheme =
      schemes.find((x) => x === info?.name) ??
      schemes.find((x) => !/tests?$/i.test(x)) ??
      schemes[0]
    return scheme ? { flag, scheme, targets: parsed.project?.targets ?? [] } : undefined
  } catch {
    return undefined
  }
}

/** An XcodeGen spec becomes a project on first use; projects and workspaces are used as they are. */
async function resolveXcodeContainer(
  dir: string,
  entry: string,
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): Promise<string | undefined> {
  if (!/\.ya?ml$/.test(entry)) return entry
  const existing = readdirSync(dir).find((n) => n.endsWith('.xcodeproj'))
  if (existing) return existing
  if (!(await which('xcodegen', env))) {
    log(`${entry} is an XcodeGen spec and xcodegen is not installed (brew install xcodegen)`)
    return undefined
  }
  log(`generating the Xcode project from ${entry} with xcodegen`)
  const gen = await runProcess({
    command: 'xcodegen',
    args: ['generate', '--quiet', '--spec', entry],
    cwd: dir,
    env,
    timeoutMs: 180_000,
  })
  if (gen.exitCode !== 0) {
    log(`xcodegen failed: ${(gen.stderr || gen.stdout).trim().slice(-500)}`)
    return undefined
  }
  return readdirSync(dir).find((n) => n.endsWith('.xcodeproj'))
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.gradle',
  'intermediates',
  'DerivedData',
  'Pods',
])

function findFiles(dir: string, test: (name: string) => boolean, depth = 3): string[] {
  if (depth < 0 || !existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (test(name)) out.push(p)
    else if (!SKIP_DIRS.has(name) && statSync(p).isDirectory())
      out.push(...findFiles(p, test, depth - 1))
  }
  return out
}

iosXcode.observeMobile = async (ctx, detection, opts) => {
  const tools = await xcodeTools(opts.config, opts.env ?? process.env)
  if (!tools) {
    opts.log('no full Xcode found; the iOS source cannot be built for observation')
    return undefined
  }
  const container = await resolveXcodeContainer(ctx.dir, detection.entry, tools.env, opts.log)
  if (!container) return undefined
  const picked = await xcodeScheme(ctx.dir, container, tools.env)
  if (!picked) {
    opts.log(`could not list schemes of ${container}`)
    return undefined
  }
  const derived = join(opts.outDir, 'DerivedData')
  opts.log(`building scheme ${picked.scheme} for the simulator`)
  const build = await runProcess({
    command: 'xcodebuild',
    args: [
      picked.flag,
      container,
      '-scheme',
      picked.scheme,
      '-configuration',
      'Debug',
      '-sdk',
      'iphonesimulator',
      '-destination',
      'generic/platform=iOS Simulator',
      '-derivedDataPath',
      derived,
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGN_IDENTITY=',
      '-quiet',
      'build',
    ],
    cwd: ctx.dir,
    env: tools.env,
    timeoutMs: 40 * 60_000,
    signal: opts.signal,
    onStdout: opts.onOutput,
    onStderr: opts.onOutput,
  })
  if (build.exitCode !== 0) {
    opts.log(`xcodebuild failed: ${(build.stderr || build.stdout).trim().slice(-600)}`)
    return undefined
  }
  const products = join(derivedProductsDir(derived))
  const apps = findFiles(products, (n) => n.endsWith('.app'), 1)
  const app = apps.find((a) => !/tests?\.app$/i.test(a)) ?? apps[0]
  if (!app) {
    opts.log(`no .app under ${products}`)
    return undefined
  }
  const plist = await runProcess({
    command: 'plutil',
    args: ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Info.plist')],
    env: tools.env,
    timeoutMs: 30_000,
  })
  const appId = plist.stdout.trim()
  if (!appId) {
    opts.log('could not read CFBundleIdentifier from the built app')
    return undefined
  }
  return {
    platform: 'ios',
    appId,
    product: app,
    env: tools.env,
    notes: [`scheme ${picked.scheme}`],
  }
}

androidGradle.observeMobile = async (ctx, _detection, opts) => {
  // The source brings its own Gradle: hand it a JDK that version runs on, not the newest around.
  const gradleVersion = gradleWrapperVersion(ctx.dir)
  const tools = await androidTools(
    opts.config,
    opts.env ?? process.env,
    gradleVersion ? { gradleVersion } : {},
  )
  if (!tools) {
    opts.log('Android SDK not found; the Android source cannot be built for observation')
    return undefined
  }
  if (gradleVersion) {
    const range = gradleJdkRange(gradleVersion)
    opts.log(
      `source wrapper pins Gradle ${gradleVersion} (JDK ${range.min}-${range.max}); using JDK ${tools.javaMajor ?? '?'}${tools.javaInRange === false ? ` which it will refuse: install one in range (brew install openjdk@${range.max >= 17 ? 17 : 11})` : ''}`,
    )
  }
  const command = await gradleCommand(ctx.dir, tools.env)
  if (!command) {
    opts.log('neither a Gradle wrapper nor gradle on PATH; cannot build the Android source')
    return undefined
  }
  opts.log(`building with ${command === 'gradle' ? 'gradle' : './gradlew'} assembleDebug`)
  const build = await runProcess({
    command,
    args: gradleArgs('assembleDebug'),
    cwd: ctx.dir,
    env: tools.env,
    timeoutMs: 40 * 60_000,
    signal: opts.signal,
    onStdout: opts.onOutput,
    onStderr: opts.onOutput,
  })
  if (build.exitCode !== 0) {
    opts.log(`gradle failed: ${(build.stderr || build.stdout).trim().slice(-600)}`)
    return undefined
  }
  const apks = findFiles(ctx.dir, (n) => n.endsWith('.apk'), 6).filter(
    (p) => /outputs\/apk\/.*debug/.test(p) && !/androidTest/.test(p),
  )
  const apk = apks.sort((a, b) => a.length - b.length)[0]
  if (!apk) {
    opts.log('no debug APK under outputs/apk after the build')
    return undefined
  }
  const badging = await apkBadging(tools, apk)
  if (!badging) {
    opts.log(`could not read the application id of ${apk}`)
    return undefined
  }
  const { packageName: appId, activity } = badging
  if (activity) opts.log(`launcher activity ${activity}`)
  return {
    platform: 'android',
    appId,
    product: apk,
    ...(activity ? { activity } : {}),
    env: tools.env,
    notes: [`apk ${relative(ctx.dir, apk)}`, ...(activity ? [`launcher ${activity}`] : [])],
  }
}

async function gradleCommand(dir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const wrapper = join(dir, 'gradlew')
  if (existsSync(wrapper)) return wrapper
  return (await which('gradle', env)) ? 'gradle' : undefined
}

/**
 * Application id and launcher activity from the APK's manifest via aapt2 (build-tools), else the
 * newest build-tools' aapt. A real app's launcher is rarely `<applicationId>.MainActivity`: the
 * architecture sample launches `…todoapp.tasks.TasksActivity` under a `.mock` application id.
 */
async function apkBadging(
  tools: AndroidTools,
  apk: string,
): Promise<{ packageName: string; activity?: string } | undefined> {
  const buildTools = join(tools.sdk, 'build-tools')
  const versions = existsSync(buildTools) ? readdirSync(buildTools).sort().reverse() : []
  for (const v of versions) {
    for (const bin of ['aapt2', 'aapt']) {
      const path = join(buildTools, v, bin)
      if (!existsSync(path)) continue
      const r = await runProcess({
        command: path,
        args: ['dump', 'badging', apk],
        env: tools.env,
        timeoutMs: 60_000,
      })
      const m = /package: name='([^']+)'/.exec(r.stdout)
      if (m) {
        const activity = /launchable-activity: name='([^']+)'/.exec(r.stdout)?.[1]
        return { packageName: m[1]!, ...(activity ? { activity } : {}) }
      }
    }
  }
  return undefined
}

// ---- The source's own tests ----

/** A result with no cases takes its status from the exit code, so a broken test build is reported as such. */
function statusFromExit(
  outcome: TestOutcome,
  r: { stdout: string; stderr: string; exitCode: number },
): TestOutcome {
  if (outcome.summary.total > 0) return outcome
  const tail = `${r.stdout}\n${r.stderr}`
    .trim()
    .split('\n')
    .slice(-8)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 500)
  return r.exitCode === 0
    ? { ...outcome, status: 'skip', skipReason: outcome.skipReason ?? 'no test cases ran' }
    : { ...outcome, status: 'error', skipReason: `exited ${r.exitCode}: ${tail}` }
}

iosXcode.existingTests = async (ctx, opts) => {
  const tools = await xcodeTools(opts.config, opts.env)
  if (!tools) return undefined
  const entry = xcodeContainer(ctx)
  if (!entry) return undefined
  const container = await resolveXcodeContainer(ctx.dir, entry, tools.env, opts.log)
  if (!container) return undefined
  const picked = await xcodeScheme(ctx.dir, container, tools.env)
  if (!picked || !picked.targets.some((t) => /tests$/i.test(t))) return undefined
  if (!opts.device) {
    opts.log('the iOS test suite needs a booted simulator; skipping')
    return undefined
  }
  // UI test targets drive the app for minutes and need their own runner app; the unit targets are the baseline.
  const skipUi = picked.targets.filter((t) => /UITests$/i.test(t)).map((t) => `-skip-testing:${t}`)
  return {
    command: 'xcodebuild',
    args: [
      picked.flag,
      container,
      '-scheme',
      picked.scheme,
      '-destination',
      `platform=iOS Simulator,id=${opts.device}`,
      '-derivedDataPath',
      join(opts.outDir, 'DerivedData'),
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGN_IDENTITY=',
      ...skipUi,
      'test',
    ],
    env: tools.env,
    timeoutMs: 30 * 60_000,
    summarize: (r) => statusFromExit(parseXcodebuildTests(`${r.stdout}\n${r.stderr}`, 'unit'), r),
  }
}

/** SwiftPM packages test with `swift test`; its XCTest output has the same `Test Case` lines as xcodebuild. */
iosSwiftPM.existingTests = async (ctx, opts) => {
  if (!ctx.exists('Tests')) return undefined
  const tools = await xcodeTools(opts.config, opts.env)
  if (!tools) return undefined
  return {
    command: 'swift',
    args: ['test'],
    env: tools.env,
    timeoutMs: 30 * 60_000,
    summarize: (r) => statusFromExit(parseXcodebuildTests(`${r.stdout}\n${r.stderr}`, 'unit'), r),
  }
}

/**
 * Gradle writes JUnit XML under each module's `build/test-results/test<Variant>UnitTest`. The file
 * walker skips `build/` (it is output everywhere else), so the result folders are reached from the
 * build directories themselves.
 */
export function gradleUnitTestResultDirs(projectDir: string): string[] {
  const out: string[] = []
  for (const build of findFiles(projectDir, (n) => n === 'build', 4)) {
    const results = join(build, 'test-results')
    if (!existsSync(results) || !statSync(results).isDirectory()) continue
    for (const name of readdirSync(results)) {
      const dir = join(results, name)
      if (/^test.*UnitTest$/.test(name) && statSync(dir).isDirectory()) out.push(dir)
    }
  }
  return out.sort()
}

androidGradle.existingTests = async (ctx, opts) => {
  const testDirs = findFiles(ctx.dir, (n) => n === 'test', 4).filter(
    (d) => /\/src\/test$/.test(d) && statSync(d).isDirectory(),
  )
  if (!testDirs.length) return undefined
  const gradleVersion = gradleWrapperVersion(ctx.dir)
  const tools = await androidTools(opts.config, opts.env, gradleVersion ? { gradleVersion } : {})
  if (!tools) return undefined
  const command = await gradleCommand(ctx.dir, tools.env)
  if (!command) return undefined
  // Product flavors rename the per-variant tasks; the umbrella `test` task covers them at the cost of running every variant.
  const buildFiles = findFiles(ctx.dir, (n) => /^build\.gradle(\.kts)?$/.test(n), 3)
  const flavored = buildFiles.some((f) => /productFlavors/.test(readFileSync(f, 'utf8')))
  return {
    command,
    args: gradleArgs(flavored ? 'test' : 'testDebugUnitTest', ['--continue']),
    env: tools.env,
    timeoutMs: 30 * 60_000,
    summarize: (r) => {
      const dirs = gradleUnitTestResultDirs(ctx.dir)
      const docs = dirs.flatMap((d) =>
        readdirSync(d)
          .filter((f) => f.endsWith('.xml'))
          .map((f) => readFileSync(join(d, f), 'utf8')),
      )
      return statusFromExit(parseJUnitXml(docs, 'unit', dirs[0]), r)
    },
  }
}
