import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'pathe'
import type { AppSpec, BehaviorSpec } from '@mpf/core'
import {
  androidTools,
  ensureEmulator,
  ensureSimulator,
  findFreePort,
  installApk,
  installIosApp,
  launchAndCheck,
  launchIosApp,
  listAvds,
  maestroTools,
  runProcess,
  stopApp,
  terminateApp,
  xcodeTools,
  type StageContext,
  type StageOutcome,
  type StageRunner,
} from '@mpf/harness'
import {
  MAESTRO_DEBUG_DIR,
  attachFlowEvidence,
  compileMaestroFlow,
  findNamedScreenshot,
  getSourceAdapter,
  makeDetectContext,
  parseJUnitFile,
  type MobileSourceApp,
  type SourceAdapter,
  type SourceTestCommand,
  type TestOutcome,
} from '@mpf/adapters'
import { executeBehavior, launchChromium, screenshotScreens } from '../observe/web.ts'
import type { DetectionArtifact } from './ingest.ts'

interface Tally {
  verified: number
  unverifiable: number
  screenshots: number
  failures: { id: string; error: string }[]
}

/**
 * Runs the source app and walks the behaviors against it. Failures here never fail
 * the run: unverified behaviors are labeled so the critic and the tests know.
 */
export function observeStage(): StageRunner {
  return {
    async run(ctx: StageContext): Promise<StageOutcome> {
      const detection = ctx.readJsonArtifact<DetectionArtifact>('detection')
      const spec = ctx.readJsonArtifact<AppSpec>('appspec')
      const behaviors = ctx.readJsonArtifact<BehaviorSpec>('behaviorspec')
      if (!detection || !spec || !behaviors) {
        return {
          status: 'failed',
          retryable: false,
          error: {
            class: 'internal',
            message: 'detection, appspec, or behaviorspec artifact missing',
            diagnostics: [],
          },
        }
      }
      const adapter = getSourceAdapter(detection.best.adapterId)
      const sourceDir = join(ctx.run.runDir, 'source')
      const outDir = join(ctx.run.runDir, 'observe')
      const tally: Tally = { verified: 0, unverifiable: 0, screenshots: 0, failures: [] }

      if (adapter?.observe) {
        await ctx.lanes.run('web', () =>
          observeWeb(ctx, adapter, detection, spec, behaviors, sourceDir, outDir, tally),
        )
        await runSourceTests(ctx, adapter, sourceDir, outDir)
      } else if (adapter?.observeMobile) {
        const built = await adapter.observeMobile(makeDetectContext(sourceDir), detection.best, {
          outDir,
          config: ctx.config,
          env: process.env,
          signal: ctx.signal,
          log: (m) => ctx.log('info', m),
          onOutput: (chunk) => ctx.emit({ type: 'proc.stdout', procId: 'observe-build', chunk }),
        })
        if (!built)
          return {
            status: 'skipped',
            reason: `the ${detection.best.platform} source could not be built for observation; behaviors stay unverified`,
          }
        ctx.log('info', `built ${built.appId} (${built.notes.join(', ')})`)
        await ctx.lanes.run(built.platform === 'ios' ? 'simulator' : 'emulator', () =>
          observeMobile(ctx, built, spec, behaviors, outDir, tally, (device) =>
            runSourceTests(ctx, adapter, sourceDir, outDir, device),
          ),
        )
      } else {
        return {
          status: 'skipped',
          reason: `observation for ${detection.best.platform} (${detection.best.adapterId}) sources is not available in this build; behaviors stay unverified`,
        }
      }

      writeFileSync(join(ctx.run.runDir, 'behaviorspec.json'), JSON.stringify(behaviors, null, 2))
      ctx.addArtifact({
        kind: 'behaviorspec',
        relPath: 'behaviorspec.json',
        meta: { verified: true },
      })
      const total = behaviors.behaviors.length
      ctx.log(
        'info',
        `${tally.verified}/${total} behaviors verified on the source app; ${tally.failures.length} failed, ${tally.unverifiable} unverifiable; ${tally.screenshots} screen captures`,
      )
      return {
        status: 'succeeded',
        result: {
          verified: tally.verified,
          total,
          unverifiable: tally.unverifiable,
          screenshots: tally.screenshots,
          failures: tally.failures,
        },
      }
    },
  }
}

