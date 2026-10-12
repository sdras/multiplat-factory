import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'pathe'
import { z } from 'zod'
import type {
  AppSpec,
  ArtifactKind,
  BehaviorSpec,
  CoreManifest,
  Diagnostic,
  MpfConfig,
  PortPlan,
  Target,
  TestResult,
} from '@mpf/core'
import type { StageContext, StageOutcome, StageRunner } from '@mpf/harness'
import {
  getTargetAdapter,
  type CompiledFlow,
  type CoreHandoff,
  type TargetAdapter,
  type TargetContext,
  type TestOutcome,
} from '@mpf/adapters'
import { READ_ONLY_BASH, WRITE_BASH, runWorker, workerFailure, type AgentFn } from '@mpf/analyzer'
import { runAgent } from '@mpf/llm'
import { GENERATE_SYSTEM, buildFixPrompt, generatePrompt, testFixPrompt } from './prompts.ts'

export const GenerateResult = z.object({
  filesWritten: z.array(z.string()),
  behaviorsCovered: z.array(z.string()),
  deviations: z.array(z.object({ what: z.string(), why: z.string() })).default([]),
  notes: z.string().default(''),
})
export type GenerateResult = z.infer<typeof GenerateResult>

export interface TargetDeps {
  agent?: AgentFn
  adapterFor?: (target: Target) => TargetAdapter | undefined
  /** Max build-fix rounds (default 3) and test-fix rounds (default 2). */
  buildFixRounds?: number
  testFixRounds?: number
}

const PRODUCT_KIND: Record<Target, ArtifactKind> = {
  web: 'web-dist',
  ios: 'ios-app',
  android: 'android-apk',
}

/** Share of the run budget a fix worker may spend, before it is split across targets. */
const BUILD_FIX_SHARE = 0.2
const TEST_FIX_SHARE = 0.25

function perTarget(ctx: StageContext, share: number): number {
  return share / Math.max(1, ctx.run.targets.length)
}

