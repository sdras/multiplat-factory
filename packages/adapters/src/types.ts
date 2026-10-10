import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'pathe'
import type {
  AnalysisHints,
  AppSpec,
  BehaviorSpec,
  CoreManifest,
  Detection,
  Diagnostic,
  MpfConfig,
  Platform,
  Run,
  Target,
  TargetPlan,
  TestResult,
} from '@mpf/core'
import type { DevServerHandle } from '@mpf/harness'

export interface PackageJson {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

/** Cheap view of a source tree used for detection: shallow listing plus lazy reads. */
export interface DetectContext {
  dir: string
  /** Relative paths of files and directories up to depth 2 (build folders excluded). */
  files: string[]
  exists(rel: string): boolean
  read(rel: string): string | undefined
  packageJson?: PackageJson
  /** All dependencies and devDependencies merged. */
  deps: Record<string, string>
}

export interface ObserveOptions {
  port: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  log: (message: string) => void
}

export interface MobileObserveOptions {
  /** Directory for build products (derived data, APK copies); under the run directory. */
  outDir: string
  config: MpfConfig
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  log: (message: string) => void
  onOutput?: (chunk: string) => void
}

/** A source app built for a simulator or emulator so its behaviors can be observed. */
export interface MobileSourceApp {
  platform: 'ios' | 'android'
  /** Bundle id (iOS) or application id (Android). */
  appId: string
  /** Absolute path of the .app bundle or .apk. */
  product: string
  /** Environment with the toolchain resolved (DEVELOPER_DIR, JAVA_HOME, ANDROID_HOME). */
  env: NodeJS.ProcessEnv
  notes: string[]
}

/**
 * A source adapter knows how to recognize one kind of project and how to run it
 * for observation. Everything platform- or framework-specific lives here.
 */
export interface SourceAdapter {
  id: string
  platform: Platform
  detect(ctx: DetectContext): Promise<Detection | undefined>
  /** Framework-specific pointers that help the analysis workers (routes, entry files, notes). */
  hints?(ctx: DetectContext, detection: Detection): Promise<AnalysisHints>
  /** Install dependencies if needed and start the app so it can be observed at the returned URL. */
  observe?(ctx: DetectContext, detection: Detection, opts: ObserveOptions): Promise<DevServerHandle>
  /** Build a mobile source app for a simulator or emulator so its behaviors can be walked with Maestro. */
  observeMobile?(
    ctx: DetectContext,
    detection: Detection,
    opts: MobileObserveOptions,
  ): Promise<MobileSourceApp | undefined>
  /**
   * The project's own test suite, if it has one and the toolchain to run it is present. The
   * observe stage runs it once and records the outcome as a `source` test result.
   */
  existingTests?(
    ctx: DetectContext,
    opts: SourceTestOptions,
  ): Promise<SourceTestCommand | undefined>
}

export interface SourceTestOptions {
  config: MpfConfig
  env: NodeJS.ProcessEnv
  /** Scratch directory for build products and reports (derived data, JUnit XML). */
  outDir: string
  /** Simulator udid or emulator serial the tests may use, when the stage booted one. */
  device?: string
  log: (message: string) => void
}

export interface SourceTestCommand {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Turn the finished process into a test outcome (counts, cases, failure messages). */
  summarize(r: { stdout: string; stderr: string; exitCode: number }): TestOutcome
}

/** The built shared core handed to targets that embed it (see docs/ABI.md). */
export interface CoreHandoff {
  /** Absolute path of the built module. */
  wasm: string
  manifest: CoreManifest
  /** Absolute path of the crate's vectors/ directory (one JSON file per function). */
  vectorsDir: string
}

export interface TargetContext {
  run: Run
  /** Absolute path of the generated project for this target. */
  workspace: string
  spec: AppSpec
  behaviors: BehaviorSpec
  plan: TargetPlan
  /** Present when the plan enabled a shared core and core.build succeeded. */
  core?: CoreHandoff
  config: MpfConfig
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  log: (message: string) => void
  /** Raw process output, streamed to the run transcript. */
  onOutput?: (chunk: string) => void
}

export interface BuildResult {
  ok: boolean
  diagnostics: Diagnostic[]
  /** Path of the primary build product (APK, .app, dist dir), relative to the workspace. */
  product?: string
  durationMs: number
  /** Tail of the raw output for the transcript and fix briefs. */
  logTail: string
}

export type TestOutcome = Omit<TestResult, 'stageId' | 'target'>

export interface CompiledFlow {
  behaviorId: string
  /** Path relative to the workspace, or undefined when the behavior cannot be expressed. */
  path?: string
  unverifiable?: string
}

export interface E2eResult {
  launch: TestOutcome
  flows: TestOutcome
  /** Screenshots captured, relative to the workspace. */
  screenshots: { screenId?: string; behaviorId?: string; file: string }[]
}

/**
 * A target adapter owns everything about producing one platform: a green scaffold,
 * the conventions the generation worker must follow, and how to build, unit-test,
 * launch, and drive the result. Implementations must never hardcode machine paths.
 */
export interface TargetAdapter {
  id: string
  target: Target
  /** Can this target be built and tested on this host right now? */
  available(
    config: MpfConfig,
    env: NodeJS.ProcessEnv,
  ): Promise<{ ok: boolean; reason?: string; env: NodeJS.ProcessEnv }>
  /** Write a project that builds before any LLM touches it. */
  scaffold(ctx: TargetContext): Promise<{ files: string[] }>
  /** Conventions appended to the generation worker's system prompt. */
  workerPrompt(ctx: TargetContext): string
  /** Commands the generation worker may run. */
  bashAllow: RegExp[]
  build(ctx: TargetContext): Promise<BuildResult>
  unitTest(ctx: TargetContext): Promise<TestOutcome>
  /** Turn BehaviorSpec steps into platform flows (Maestro YAML, Playwright specs). */
  compileFlows(ctx: TargetContext): Promise<CompiledFlow[]>
  /** Install, launch, check for crashes, screenshot screens, run flows. */
  e2e(ctx: TargetContext, flows: CompiledFlow[]): Promise<E2eResult>
  /** What a human needs to build, test, and run the result by hand; used in PORT.md. */
  docs?(ctx: TargetContext): TargetDocs
}

export interface TargetDocs {
  /** Shell command(s) that build the project from the workspace root. */
  build: string
  unitTest: string
  e2e?: string
  /** Workspace-relative path of the built product. */
  product?: string
  /** Facts a maintainer should know (routes, seeding hooks, test ids). */
  notes: string[]
  /**
   * What the workspace ships, read from its project files rather than from the plan: the
   * identifier the built app carries and where its sources, tests, and flows live. The
   * report stage builds the PORT.md header and file map from it.
   */
  shipped?: ShippedLayout
}

/** The identifier a built app carries, read from a workspace file. */
export interface ShippedAppId {
  /** How the platform names it: "Application id", "Bundle id", "Package name". */
  label: string
  value: string
  /** Workspace-relative file it was read from; absent when no project file declares one and the scaffold's default is reported instead. */
  file?: string
}

/** How a target adapter describes a generated workspace to the report stage. */
export interface ShippedLayout {
  appId?: ShippedAppId
  /** File groups in match order; a file lands in the first group whose pattern matches its workspace-relative path. */
  groups: { title: string; pattern: RegExp }[]
  /** Tested against every entry's workspace-relative path; matches are left out and matching directories are not entered (build output, caches, captured evidence). */
  exclude: RegExp[]
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  'DerivedData',
  '.gradle',
  'target',
  'coverage',
  '.turbo',
  '.cache',
  'Pods',
  '.dart_tool',
])

export function makeDetectContext(dir: string): DetectContext {
  const files: string[] = []
  const walk = (rel: string, depth: number) => {
    let entries: string[]
    try {
      entries = readdirSync(join(dir, rel))
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      const relPath = rel ? `${rel}/${name}` : name
      files.push(relPath)
      if (depth < 2) {
        try {
          if (statSync(join(dir, relPath)).isDirectory()) walk(relPath, depth + 1)
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk('', 0)
  const read = (rel: string) => {
    try {
      return readFileSync(join(dir, rel), 'utf8')
    } catch {
      return undefined
    }
  }
  let packageJson: PackageJson | undefined
  const raw = read('package.json')
  if (raw) {
    try {
      packageJson = JSON.parse(raw) as PackageJson
    } catch {
      packageJson = undefined
    }
  }
  return {
    dir,
    files,
    exists: (rel) => existsSync(join(dir, rel)),
    read,
    packageJson,
    deps: { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) },
  }
}

export function hasFile(ctx: DetectContext, pattern: RegExp): string | undefined {
  return ctx.files.find((f) => pattern.test(f))
}

export function countByExt(ctx: DetectContext, exts: string[]): number {
  return ctx.files.filter((f) => exts.some((e) => f.endsWith(e))).length
}