async function observeWeb(
  ctx: StageContext,
  adapter: NonNullable<ReturnType<typeof getSourceAdapter>>,
  detection: DetectionArtifact,
  spec: AppSpec,
  behaviors: BehaviorSpec,
  sourceDir: string,
  outDir: string,
  tally: Tally,
): Promise<void> {
  const port = await findFreePort()
  const session = await adapter.observe!(makeDetectContext(sourceDir), detection.best, {
    port,
    signal: ctx.signal,
    log: (m) => ctx.emit({ type: 'proc.stdout', procId: 'observe', chunk: `${m}\n` }),
  })
  ctx.log('info', `source app is serving at ${session.url}`)
  let browser
  try {
    browser = await launchChromium()
  } catch (err) {
    ctx.log('warn', `${(err as Error).message}; behaviors stay unverified`)
    await session.stop()
    return
  }
  try {
    const shots = await screenshotScreens(browser, session.url, spec, outDir, (m) =>
      ctx.log('warn', m),
    )
    for (const s of shots) {
      ctx.addArtifact({
        kind: 'source-screenshot',
        relPath: relative(ctx.run.runDir, s.file),
        meta: { screenId: s.screenId },
      })
      tally.screenshots++
    }
    for (const b of behaviors.behaviors) {
      if (ctx.signal.aborted) break
      const file = join(outDir, 'behaviors', `${b.id}.png`)
      const r = await executeBehavior(browser, session.url, spec, b, file, (m) =>
        ctx.log('warn', m),
      )
      b.verifiedOnSource = r.ok
      b.observedScreenshot = relative(ctx.run.runDir, file)
      ctx.addArtifact({
        kind: 'source-screenshot',
        relPath: b.observedScreenshot,
        meta: { behaviorId: b.id, verified: r.ok },
      })
      if (r.ok) tally.verified++
      else if (r.unverifiable) tally.unverifiable++
      else tally.failures.push({ id: b.id, error: r.error ?? 'unknown' })
      ctx.log(
        r.ok ? 'info' : 'warn',
        `${b.id} ${b.title}: ${r.ok ? 'verified on source' : r.error}${r.notes?.length ? ` (${r.notes.length} custom step(s) skipped)` : ''}`,
      )
    }
  } finally {
    await browser.close().catch(() => {})
    await session.stop()
  }
}

/**
 * Walk the behaviors on the built source app: flows compile in `none` navigation mode (clean
 * launch, taps along the AppSpec's edges), so behaviors that need seeds or deep links are
 * unverifiable with a reason. Flows run through Maestro on the simulator or emulator, and the
 * source's own tests run on the same booted device before it is released.
 */