/** The cap runWorker gives a resumed worker: the same floor and share arithmetic as @mpf/analyzer. */
function resumedWorkerCap(ctx: StageContext, budgetShare: number): number {
  const remaining = Math.max(0, ctx.run.options.budgetUsd - ctx.run.costUsd)
  return Math.max(
    Math.min(5, remaining),
    Math.min(remaining, ctx.run.options.budgetUsd * budgetShare),
  )
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The first few errors as `file:line message`, for a pause reason that fits on one line. */
function firstErrors(diagnostics: Diagnostic[], max = 3): string {
  const errors = diagnostics.filter((d) => d.severity === 'error')
  const shown = errors.slice(0, max).map((d) => {
    const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ''} ` : ''
    return `${where}${oneLine(d.message, 120)}`
  })
  const more = errors.length - shown.length
  return more > 0 ? `${shown.join('; ')}; ${more} more` : shown.join('; ')
}

/**
 * The before-fix-loop checkpoint. When the run asks for it, a stage about to start its first fix
 * worker waits instead of spending. The answer arrives as ctx.humanChoice on the rerun: any
 * choice but reject (which the runner turns into a cancel) lets the loop run without asking
 * again. The build and test results gathered so far were already emitted as events, so the
 * dashboard shows why the run paused.
 */
function fixLoopCheckpoint(
  ctx: StageContext,
  target: Target,
  failure: string,
  budgetShare: number,
): StageOutcome | undefined {
  if (!ctx.run.options.checkpoints.beforeFixLoop || ctx.humanChoice) return undefined
  const cap = resumedWorkerCap(ctx, budgetShare)
  ctx.log('info', `waiting for a decision before the first fix worker for ${target}`)
  return {
    status: 'waiting_human',
    reason: `${failure} Continue to start a fix worker for ${target} with a budget cap of $${cap.toFixed(2)}, or reject to cancel.`,
    choices: [
      { id: 'continue', label: 'Start the fix loop' },
      { id: 'reject', label: 'Reject and cancel' },
    ],
  }
}

interface Prepared {
  adapter: TargetAdapter
  tctx: TargetContext
  target: Target
}

async function prepare(
  ctx: StageContext,
  config: MpfConfig,
  deps: TargetDeps,
): Promise<Prepared | StageOutcome> {
  const target = ctx.stage.target
  if (!target)
    return {
      status: 'failed',
      retryable: false,
      error: { class: 'internal', message: 'stage has no target', diagnostics: [] },
    }
  const adapter = (deps.adapterFor ?? getTargetAdapter)(target)
  if (!adapter)
    return { status: 'skipped', reason: `no target adapter for ${target} in this build` }
  const avail = await adapter.available(config, process.env)
  if (!avail.ok)
    return { status: 'skipped', reason: `${target} toolchain unavailable: ${avail.reason}` }
  const spec = ctx.readJsonArtifact<AppSpec>('appspec')
  const behaviors = ctx.readJsonArtifact<BehaviorSpec>('behaviorspec')
  const plan = ctx.readJsonArtifact<PortPlan>('portplan')
  const targetPlan = plan?.targets.find((t) => t.target === target)
  if (!spec || !behaviors || !plan || !targetPlan) {
    return {
      status: 'failed',
      retryable: false,
      error: {
        class: 'internal',
        message: 'appspec, behaviorspec, or portplan artifact missing',
        diagnostics: [],
      },
    }
  }
  const workspace = join(ctx.run.runDir, 'workspace', target)
  const procId = `${ctx.stage.id}-proc`
  const tctx: TargetContext = {
    run: ctx.run,
    workspace,
    spec,
    behaviors,
    plan: targetPlan,
    core: coreHandoff(ctx),
    config,
    env: avail.env,
    signal: ctx.signal,
    log: (m) => ctx.log('info', m),
    onOutput: (chunk) => ctx.emit({ type: 'proc.stdout', procId, chunk }),
  }
  return { adapter, tctx, target }
}

/** The built core, when core.build succeeded in this run. */
function coreHandoff(ctx: StageContext): CoreHandoff | undefined {
  const build = ctx.store.getStage(ctx.run.id, 'core.build')
  const wasmRel = (build?.result as { wasm?: string } | undefined)?.wasm
  if (build?.status !== 'succeeded' || !wasmRel) return undefined
  const manifest = ctx.readJsonArtifact<CoreManifest>('core-manifest')
  const wasm = join(ctx.run.runDir, wasmRel)
  if (!manifest || !existsSync(wasm)) return undefined
  return { wasm, manifest, vectorsDir: join(ctx.run.runDir, 'core', 'vectors') }
}

function isOutcome(x: Prepared | StageOutcome): x is StageOutcome {
  return 'status' in x
}

function sessionOf(ctx: StageContext, target: Target): string | undefined {
  const gen = ctx.store.getStage(ctx.run.id, `generate:${target}`)
  return (gen?.result as { sessionId?: string } | undefined)?.sessionId
}

/** Scaffold a green project, then let a worker implement the port inside it. */
export function generateStage(config: MpfConfig, deps: TargetDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  return {
    async run(ctx): Promise<StageOutcome> {
      const p = await prepare(ctx, config, deps)
      if (isOutcome(p)) return p
      const { adapter, tctx, target } = p
      rmSync(tctx.workspace, { recursive: true, force: true })
      mkdirSync(tctx.workspace, { recursive: true })
      const scaffolded = await adapter.scaffold(tctx)
      ctx.log(
        'info',
        `scaffold ready (${scaffolded.files.length} files) at ${relative(ctx.run.runDir, tctx.workspace)}`,
      )
      const sourceDir = join(ctx.run.runDir, 'source')
      const coreDir = join(ctx.run.runDir, 'core')
      const readDirs = [sourceDir, ...(existsSync(coreDir) ? [coreDir] : [])]
      const result = await runWorker(
        ctx,
        {
          role: 'generate',
          budgetShare: 0.35 / Math.max(1, ctx.run.targets.length),
          cwd: tctx.workspace,
          readDirs,
          bashAllow: [...adapter.bashAllow, ...WRITE_BASH, ...READ_ONLY_BASH],
          systemPrompt: `${GENERATE_SYSTEM}\n\n# Project conventions\n${adapter.workerPrompt(tctx)}`,
          prompt: generatePrompt({
            target,
            plan: tctx.plan,
            spec: tctx.spec,
            behaviors: tctx.behaviors,
            sourceDir,
            coreDir: existsSync(coreDir) ? coreDir : undefined,
            instructions: ctx.takeInstructions(),
          }),
          outputSchema: GenerateResult,
          maxTurns: 250,
          env: tctx.env,
        },
        agent,
      )
      if (!result.ok) return workerFailure(result, 'generation worker failed')
      const summary = GenerateResult.parse(
        result.structured ?? { filesWritten: [], behaviorsCovered: [] },
      )
      writeFileSync(
        join(ctx.run.runDir, `generate-${target}.json`),
        JSON.stringify({ ...summary, sessionId: result.sessionId }, null, 2),
      )
      ctx.addArtifact({
        kind: 'other',
        relPath: `generate-${target}.json`,
        meta: { target, kind: 'generate-summary' },
      })
      ctx.log(
        'info',
        `worker wrote ${summary.filesWritten.length} files, covers ${summary.behaviorsCovered.length} behaviors, ${summary.deviations.length} deviations`,
      )
      return {
        status: 'succeeded',
        costUsd: result.costUsd,
        result: {
          sessionId: result.sessionId,
          filesWritten: summary.filesWritten.length,
          behaviorsCovered: summary.behaviorsCovered,
          deviations: summary.deviations,
        },
      }
    },
  }
}

