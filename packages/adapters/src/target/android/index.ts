import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'pathe'
import {
  androidTools,
  ensureEmulator,
  installApk,
  launchAndCheck,
  listAvds,
  maestroTools,
  runProcess,
  screencap,
  stopApp,
  which,
  type AndroidTools,
} from '@mpf/harness'
import type {
  BuildResult,
  CompiledFlow,
  E2eResult,
  ShippedAppId,
  TargetAdapter,
  TargetContext,
  TestOutcome,
} from '../../types.ts'
import { gradleArgs, parseGradleOutput } from '../gradle.ts'
import { parseJUnitDir, parseJUnitFile } from '../junit.ts'
import { compileMaestroFlow } from '../maestro.ts'
import { MAESTRO_DEBUG_DIR, attachFlowEvidence } from '../maestro-evidence.ts'
import {
  ANDROID_CORE_MIN_SDK,
  androidCoreConventions,
  androidCoreEmbed,
} from '../../core/android.ts'
import { writeCoreEmbed } from '../../core/embed.ts'
import {
  ANDROID_VERSIONS,
  SEED_EXTRA,
  androidDeepLinkBase,
  androidFiles,
  packageNameFor,
  type AndroidProject,
} from './template.ts'

const APK = 'app/build/outputs/apk/debug/app-debug.apk'

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** What the workspace's Gradle module declares, so reports describe the app that shipped rather than the scaffold's defaults. */
export interface ShippedAndroidApp {
  appId: ShippedAppId
  minSdk?: number
  compileSdk?: number
}

/**
 * Read the application id (and SDK levels) from the workspace: the modules listed in
 * `settings.gradle(.kts)` (default `app`), their `build.gradle(.kts)` (`applicationId`, then
 * `namespace`), and finally the manifest's `package`. Undefined when nothing declares one.
 */
export function shippedAndroidApp(workspace: string): ShippedAndroidApp | undefined {
  const settings =
    readText(join(workspace, 'settings.gradle.kts')) ?? readText(join(workspace, 'settings.gradle'))
  const modules = [...(settings ?? '').matchAll(/include\s*\(?\s*["']:([^"']+)["']/g)].map((m) =>
    m[1]!.replace(/:/g, '/'),
  )
  const number = (text: string, key: string) => {
    const m = new RegExp(`\\b${key}\\s*=?\\s*(\\d+)`).exec(text)
    return m ? Number(m[1]) : undefined
  }
  for (const mod of modules.length ? modules : ['app']) {
    for (const rel of [`${mod}/build.gradle.kts`, `${mod}/build.gradle`]) {
      const text = readText(join(workspace, rel))
      if (!text) continue
      const m =
        /\bapplicationId\s*=?\s*["']([^"']+)["']/.exec(text) ??
        /\bnamespace\s*=?\s*["']([^"']+)["']/.exec(text)
      if (!m) continue
      return {
        appId: { label: 'Application id', value: m[1]!, file: rel },
        minSdk: number(text, 'minSdk'),
        compileSdk: number(text, 'compileSdk'),
      }
    }
  }
  const manifestRel = 'app/src/main/AndroidManifest.xml'
  const manifest = readText(join(workspace, manifestRel))
  const m = manifest && /\bpackage="([^"]+)"/.exec(manifest)
  return m ? { appId: { label: 'Application id', value: m[1]!, file: manifestRel } } : undefined
}

export function projectFor(ctx: TargetContext): AndroidProject {
  const minSdk = ctx.run.options.androidMinSdk ?? 26
  return {
    packageName: packageNameFor(ctx.spec.name),
    appName: ctx.spec.name,
    minSdk: ctx.core ? Math.max(minSdk, ANDROID_CORE_MIN_SDK) : minSdk,
    compileSdk: 36,
    screens: ctx.spec.screens.map((s) => ({ id: s.id, name: s.name })),
    rootScreen: ctx.spec.navigation.root,
    core: !!ctx.core,
  }
}

async function gradlew(
  ctx: TargetContext,
  task: string,
  extra: string[] = [],
  timeoutMs = 20 * 60_000,
) {
  const wrapper = join(ctx.workspace, 'gradlew')
  const command = existsSync(wrapper) ? wrapper : 'gradle'
  return runProcess({
    command,
    args: gradleArgs(task, extra),
    cwd: ctx.workspace,
    env: ctx.env,
    timeoutMs,
    signal: ctx.signal,
    onStdout: ctx.onOutput,
    onStderr: ctx.onOutput,
  })
}