async function observeMobile(
  ctx: StageContext,
  app: MobileSourceApp,
  spec: AppSpec,
  behaviors: BehaviorSpec,
  outDir: string,
  tally: Tally,
  afterFlows: (device: string) => Promise<void>,
): Promise<void> {
  // The hooks the source really exposes decide what a flow may match by id; the rest goes by text or stays unverifiable.
  const sourceHooks =
    ctx.readJsonArtifact<{ hints?: { testHooks?: string[] } }>('inventory')?.hints?.testHooks ?? []
  if (!sourceHooks.length)
    ctx.log(
      'warn',
      'the inventory found no test hooks in the source; flows can only match visible text',
    )
  const flowsDir = join(outDir, 'maestro')
  const shotsDir = join(outDir, 'behaviors')
  mkdirSync(flowsDir, { recursive: true })
  mkdirSync(shotsDir, { recursive: true })
  const runnable: string[] = []
  for (const b of behaviors.behaviors) {
    try {
      // Maestro only writes screenshots inside its working directory, by name; they are moved afterwards.
      const flow = compileMaestroFlow(spec, b, {
        appId: app.appId,
        deepLinkBase: '',
        seedArgument: '',
        navigation: 'none',
        screenshotPath: b.id,
        sourceHooks,
        platform: app.platform,
      })
      if (!flow.yaml) {
        b.verifiedOnSource = false
        tally.unverifiable++
        ctx.log('info', `${b.id}: unverifiable on the source app (${flow.unverifiable})`)
        continue
      }
      writeFileSync(join(flowsDir, `${b.id}.yaml`), flow.yaml)
      runnable.push(b.id)
    } catch (err) {
      b.verifiedOnSource = false
      tally.unverifiable++
      ctx.log('warn', `${b.id}: ${(err as Error).message}`)
    }
  }
  const maestro = runnable.length ? await maestroTools(ctx.config, app.env) : undefined
  if (!runnable.length)
    ctx.log('warn', 'no behavior can be walked on the source app without the factory hooks')
  else if (!maestro) ctx.log('warn', 'maestro not found; behaviors stay unverified')

  let device: string
  let stop: () => Promise<void>
  let install: () => Promise<void>
  let launch: () => Promise<{ ok: boolean; crash?: string; dismissedDialog?: string }>
  let quit: () => Promise<void>
  if (app.platform === 'ios') {
    const tools = await xcodeTools(ctx.config, app.env)
    if (!tools) return ctx.log('warn', 'Xcode not found; behaviors stay unverified')
    const sim = await ensureSimulator(tools, 'mpf-iphone', (m) => ctx.log('info', m), ctx.signal)
    device = sim.udid
    stop = sim.stop
    install = () => installIosApp(tools, sim.udid, app.product)
    launch = () => launchIosApp(tools, sim.udid, app.appId, maestro ? { maestro } : {})
    quit = () => terminateApp(tools, sim.udid, app.appId)
  } else {
    const tools = await androidTools(ctx.config, app.env)
    if (!tools) return ctx.log('warn', 'Android SDK not found; behaviors stay unverified')
    const avd = process.env.MPF_ANDROID_AVD ?? (await listAvds(tools))[0] ?? 'mpf-api36'
    const emu = await ensureEmulator(tools, avd, (m) => ctx.log('info', m), ctx.signal)
    device = emu.serial
    stop = emu.stop
    install = () => installApk(tools, emu.serial, app.product)
    launch = () => launchAndCheck(tools, emu.serial, app.appId)
    quit = () => stopApp(tools, emu.serial, app.appId)
  }

  const walk = async () => {
    if (!maestro) return
    const report = join(outDir, 'maestro-report.xml')
    const debugDir = join(outDir, MAESTRO_DEBUG_DIR, new Date().toISOString().replace(/[:.]/g, '-'))
    const onOutput = (chunk: string) => ctx.emit({ type: 'proc.stdout', procId: 'observe', chunk })
    ctx.log('info', `installing ${app.appId} on ${device}`)
    await install()
    const first = await launch()
    if (first.dismissedDialog)
      ctx.log('warn', `before launching the source app: ${first.dismissedDialog}`)
    if (!first.ok) {
      ctx.log(
        'warn',
        `the source app did not stay alive after launch: ${first.crash ?? 'unknown'}; behaviors stay unverified`,
      )
      return
    }
    await quit().catch(() => {})
    ctx.log('info', `running ${runnable.length} Maestro flows on the source app`)
    const r = await runProcess({
      command: maestro.bin,
      args: [
        '--device',
        device,
        'test',
        '--format',
        'junit',
        '--output',
        report,
        '--debug-output',
        debugDir,
        flowsDir,
      ],
      cwd: outDir,
      env: maestro.env,
      timeoutMs: 30 * 60_000,
      signal: ctx.signal,
      onStdout: onOutput,
      onStderr: onOutput,
    })
    const outcome = parseJUnitFile(report, 'e2e')
    if (outcome.summary.total === 0) {
      ctx.log(
        'warn',
        `maestro exited ${r.exitCode} without a report: ${(r.stderr || r.stdout).slice(-400)}`,
      )
      return
    }
    const byBehavior = new Map<string, (typeof outcome.cases)[number]>()
    for (const c of outcome.cases) {
      const m = /(B-\d{3,})/.exec(`${c.id} ${c.name}`)
      if (m) byBehavior.set(m[1]!, c)
    }
    const shotForScreen = new Map<string, string>()
    for (const b of behaviors.behaviors) {
      if (!runnable.includes(b.id)) continue
      const c = byBehavior.get(b.id)
      const ok = c?.status === 'pass'
      b.verifiedOnSource = ok
      const shot = join(shotsDir, `${b.id}.png`)
      const taken = existsSync(join(outDir, `${b.id}.png`))
        ? join(outDir, `${b.id}.png`)
        : findNamedScreenshot(debugDir, b.id)
      if (taken && taken !== shot) renameSync(taken, shot)
      if (c && !ok) attachFlowEvidence(outDir, c)
      if (existsSync(shot)) {
        b.observedScreenshot = relative(ctx.run.runDir, shot)
        ctx.addArtifact({
          kind: 'source-screenshot',
          relPath: b.observedScreenshot,
          meta: { behaviorId: b.id, verified: ok },
        })
        tally.screenshots++
        if (ok && !shotForScreen.has(b.screen)) shotForScreen.set(b.screen, b.observedScreenshot)
      }
      if (ok) tally.verified++
      else tally.failures.push({ id: b.id, error: c?.message ?? 'no result from Maestro' })
      ctx.log(
        ok ? 'info' : 'warn',
        `${b.id} ${b.title}: ${ok ? 'verified on source' : (c?.message ?? 'no result').split('\n')[0]}`,
      )
    }
    for (const [screenId, rel] of shotForScreen)
      ctx.addArtifact({ kind: 'source-screenshot', relPath: rel, meta: { screenId } })
  }

  try {
    await walk()
    await quit().catch(() => {})
    if (!ctx.signal?.aborted) await afterFlows(device)
  } finally {
    await quit().catch(() => {})
    await stop()
  }
}