/**
 * Fix rounds already spent by earlier attempts of this stage: a pause or a crash mid-round requeues
 * the stage, and its loop must not start over with a fresh allowance of rounds. Each round leaves a
 * marker event behind, which is what gets counted.
 */
function spentFixRounds(ctx: StageContext, kind: 'build' | 'test'): number {
  const marker = `${kind} fix round `
  let spent = 0
  for (const e of ctx.store.listAllEvents(ctx.run.id)) {
    if (e.stageId !== ctx.stage.id || e.type !== 'log') continue
    // A person's explicit rerun of the stage starts its rounds over; a requeue keeps them.
    if (e.message === FIX_ROUNDS_RESET) spent = 0
    else if (e.message.startsWith(marker) && / spent for /.test(e.message)) spent++
  }
  return spent
}

/** Logged on a stage by the orchestrator's rerun; everything spent before it no longer counts. */
export const FIX_ROUNDS_RESET = 'fix rounds reset by an explicit rerun'

/** Build the generated project; on failure, hand diagnostics back to the worker for a bounded number of rounds. */
export function buildStage(config: MpfConfig, deps: TargetDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  const maxRounds = deps.buildFixRounds ?? 3
  return {
    async run(ctx): Promise<StageOutcome> {
      const p = await prepare(ctx, config, deps)
      if (isOutcome(p)) return p
      const { adapter, tctx, target } = p
      const lane = target === 'ios' ? 'xcodebuild' : target === 'android' ? 'gradle' : 'web'
      let cost = 0
      let sessionId = sessionOf(ctx, target)
      for (let round = spentFixRounds(ctx, 'build'); round <= maxRounds; round++) {
        const result = await ctx.lanes.run(lane, () => adapter.build(tctx))
        if (!result.ok && !result.diagnostics.some((d) => d.severity === 'error')) {
          result.diagnostics.push({
            severity: 'error',
            message: `build failed without parseable diagnostics: ${result.logTail.trim().split('\n').slice(-5).join(' ').slice(0, 600)}`,
            tool: 'build',
          })
        }
        const errors = result.diagnostics.filter((d) => d.severity === 'error').length
        ctx.emit({
          type: 'build.result',
          ok: result.ok,
          errors,
          warnings: result.diagnostics.length - errors,
        })
        if (result.ok) {
          if (result.product) {
            ctx.addArtifact({
              kind: PRODUCT_KIND[target],
              relPath: relative(ctx.run.runDir, join(tctx.workspace, result.product)),
              meta: { target },
            })
          }
          ctx.log(
            'info',
            `build succeeded in ${Math.round(result.durationMs / 1000)}s${round ? ` after ${round} fix round(s)` : ''}`,
          )
          return {
            status: 'succeeded',
            costUsd: cost,
            result: { rounds: round, durationMs: result.durationMs, product: result.product },
          }
        }
        ctx.log('warn', `build failed with ${errors} error(s)`)
        if (round === maxRounds || !sessionId) {
          return {
            status: 'failed',
            retryable: false,
            costUsd: cost,
            error: {
              class: 'build-error',
              message: sessionId
                ? `build still failing after ${maxRounds} fix rounds`
                : 'build failed and no worker session is available to fix it',
              diagnostics: result.diagnostics.slice(0, 50),
            },
          }
        }
        if (round === 0) {
          const pause = fixLoopCheckpoint(
            ctx,
            target,
            `Build of ${target} failed with ${errors} error(s): ${firstErrors(result.diagnostics)}.`,
            perTarget(ctx, BUILD_FIX_SHARE),
          )
          if (pause) return pause
        }
        const fix = await runWorker(
          ctx,
          {
            role: 'generate',
            effort: ctx.run.options.effort.generate === 'max' ? 'max' : 'high',
            budgetShare: perTarget(ctx, BUILD_FIX_SHARE),
            cwd: tctx.workspace,
            readDirs: [join(ctx.run.runDir, 'source')],
            bashAllow: [...adapter.bashAllow, ...WRITE_BASH, ...READ_ONLY_BASH],
            systemPrompt: `${GENERATE_SYSTEM}\n\n# Project conventions\n${adapter.workerPrompt(tctx)}`,
            prompt: buildFixPrompt(result.diagnostics, result.logTail, round + 1, maxRounds),
            outputSchema: GenerateResult,
            maxTurns: 120,
            resume: sessionId,
            env: tctx.env,
          },
          agent,
        )
        cost += fix.costUsd
        sessionId = fix.sessionId ?? sessionId
        ctx.log('info', `build fix round ${round + 1}/${maxRounds} spent for ${target}`)
        if (!fix.ok) ctx.log('warn', `fix worker did not finish cleanly: ${fix.error}`)
      }
      return {
        status: 'failed',
        retryable: false,
        costUsd: cost,
        error: { class: 'build-error', message: 'unreachable', diagnostics: [] },
      }
    },
  }
}