export const androidTarget: TargetAdapter = {
  id: 'android-compose',
  target: 'android',

  bashAllow: [
    /^\.\/gradlew\b/,
    /^gradle\b/,
    // Which JDK the build will use; workers check it before touching the Gradle setup.
    /^javac? --?version\b/,
    /^(ls|cat|head|tail|wc|find|tree|grep|rg|mkdir|touch|mv|cp|rm)\b/,
    /^git (status|diff|log|ls-files)\b/,
  ],

  async available(config, env) {
    const tools = await androidTools(config, env)
    if (!tools)
      return { ok: false, reason: 'Android SDK not found; set ANDROID_HOME or run mpf doctor', env }
    if (!tools.javaHome && !(await which('java', tools.env))) {
      return {
        ok: false,
        reason: 'JDK 17+ not found; set JAVA_HOME or run mpf doctor',
        env: tools.env,
      }
    }
    if (!(await which('gradle', tools.env))) {
      return {
        ok: false,
        reason: 'gradle not found on PATH (needed once to create the project wrapper)',
        env: tools.env,
      }
    }
    return { ok: true, env: tools.env }
  },

  async scaffold(ctx) {
    const project = projectFor(ctx)
    const files = androidFiles(project)
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(ctx.workspace, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    const embedded = ctx.core
      ? writeCoreEmbed(ctx.workspace, ctx.core, androidCoreEmbed(ctx.core, project.packageName))
      : []
    if (embedded.length)
      ctx.log(`embedded the shared core (${embedded.length} files, Chicory runtime)`)
    const sdk = ctx.env.ANDROID_HOME ?? ctx.env.ANDROID_SDK_ROOT
    if (sdk)
      writeFileSync(
        join(ctx.workspace, 'local.properties'),
        `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`,
      )
    ctx.log(
      `scaffolded ${Object.keys(files).length} files for ${project.packageName}; creating gradle wrapper ${ANDROID_VERSIONS.gradle}`,
    )
    const wrap = await runProcess({
      command: 'gradle',
      args: [
        'wrapper',
        '--gradle-version',
        ANDROID_VERSIONS.gradle,
        '--distribution-type',
        'bin',
        '--console=plain',
        '-q',
      ],
      cwd: ctx.workspace,
      env: ctx.env,
      timeoutMs: 10 * 60_000,
      signal: ctx.signal,
      onStdout: ctx.onOutput,
      onStderr: ctx.onOutput,
    })
    if (wrap.exitCode !== 0) throw new Error(`gradle wrapper failed: ${wrap.stderr.slice(-800)}`)
    chmodSync(join(ctx.workspace, 'gradlew'), 0o755)
    return { files: [...Object.keys(files), ...embedded] }
  },

  workerPrompt(ctx) {
    const project = projectFor(ctx)
    const tags = ctx.spec.screens
      .map(
        (s) =>
          `- screen \`${s.id}\` (route "${s.id}", deep link ${androidDeepLinkBase(project.packageName)}/${s.id}): ${s.elements.map((e) => `\`${e.testId}\` (${e.kind}: ${e.label})`).join(', ') || 'no elements'}`,
      )
      .join('\n')
    return `${androidFiles(project)['MPF.md']}
## Screens and required test tags
${tags}
${ctx.core ? `\n## Shared core\n${androidCoreConventions(ctx.core, project.packageName)}\n` : ''}`
  },

  async build(ctx): Promise<BuildResult> {
    const r = await gradlew(ctx, 'assembleDebug')
    const output = `${r.stdout}\n${r.stderr}`
    const ok = r.exitCode === 0 && existsSync(join(ctx.workspace, APK))
    return {
      ok,
      diagnostics: ok ? [] : parseGradleOutput(output, ctx.workspace),
      product: ok ? APK : undefined,
      durationMs: r.durationMs,
      logTail: output.slice(-4000),
    }
  },

  async unitTest(ctx): Promise<TestOutcome> {
    const r = await gradlew(ctx, 'testDebugUnitTest', ['--continue'])
    const parsed = parseJUnitDir(
      join(ctx.workspace, 'app/build/test-results/testDebugUnitTest'),
      'unit',
    )
    if (r.exitCode !== 0 && parsed.summary.total === 0) {
      const diags = parseGradleOutput(`${r.stdout}\n${r.stderr}`, ctx.workspace)
      return {
        kind: 'unit',
        status: 'error',
        cases: [
          {
            id: 'compile',
            name: 'test compilation',
            status: 'fail',
            durationMs: r.durationMs,
            message: diags
              .map((d) => `${d.file ?? ''}:${d.line ?? ''} ${d.message}`)
              .join('\n')
              .slice(0, 2000),
            artifacts: [],
          },
        ],
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, flaky: 0 },
      }
    }
    return parsed
  },

  async compileFlows(ctx): Promise<CompiledFlow[]> {
    const project = projectFor(ctx)
    const dir = join(ctx.workspace, 'maestro')
    mkdirSync(dir, { recursive: true })
    const out: CompiledFlow[] = []
    for (const b of ctx.behaviors.behaviors) {
      try {
        const flow = compileMaestroFlow(ctx.spec, b, {
          appId: project.packageName,
          platform: 'android',
          deepLinkBase: androidDeepLinkBase(project.packageName),
          seedArgument: SEED_EXTRA,
        })
        const rel = `maestro/${b.id}.yaml`
        writeFileSync(join(ctx.workspace, rel), flow.yaml)
        out.push({
          behaviorId: b.id,
          path: rel,
          unverifiable: flow.unverifiable,
          holeAt: flow.holeAt,
        })
      } catch (err) {
        out.push({ behaviorId: b.id, unverifiable: (err as Error).message })
      }
    }
    return out
  },

  docs(ctx) {
    const project = projectFor(ctx)
    const shipped = shippedAndroidApp(ctx.workspace)
    const appId = shipped?.appId ?? { label: 'Application id', value: project.packageName }
    const minSdk = shipped?.minSdk ?? project.minSdk
    const compileSdk = shipped?.compileSdk ?? project.compileSdk
    return {
      build: './gradlew assembleDebug',
      unitTest: './gradlew testDebugUnitTest',
      e2e: 'maestro test maestro/   # with the debug APK installed on a booted emulator or device',
      product: APK,
      notes: [
        `Application id \`${appId.value}\`${appId.file ? ` (from \`${appId.file}\`)` : ''}; minSdk ${minSdk}, compileSdk ${compileSdk}, Kotlin ${ANDROID_VERSIONS.kotlin}, Compose BOM ${ANDROID_VERSIONS.composeBom}.`,
        `Every screen is a route named by its AppSpec id and opens by deep link \`${androidDeepLinkBase(appId.value)}/<screenId>\`.`,
        `Debug builds seed persisted state from the \`${SEED_EXTRA}\` intent extra (JSON); the end-to-end flows rely on it.`,
        'Compose test tags equal the AppSpec test ids and are exposed as resource ids (`testTagsAsResourceId`), which is what the flows match on.',
      ],
      shipped: {
        appId,
        groups: [
          { title: 'App sources', pattern: /^[^/]+\/src\/main\// },
          { title: 'Unit and instrumented tests', pattern: /^[^/]+\/src\/(test|androidTest)\// },
          { title: 'End-to-end flows', pattern: /^maestro\// },
        ],
        exclude: [
          /(^|\/)(build|\.gradle|\.kotlin|\.idea|screenshots)(\/|$)/,
          new RegExp(`(^|/)${MAESTRO_DEBUG_DIR}(/|$)`),
          /^maestro-report\.xml$/,
        ],
      },
    }
  },

  async e2e(ctx, flows): Promise<E2eResult> {
    const tools = await androidTools(ctx.config, ctx.env)
    if (!tools) throw new Error('Android SDK not found')
    const project = projectFor(ctx)
    const apk = join(ctx.workspace, APK)
    const shotsDir = join(ctx.workspace, 'screenshots')
    mkdirSync(shotsDir, { recursive: true })
    const avd = ctx.env.MPF_ANDROID_AVD ?? (await listAvds(tools))[0] ?? 'mpf-api36'
    const emu = await ensureEmulator(tools, avd, ctx.log, ctx.signal)
    const screenshots: E2eResult['screenshots'] = []
    try {
      ctx.log(`installing ${APK} on ${emu.serial}`)
      await installApk(tools, emu.serial, apk)
      const launch = await launchAndCheck(tools, emu.serial, project.packageName)
      if (launch.dismissedDialog) ctx.log(`before launching: ${launch.dismissedDialog}`)
      const launchOutcome: TestOutcome = {
        kind: 'launch',
        status: launch.ok ? 'pass' : 'fail',
        cases: [
          {
            id: 'launch',
            name: 'app launches and stays alive for 5 s',
            status: launch.ok ? 'pass' : 'fail',
            durationMs: 5000,
            message: launch.crash,
            artifacts: [],
          },
        ],
        summary: {
          total: 1,
          passed: launch.ok ? 1 : 0,
          failed: launch.ok ? 0 : 1,
          skipped: 0,
          flaky: 0,
        },
      }
      if (launch.ok) {
        for (const s of ctx.spec.screens) {
          const check = await launchAndCheck(tools, emu.serial, project.packageName, {
            deepLink: `${androidDeepLinkBase(project.packageName)}/${s.id}`,
            waitMs: 1500,
          })
          const file = join(shotsDir, `${s.id}.png`)
          if (check.ok && (await screencap(tools, emu.serial, file)))
            screenshots.push({ screenId: s.id, file: `screenshots/${s.id}.png` })
          else ctx.log(`screenshot of ${s.id} skipped: ${check.crash ?? 'capture failed'}`)
        }
      }
      let flowOutcome: TestOutcome
      const runnable = flows.filter((f) => f.path)
      if (!launch.ok || !runnable.length) {
        flowOutcome = {
          kind: 'e2e',
          status: 'skip',
          skipReason: launch.ok ? 'no runnable flows' : 'app did not launch',
          cases: [],
          summary: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
        }
      } else {
        await stopApp(tools, emu.serial, project.packageName)
        const maestro = await maestroTools(ctx.config, tools.env)
        if (!maestro) throw new Error('maestro not found; install it or set toolchain.maestro')
        const report = join(ctx.workspace, 'maestro-report.xml')
        // A report from an earlier pass must never stand in for this one: a batch that dies before
        // Maestro writes its report (it only writes at the end) then reads as "no report produced".
        rmSync(report, { force: true })
        // One folder per pass keeps earlier evidence around; lookups take the newest matching flow.
        const debugDir = join(
          ctx.workspace,
          MAESTRO_DEBUG_DIR,
          new Date().toISOString().replace(/[:.]/g, '-'),
        )
        ctx.log(`running ${runnable.length} Maestro flows`)
        const r = await runProcess({
          command: maestro.bin,
          args: [
            '--device',
            emu.serial,
            'test',
            '--format',
            'junit',
            '--output',
            report,
            '--debug-output',
            debugDir,
            // Only the flows asked for: a flake retry of one flow must not rerun the whole suite
            // (a "retry of 1 flow" on RealWorld ran all 24 again).
            ...runnable.map((f) => f.path!),
          ],
          cwd: ctx.workspace,
          env: maestro.env,
          // Maestro writes its report only at the end, so a batch cut off by a timeout reports nothing:
          // give it three minutes a flow (a sign-up flow against a live API runs close to a minute).
          timeoutMs: Math.max(20, 3 * runnable.length) * 60_000,
          signal: ctx.signal,
          onStdout: ctx.onOutput,
          onStderr: ctx.onOutput,
        })
        flowOutcome = parseJUnitFile(report, 'e2e')
        if (flowOutcome.summary.total === 0) {
          flowOutcome = {
            ...flowOutcome,
            status: 'error',
            skipReason: `maestro exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(-600)}`,
          }
        }
        // attribute cases to behaviors by the flow file name / flow name prefix
        for (const c of flowOutcome.cases) {
          const m = /(B-\d{3,})/.exec(`${c.id} ${c.name}`)
          if (m) c.behaviorId = m[1]
          else
            ctx.log(`flow case without a behavior id (not counted against any behavior): ${c.id}`)
          if (c.status === 'fail') attachFlowEvidence(ctx.workspace, c, debugDir)
        }
        for (const f of flows.filter((x) => !x.path)) {
          flowOutcome.cases.push({
            id: f.behaviorId,
            name: f.behaviorId,
            behaviorId: f.behaviorId,
            status: 'skip',
            durationMs: 0,
            message: f.unverifiable,
            artifacts: [],
          })
          flowOutcome.summary.total++
          flowOutcome.summary.skipped++
        }
      }
      return { launch: launchOutcome, flows: flowOutcome, screenshots }
    } finally {
      await stopApp(tools, emu.serial, project.packageName).catch(() => {})
      await emu.stop()
    }
  },
}

export type { AndroidTools }