const NO_CASES = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 }

/**
 * Run the project's own test suite once and record it as a `source` result: the baseline the
 * ported tests are measured against, and an early sign of a source that is broken before porting.
 */
export async function runSourceTests(
  ctx: StageContext,
  adapter: SourceAdapter,
  sourceDir: string,
  outDir: string,
  device?: string,
): Promise<void> {
  if (!adapter.existingTests || ctx.signal?.aborted) return
  let cmd: SourceTestCommand | undefined
  try {
    cmd = await adapter.existingTests(makeDetectContext(sourceDir), {
      config: ctx.config,
      env: process.env,
      outDir,
      device,
      log: (m) => ctx.log('info', m),
    })
  } catch (err) {
    ctx.log('warn', `could not prepare the source's own tests: ${(err as Error).message}`)
    return
  }
  if (!cmd) {
    ctx.log('info', 'the source has no test suite the factory can run here')
    return
  }
  const timeoutMs = cmd.timeoutMs ?? 20 * 60_000
  ctx.log(
    'info',
    `running the source's own tests: ${[basename(cmd.command), ...cmd.args].join(' ')}`,
  )
  const onOutput = (chunk: string) =>
    ctx.emit({ type: 'proc.stdout', procId: 'source-tests', chunk })
  const r = await runProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: cmd.cwd ?? sourceDir,
    env: { ...process.env, ...cmd.env },
    timeoutMs,
    signal: ctx.signal,
    onStdout: onOutput,
    onStderr: onOutput,
  })
  const outcome: TestOutcome =
    r.timedOut || r.cancelled
      ? {
          kind: 'unit',
          status: 'error',
          skipReason: r.timedOut
            ? `timed out after ${Math.round(timeoutMs / 60_000)} min`
            : 'cancelled',
          cases: [],
          summary: NO_CASES,
        }
      : cmd.summarize({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? 1 })
  ctx.emit({ type: 'test.result', result: { ...outcome, stageId: ctx.stage.id, target: 'source' } })
  ctx.log(
    outcome.status === 'pass' ? 'info' : 'warn',
    `source tests: ${outcome.status} ${outcome.summary.passed}/${outcome.summary.total}${outcome.skipReason ? ` (${outcome.skipReason})` : ''}`,
  )
}
