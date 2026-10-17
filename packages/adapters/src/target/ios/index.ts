import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'pathe'
import {
  derivedProductsDir,
  ensureSimulator,
  installIosApp,
  launchIosApp,
  maestroTools,
  runProcess,
  simScreenshot,
  terminateApp,
  which,
  xcodeTools,
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
import { writeCoreEmbed } from '../../core/embed.ts'
import { iosCoreConventions, iosCoreEmbed } from '../../core/ios.ts'
import { parseJUnitFile } from '../junit.ts'
import { compileMaestroFlow } from '../maestro.ts'
import { MAESTRO_DEBUG_DIR, attachFlowEvidence } from '../maestro-evidence.ts'
import { parseXcodebuildOutput, parseXcodebuildTests } from '../xcodebuild.ts'
import {
  IOS_DEEP_LINK_SCHEME,
  IOS_ROUTE_KEY,
  IOS_SEED_KEY,
  bundleIdFor,
  iosFiles,
  iosProjectNameFor,
  type IosProject,
} from './template.ts'

const DERIVED = 'build/DerivedData'

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Read the app target's bundle id from the workspace: `project.yml` first (the source of
 * truth for XcodeGen projects; the test bundle's id ends in `tests` and is skipped), then a
 * generated `.xcodeproj`. Undefined when neither declares one.
 */
export function shippedIosBundleId(workspace: string): ShippedAppId | undefined {
  const pick = (ids: string[]) => ids.find((id) => !/tests?$/i.test(id)) ?? ids[0]
  const yml = readText(join(workspace, 'project.yml'))
  if (yml) {
    const id = pick(
      [...yml.matchAll(/PRODUCT_BUNDLE_IDENTIFIER:\s*["']?([^\s"']+)/g)].map((m) => m[1]!),
    )
    if (id) return { label: 'Bundle id', value: id, file: 'project.yml' }
  }
  let entries: string[]
  try {
    entries = readdirSync(workspace)
  } catch {
    return undefined
  }
  for (const entry of entries.filter((e) => e.endsWith('.xcodeproj')).sort()) {
    const rel = `${entry}/project.pbxproj`
    const pbx = readText(join(workspace, rel))
    if (!pbx) continue
    const id = pick(
      [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^;"\s]+)"?\s*;/g)].map((m) => m[1]!),
    )
    if (id) return { label: 'Bundle id', value: id, file: rel }
  }
  return undefined
}

export function iosProjectFor(ctx: TargetContext): IosProject {
  return {
    name: iosProjectNameFor(ctx.spec.name),
    appName: ctx.spec.name,
    bundleId: bundleIdFor(ctx.spec.name),
    screens: ctx.spec.screens.map((s) => ({ id: s.id, name: s.name })),
    rootScreen: ctx.spec.navigation.root,
    core: !!ctx.core,
  }
}

function xcodebuildArgs(
  project: IosProject,
  action: 'build' | 'test',
  destination: string,
): string[] {
  return [
    '-project',
    `${project.name}.xcodeproj`,
    '-scheme',
    project.name,
    '-configuration',
    'Debug',
    '-sdk',
    'iphonesimulator',
    '-destination',
    destination,
    '-derivedDataPath',
    DERIVED,
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGN_IDENTITY=',
    ...(action === 'build' ? ['-quiet'] : []),
    action,
  ]
}

export const iosTarget: TargetAdapter = {
  id: 'ios-swiftui',
  target: 'ios',

  bashAllow: [
    /^xcodegen\b/,
    /^xcodebuild\b/,
    /^xcrun (simctl|swift)\b/,
    /^swift\b/,
    /^(ls|cat|head|tail|wc|find|tree|grep|rg|mkdir|touch|mv|cp|rm|plutil)\b/,
    /^git (status|diff|log|ls-files)\b/,
  ],

  async available(config, env) {
    if (process.platform !== 'darwin')
      return { ok: false, reason: 'iOS targets require macOS with Xcode', env }
    const tools = await xcodeTools(config, env)
    if (!tools)
      return {
        ok: false,
        reason: 'no full Xcode found; install Xcode and set DEVELOPER_DIR or run xcode-select -s',
        env,
      }
    if (!(await which('xcodegen', tools.env)))
      return { ok: false, reason: 'xcodegen not found (brew install xcodegen)', env: tools.env }
    return { ok: true, env: tools.env }
  },

  async scaffold(ctx) {
    const project = iosProjectFor(ctx)
    const files = iosFiles(project)
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(ctx.workspace, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    const embedded = ctx.core
      ? writeCoreEmbed(ctx.workspace, ctx.core, iosCoreEmbed(ctx.core, project.name))
      : []
    if (embedded.length)
      ctx.log(`embedded the shared core (${embedded.length} files, WasmKit package)`)
    ctx.log(
      `scaffolded ${Object.keys(files).length} files for ${project.bundleId}; generating Xcode project`,
    )
    const gen = await runProcess({
      command: 'xcodegen',
      args: ['generate', '--quiet'],
      cwd: ctx.workspace,
      env: ctx.env,
      timeoutMs: 120_000,
      signal: ctx.signal,
      onStdout: ctx.onOutput,
      onStderr: ctx.onOutput,
    })
    if (gen.exitCode !== 0)
      throw new Error(`xcodegen failed: ${(gen.stderr || gen.stdout).slice(-800)}`)
    return { files: [...Object.keys(files), ...embedded] }
  },

  workerPrompt(ctx) {
    const project = iosProjectFor(ctx)
    const tags = ctx.spec.screens
      .map(
        (s) =>
          `- screen \`${s.id}\` (route "${s.id}", deep link ${IOS_DEEP_LINK_SCHEME}://${project.bundleId}/${s.id}): ${s.elements.map((e) => `\`${e.testId}\` (${e.kind}: ${e.label})`).join(', ') || 'no elements'}`,
      )
      .join('\n')
    return `${iosFiles(project)['MPF.md']}
## Screens and required accessibility identifiers
${tags}
${ctx.core ? `\n## Shared core\n${iosCoreConventions(ctx.core)}\n` : ''}`
  },

  async build(ctx): Promise<BuildResult> {
    const project = iosProjectFor(ctx)
    if (!existsSync(join(ctx.workspace, `${project.name}.xcodeproj`))) {
      const gen = await runProcess({
        command: 'xcodegen',
        args: ['generate', '--quiet'],
        cwd: ctx.workspace,
        env: ctx.env,
        timeoutMs: 120_000,
        signal: ctx.signal,
      })
      if (gen.exitCode !== 0)
        return {
          ok: false,
          diagnostics: [
            {
              severity: 'error',
              message: `xcodegen failed: ${(gen.stderr || gen.stdout).slice(-600)}`,
              tool: 'xcodegen',
            },
          ],
          durationMs: gen.durationMs,
          logTail: gen.stderr.slice(-2000),
        }
    }
    const r = await runProcess({
      command: 'xcodebuild',
      args: xcodebuildArgs(project, 'build', 'generic/platform=iOS Simulator'),
      cwd: ctx.workspace,
      env: ctx.env,
      timeoutMs: 30 * 60_000,
      signal: ctx.signal,
      onStdout: ctx.onOutput,
      onStderr: ctx.onOutput,
    })
    const output = `${r.stdout}\n${r.stderr}`
    const product = `${derivedProductsDir(DERIVED)}/${project.name}.app`
    const ok = r.exitCode === 0 && existsSync(join(ctx.workspace, product))
    return {
      ok,
      diagnostics: ok ? [] : parseXcodebuildOutput(output, ctx.workspace),
      product: ok ? product : undefined,
      durationMs: r.durationMs,
      logTail: output.slice(-4000),
    }
  },

  async unitTest(ctx): Promise<TestOutcome> {
    const project = iosProjectFor(ctx)
    const tools = await xcodeTools(ctx.config, ctx.env)
    if (!tools)
      return {
        kind: 'unit',
        status: 'error',
        skipReason: 'Xcode not found',
        cases: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
      }
    const sim = await ensureSimulator(tools, 'mpf-iphone', ctx.log, ctx.signal)
    try {
      const r = await runProcess({
        command: 'xcodebuild',
        args: xcodebuildArgs(project, 'test', `platform=iOS Simulator,id=${sim.udid}`),
        cwd: ctx.workspace,
        env: ctx.env,
        timeoutMs: 30 * 60_000,
        signal: ctx.signal,
        onStdout: ctx.onOutput,
        onStderr: ctx.onOutput,
      })
      const parsed = parseXcodebuildTests(`${r.stdout}\n${r.stderr}`, 'unit')
      if (r.exitCode !== 0 && parsed.summary.total === 0) {
        const diags = parseXcodebuildOutput(`${r.stdout}\n${r.stderr}`, ctx.workspace)
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
    } finally {
      await sim.stop()
    }
  },

  async compileFlows(ctx): Promise<CompiledFlow[]> {
    const project = iosProjectFor(ctx)
    const dir = join(ctx.workspace, 'maestro')
    mkdirSync(dir, { recursive: true })
    const out: CompiledFlow[] = []
    for (const b of ctx.behaviors.behaviors) {
      try {
        const flow = compileMaestroFlow(ctx.spec, b, {
          appId: project.bundleId,
          platform: 'ios',
          deepLinkBase: `${IOS_DEEP_LINK_SCHEME}://${project.bundleId}`,
          seedArgument: IOS_SEED_KEY,
          navigation: 'launch-argument',
          routeArgument: IOS_ROUTE_KEY,
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
    const project = iosProjectFor(ctx)
    const appId = shippedIosBundleId(ctx.workspace) ?? {
      label: 'Bundle id',
      value: project.bundleId,
    }
    const common = `-project ${project.name}.xcodeproj -scheme ${project.name} -sdk iphonesimulator -derivedDataPath ${DERIVED} CODE_SIGNING_ALLOWED=NO`
    return {
      build: `xcodegen generate && xcodebuild ${common} -destination 'generic/platform=iOS Simulator' build`,
      unitTest: `xcodebuild ${common} -destination 'platform=iOS Simulator,name=<a simulator>' test`,
      e2e: 'maestro test maestro/   # with the app installed on a booted simulator',
      product: `${derivedProductsDir(DERIVED)}/${project.name}.app`,
      notes: [
        `Bundle id \`${appId.value}\`${appId.file ? ` (from \`${appId.file}\`)` : ''}; the Xcode project is generated from \`project.yml\` by XcodeGen, so edit \`project.yml\`, not the \`.xcodeproj\`.`,
        `Every screen is a route named by its AppSpec id. The \`${IOS_ROUTE_KEY}\` launch argument (or environment variable) opens a screen directly; \`${IOS_DEEP_LINK_SCHEME}://${appId.value}/<screenId>\` does the same from outside the app.`,
        `Debug builds seed persisted state from the \`${IOS_SEED_KEY}\` launch argument (JSON); the end-to-end flows rely on it.`,
        'Accessibility identifiers equal the AppSpec test ids, which is what the flows match on.',
      ],
      shipped: {
        appId,
        groups: [
          { title: 'App sources', pattern: /^App\// },
          { title: 'Unit tests', pattern: /^[^/]*Tests\// },
          { title: 'End-to-end flows', pattern: /^maestro\// },
        ],
        exclude: [
          /(^|\/)(build|DerivedData|screenshots)(\/|$)/,
          /\.xcodeproj(\/|$)/,
          new RegExp(`(^|/)${MAESTRO_DEBUG_DIR}(/|$)`),
          /^maestro-report\.xml$/,
        ],
      },
    }
  },

  async e2e(ctx, flows): Promise<E2eResult> {
    const tools = await xcodeTools(ctx.config, ctx.env)
    if (!tools) throw new Error('Xcode not found')
    const project = iosProjectFor(ctx)
    const app = join(ctx.workspace, derivedProductsDir(DERIVED), `${project.name}.app`)
    const shotsDir = join(ctx.workspace, 'screenshots')
    mkdirSync(shotsDir, { recursive: true })
    const sim = await ensureSimulator(tools, 'mpf-iphone', ctx.log, ctx.signal)
    // Maestro also clears a stale system dialog before each launch (see dismissSystemDialogs).
    const maestroForLaunch = await maestroTools(ctx.config, tools.env)
    const dismiss = maestroForLaunch ? { maestro: maestroForLaunch } : {}
    const screenshots: E2eResult['screenshots'] = []
    try {
      ctx.log(`installing ${project.name}.app on ${sim.udid}`)
      await installIosApp(tools, sim.udid, app)
      const launch = await launchIosApp(tools, sim.udid, project.bundleId, dismiss)
      if (launch.dismissedDialog) ctx.log(`before launching: dismissed ${launch.dismissedDialog}`)
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
          const check = await launchIosApp(tools, sim.udid, project.bundleId, {
            env: { [IOS_ROUTE_KEY]: s.id },
            waitMs: 1500,
            ...dismiss,
          })
          const file = join(shotsDir, `${s.id}.png`)
          if (check.ok && (await simScreenshot(tools, sim.udid, file)))
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
        await terminateApp(tools, sim.udid, project.bundleId)
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
            sim.udid,
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
        if (flowOutcome.summary.total === 0)
          flowOutcome = {
            ...flowOutcome,
            status: 'error',
            skipReason: `maestro exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(-600)}`,
          }
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
      await terminateApp(tools, sim.udid, project.bundleId).catch(() => {})
      await sim.stop()
    }
  },
}