/** Unit tests, launch check, screenshots, and end-to-end flows, with a bounded fix loop for must-behaviors. */
export function testStage(config: MpfConfig, deps: TargetDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  const maxRounds = deps.testFixRounds ?? 2
  return {
    async run(ctx): Promise<StageOutcome> {
      const p = await prepare(ctx, config, deps)
      if (isOutcome(p)) return p
      const { adapter, tctx, target } = p
      const deviceLane = target === 'ios' ? 'simulator' : target === 'android' ? 'emulator' : 'web'
      const buildLane = target === 'ios' ? 'xcodebuild' : target === 'android' ? 'gradle' : 'web'
      const must = new Set(
        tctx.behaviors.behaviors.filter((b) => b.priority === 'must').map((b) => b.id),
      )
      let cost = 0
      let sessionId = sessionOf(ctx, target)
      const finish = (r: TestOutcome): TestResult => ({ ...r, stageId: ctx.stage.id, target })

      for (let round = spentFixRounds(ctx, 'test'); round <= maxRounds; round++) {
        if (round > 0) {
          const rebuilt = await ctx.lanes.run(buildLane, () => adapter.build(tctx))
          ctx.emit({
            type: 'build.result',
            ok: rebuilt.ok,
            errors: rebuilt.diagnostics.filter((d) => d.severity === 'error').length,
            warnings: 0,
          })
          if (!rebuilt.ok) {
            return {
              status: 'failed',
              retryable: false,
              costUsd: cost,
              error: {
                class: 'build-error',
                message: 'rebuild after a test fix failed',
                diagnostics: rebuilt.diagnostics.slice(0, 50),
              },
            }
          }
        }
        const results: TestResult[] = []
        const unit = finish(await ctx.lanes.run(buildLane, () => adapter.unitTest(tctx)))
        results.push(unit)
        ctx.emit({ type: 'test.result', result: unit })

        let flows: CompiledFlow[] = []
        // A flow with a hole in it (a custom step the compiler could not express) cannot be trusted to
        // fail for the port's sake: its failure is reported but does not block the target, buy a fix
        // round, or earn a flake retry.
        const partial = new Set<string>()
        if (ctx.run.options.e2e) {
          flows = await adapter.compileFlows(tctx)
          for (const f of flows) if (f.path && f.unverifiable) partial.add(f.behaviorId)
          const unverifiable = flows.filter((f) => !f.path)
          if (unverifiable.length)
            ctx.log(
              'info',
              `${unverifiable.length} behavior(s) cannot be expressed as flows: ${unverifiable.map((f) => f.behaviorId).join(', ')}`,
            )
          const e2e = await ctx.lanes.run(deviceLane, () => adapter.e2e(tctx, flows))
          const launch = finish(e2e.launch)
          let flowsResult = finish(e2e.flows)
          results.push(launch)
          ctx.emit({ type: 'test.result', result: launch })
          // A suite that produced no cases did not run: a Maestro or report failure, not a port
          // defect. That is a stage failure to surface, never a pass and never a fix round.
          if (
            flowsResult.status === 'error' &&
            flowsResult.cases.length === 0 &&
            flows.some((f) => f.path)
          ) {
            results.push(flowsResult)
            ctx.emit({ type: 'test.result', result: flowsResult })
            return {
              status: 'failed',
              costUsd: 0,
              retryable: true,
              error: {
                class: 'build-error',
                message: `the ${target} end-to-end suite produced no results: the flow runner failed or timed out before its report was written`,
                diagnostics: [],
              },
            }
          }
          const mustFailed = flowsResult.cases.some(
            (c) =>
              c.status === 'fail' &&
              c.behaviorId &&
              must.has(c.behaviorId) &&
              !partial.has(c.behaviorId),
          )
          if (mustFailed && launch.status === 'pass') {
            // one retry of the failed flows only: cases that pass now are flaky, not failures
            const failedIds = new Set(
              flowsResult.cases.filter((c) => c.status === 'fail').map((c) => c.behaviorId),
            )
            const failedFlows = flows.filter((f) => f.path && failedIds.has(f.behaviorId))
            ctx.log(
              'info',
              `${flowsResult.summary.failed} flow(s) failed; retrying ${failedFlows.length} of them once to separate flaky from real failures`,
            )
            const again = await ctx.lanes.run(deviceLane, () => adapter.e2e(tctx, failedFlows))
            const passedNow = new Set(
              again.flows.cases.filter((c) => c.status === 'pass').map((c) => c.id),
            )
            for (const c of flowsResult.cases)
              if (c.status === 'fail' && passedNow.has(c.id)) c.status = 'flaky'
            const failed = flowsResult.cases.filter((c) => c.status === 'fail').length
            const flaky = flowsResult.cases.filter((c) => c.status === 'flaky').length
            flowsResult = {
              ...flowsResult,
              status: failed ? 'fail' : 'pass',
              summary: {
                ...flowsResult.summary,
                failed,
                flaky,
                passed: flowsResult.summary.passed + flaky,
              },
            }
          }
          results.push(flowsResult)
          ctx.emit({ type: 'test.result', result: flowsResult })
          for (const s of e2e.screenshots) {
            ctx.addArtifact({
              kind: 'target-screenshot',
              relPath: relative(ctx.run.runDir, join(tctx.workspace, s.file)),
              meta: { target, screenId: s.screenId, behaviorId: s.behaviorId },
            })
          }
        }

        const hardFailures = new Set<string>()
        const partialFailures = new Set<string>()
        for (const r of results) {
          if (r.kind === 'launch' && r.status === 'fail') hardFailures.add('launch')
          if (r.kind === 'unit' && (r.status === 'fail' || r.status === 'error'))
            hardFailures.add('unit')
          for (const c of r.cases)
            if (c.status === 'fail' && c.behaviorId && must.has(c.behaviorId)) {
              if (partial.has(c.behaviorId)) partialFailures.add(c.behaviorId)
              else hardFailures.add(c.behaviorId)
            }
        }
        if (partialFailures.size)
          ctx.log(
            'warn',
            `${partialFailures.size} failing flow(s) contain a step the compiler could not express and do not block the target: ${[...partialFailures].join(', ')}`,
          )
        const summary = results
          .map((r) => `${r.kind} ${r.status} ${r.summary.passed}/${r.summary.total}`)
          .join(', ')
        if (hardFailures.size === 0) {
          ctx.log('info', `tests: ${summary}${round ? ` after ${round} fix round(s)` : ''}`)
          return {
            status: 'succeeded',
            costUsd: cost,
            result: {
              rounds: round,
              summary,
              results: results.map((r) => ({ kind: r.kind, status: r.status, ...r.summary })),
            },
          }
        }
        ctx.log('warn', `tests: ${summary}; blocking failures: ${[...hardFailures].join(', ')}`)
        if (round === maxRounds || !sessionId) {
          return {
            status: 'failed',
            retryable: false,
            costUsd: cost,
            error: {
              class: 'test-failure',
              message: `blocking failures remain after ${round} fix round(s): ${[...hardFailures].join(', ')}`,
              diagnostics: [],
            },
          }
        }
        if (round === 0) {
          const blocking = [...hardFailures]
          const more = blocking.length > 5 ? ` and ${blocking.length - 5} more` : ''
          const pause = fixLoopCheckpoint(
            ctx,
            target,
            `Tests for ${target}: ${summary}; blocking failures: ${blocking.slice(0, 5).join(', ')}${more}.`,
            perTarget(ctx, TEST_FIX_SHARE),
          )
          if (pause) return pause
        }
        const fix = await runWorker(
          ctx,
          {
            role: 'generate',
            effort: 'high',
            budgetShare: perTarget(ctx, TEST_FIX_SHARE),
            cwd: tctx.workspace,
            readDirs: [join(ctx.run.runDir, 'source')],
            bashAllow: [...adapter.bashAllow, ...WRITE_BASH, ...READ_ONLY_BASH],
            systemPrompt: `${GENERATE_SYSTEM}\n\n# Project conventions\n${adapter.workerPrompt(tctx)}`,
            prompt: testFixPrompt(
              results,
              [...hardFailures].filter((h) => must.has(h)),
              round + 1,
              maxRounds,
            ),
            outputSchema: GenerateResult,
            maxTurns: 120,
            resume: sessionId,
            env: tctx.env,
          },
          agent,
        )
        cost += fix.costUsd
        sessionId = fix.sessionId ?? sessionId
        ctx.log('info', `test fix round ${round + 1}/${maxRounds} spent for ${target}`)
      }
      return {
        status: 'failed',
        retryable: false,
        costUsd: cost,
        error: { class: 'test-failure', message: 'unreachable', diagnostics: [] },
      }
    },
  }
}
