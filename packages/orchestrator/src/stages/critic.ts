import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import {
  CriticOutput,
  type AppSpec,
  type BehaviorSpec,
  type Diagnostic,
  type MpfConfig,
  type PortPlan,
  type Target,
  type TestResult,
  type Verdict,
} from '@mpf/core'
import type { StageContext, StageOutcome, StageRunner } from '@mpf/harness'
import { getTargetAdapter, type TargetAdapter } from '@mpf/adapters'
import { READ_ONLY_BASH, runWorker, workerFailure, type AgentFn } from '@mpf/analyzer'
import { runAgent } from '@mpf/llm'
import { criticPrompt, decideVerdict, fixBrief, rubricsFor } from '@mpf/critic'
import { GENERATE_SYSTEM } from './prompts.ts'
import { GenerateResult } from './target.ts'

export interface CriticDeps {
  agent?: AgentFn
  adapterFor?: (target: Target) => TargetAdapter | undefined
  maxRounds?: number
}

interface Gathered {
  target: Target
  spec: AppSpec
  behaviors: BehaviorSpec
  plan: PortPlan
  workspace: string
  sourceDir: string
  tests: TestResult[]
  buildDiagnostics: Diagnostic[]
  workerSummary?: {
    deviations: { what: string; why: string }[]
    notes: string
    behaviorsCovered: string[]
  }
  priorVerdicts: Verdict[]
  accepted: Set<string>
  screenshots: { label: string; path: string }[]
}

function gather(ctx: StageContext): Gathered | StageOutcome {
  const target = ctx.stage.target
  if (!target)
    return {
      status: 'failed',
      retryable: false,
      error: { class: 'internal', message: 'stage has no target', diagnostics: [] },
    }
  const spec = ctx.readJsonArtifact<AppSpec>('appspec')
  const behaviors = ctx.readJsonArtifact<BehaviorSpec>('behaviorspec')
  const plan = ctx.readJsonArtifact<PortPlan>('portplan')
  if (!spec || !behaviors || !plan || !plan.targets.some((t) => t.target === target)) {
    return {
      status: 'failed',
      retryable: false,
      error: {
        class: 'internal',
        message: 'appspec, behaviorspec, or portplan missing for this target',
        diagnostics: [],
      },
    }
  }
  const workspace = join(ctx.run.runDir, 'workspace', target)
  if (!existsSync(workspace))
    return { status: 'skipped', reason: `no generated project for ${target}` }
  const events = ctx.store.listEvents(ctx.run.id)
  const latestTests = new Map<string, TestResult>()
  for (const e of events)
    if (e.type === 'test.result' && e.result.target === target)
      latestTests.set(e.result.kind, e.result)
  const buildStage = ctx.store.getStage(ctx.run.id, `build:${target}`)
  const buildDiagnostics = buildStage?.error?.diagnostics ?? []
  const summaryPath = join(ctx.run.runDir, `generate-${target}.json`)
  const workerSummary = existsSync(summaryPath)
    ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as Gathered['workerSummary'])
    : undefined
  const priorVerdicts = ctx.store
    .listArtifacts(ctx.run.id)
    .filter((a) => a.kind === 'verdict' && a.meta.target === target)
    .map((a) => JSON.parse(readFileSync(join(ctx.run.runDir, a.relPath), 'utf8')) as Verdict)
    .sort((a, b) => a.round - b.round)
  const accepted = new Set<string>()
  for (const d of plan.targets.find((t) => t.target === target)?.deviations ?? [])
    if (d.accepted) accepted.add(d.what)
  for (const e of events)
    if (
      e.type === 'control' &&
      e.action === 'approve' &&
      typeof e.payload.acceptFinding === 'string'
    )
      accepted.add(e.payload.acceptFinding)
  const screenshots = ctx.store
    .listArtifacts(ctx.run.id)
    .filter(
      (a) =>
        (a.kind === 'source-screenshot' && a.meta.screenId) ||
        (a.kind === 'target-screenshot' && a.meta.target === target),
    )
    .map((a) => ({
      label: `${a.kind === 'source-screenshot' ? 'source' : target} ${String(a.meta.screenId)}`,
      path: join(ctx.run.runDir, a.relPath),
    }))
  return {
    target,
    spec,
    behaviors,
    plan,
    workspace,
    sourceDir: join(ctx.run.runDir, 'source'),
    tests: [...latestTests.values()],
    buildDiagnostics,
    workerSummary,
    priorVerdicts,
    accepted,
    screenshots,
  }
}

function isOutcome(x: Gathered | StageOutcome): x is StageOutcome {
  return 'status' in x
}

/**
 * Independent review. The critic never sees the worker's transcript: it gets the
 * artifacts, the test results, and read-only access to the generated code.
 */
export function critiqueStage(config: MpfConfig, deps: CriticDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  const maxRounds = deps.maxRounds ?? 2
  return {
    async run(ctx): Promise<StageOutcome> {
      const g = gather(ctx)
      if (isOutcome(g)) return g
      const round = g.priorVerdicts.length + 1
      // Any answer but "reject" to the escalation accepts what is left as deviations ("accept",
      // "approve", a dashboard button, a CLI word); reject cancels the run before the stage reruns.
      if (ctx.humanChoice && ctx.humanChoice !== 'reject') {
        const last = g.priorVerdicts.at(-1)
        const acceptedDeviations = (last?.findings ?? [])
          .filter((f) => f.severity === 'blocking')
          .map((f) => ({ id: f.id, description: f.description }))
        ctx.log(
          'info',
          `operator accepted the remaining ${acceptedDeviations.length} finding(s)${last ? ` from round ${last.round}` : ''} as deviations`,
        )
        return {
          status: 'succeeded',
          result: { decision: 'accepted', round: last?.round ?? round, acceptedDeviations },
        }
      }
      const adapter = (deps.adapterFor ?? getTargetAdapter)(g.target)
      const result = await runWorker(
        ctx,
        {
          role: 'critic',
          budgetShare: 0.1 / Math.max(1, ctx.run.targets.length),
          cwd: g.workspace,
          // The whole run directory: artifacts, source screenshots, test reports. Writes stay confined to the workspace.
          readDirs: [g.sourceDir, ctx.run.runDir],
          bashAllow: READ_ONLY_BASH,
          systemPrompt: rubricsFor(g.target),
          prompt: criticPrompt({
            target: g.target,
            round,
            maxRounds,
            spec: g.spec,
            behaviors: g.behaviors,
            plan: g.plan.targets.find((t) => t.target === g.target)!,
            tests: g.tests,
            buildDiagnostics: g.buildDiagnostics,
            workerSummary: g.workerSummary,
            acceptedDeviations: [...g.accepted],
            priorVerdicts: g.priorVerdicts,
            screenshots: g.screenshots,
            workspace: g.workspace,
            sourceDir: g.sourceDir,
            instructions: ctx.takeInstructions(),
          }),
          outputSchema: CriticOutput,
          maxTurns: 40,
          env: adapter ? (await adapter.available(config, process.env)).env : undefined,
        },
        agent,
      )
      if (!result.ok || !result.structured)
        return workerFailure(result, 'critic produced no verdict')
      const output = CriticOutput.parse(result.structured)
      const { verdict, reason } = decideVerdict({
        output,
        stageId: ctx.stage.id,
        target: g.target,
        round,
        maxRounds,
        accepted: g.accepted,
        prior: g.priorVerdicts.at(-1),
      })
      const rel = `verdict-${g.target}-${round}.json`
      writeFileSync(join(ctx.run.runDir, rel), JSON.stringify(verdict, null, 2))
      ctx.addArtifact({ kind: 'verdict', relPath: rel, meta: { target: g.target, round } })
      ctx.emit({ type: 'critic.verdict', verdict })
      const blocking = verdict.findings.filter((f) => f.severity === 'blocking').length
      ctx.log(
        verdict.decision === 'pass' ? 'info' : 'warn',
        `critic round ${round}: ${verdict.decision} (${reason}); scores fidelity ${verdict.scores.fidelity}, idiomatic ${verdict.scores.idiomatic}, tests ${verdict.scores.testAdequacy}`,
      )
      if (verdict.decision === 'escalate') {
        return {
          status: 'waiting_human',
          costUsd: result.costUsd,
          reason: `The critic could not settle ${g.target}: ${reason}. ${blocking} blocking finding(s) remain. Accept them as deviations, or reject to cancel.`,
          choices: [
            { id: 'accept', label: 'Accept remaining findings as deviations' },
            { id: 'reject', label: 'Reject and cancel' },
          ],
        }
      }
      return {
        status: 'succeeded',
        costUsd: result.costUsd,
        result: { decision: verdict.decision, round, blocking, findings: verdict.findings.length },
      }
    },
  }
}

/**
 * Applies the critic's findings through the generation worker's session. On success
 * it asks the orchestrator to rerun build, test, and critique for the target.
 */
export function fixStage(config: MpfConfig, deps: CriticDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  return {
    async run(ctx): Promise<StageOutcome> {
      const target = ctx.stage.target
      if (!target)
        return {
          status: 'failed',
          retryable: false,
          error: { class: 'internal', message: 'stage has no target', diagnostics: [] },
        }
      const critique = ctx.store.getStage(ctx.run.id, `critique:${target}`)
      const decision = (critique?.result as { decision?: string } | undefined)?.decision
      if (decision !== 'fix')
        return {
          status: 'skipped',
          reason: decision === 'accepted' ? 'findings accepted as deviations' : 'nothing to fix',
        }
      const verdicts = ctx.store
        .listArtifacts(ctx.run.id)
        .filter((a) => a.kind === 'verdict' && a.meta.target === target)
      const latest = verdicts.at(-1)
      if (!latest) return { status: 'skipped', reason: 'no verdict to act on' }
      const verdict = JSON.parse(
        readFileSync(join(ctx.run.runDir, latest.relPath), 'utf8'),
      ) as Verdict
      const adapter = (deps.adapterFor ?? getTargetAdapter)(target)
      if (!adapter) return { status: 'skipped', reason: `no target adapter for ${target}` }
      const avail = await adapter.available(config, process.env)
      const generate = ctx.store.getStage(ctx.run.id, `generate:${target}`)
      const sessionId = (generate?.result as { sessionId?: string } | undefined)?.sessionId
      const workspace = join(ctx.run.runDir, 'workspace', target)
      const tctx = {
        run: ctx.run,
        workspace,
        spec: ctx.readJsonArtifact<AppSpec>('appspec')!,
        behaviors: ctx.readJsonArtifact<BehaviorSpec>('behaviorspec')!,
        plan: ctx.readJsonArtifact<PortPlan>('portplan')!.targets.find((t) => t.target === target)!,
        config,
        env: avail.env,
        signal: ctx.signal,
        log: (m: string) => ctx.log('info', m),
      }
      const result = await runWorker(
        ctx,
        {
          role: 'generate',
          effort: 'high',
          budgetShare: 0.15 / Math.max(1, ctx.run.targets.length),
          cwd: workspace,
          readDirs: [join(ctx.run.runDir, 'source')],
          bashAllow: [...adapter.bashAllow, ...READ_ONLY_BASH],
          systemPrompt: `${GENERATE_SYSTEM}\n\n# Project conventions\n${adapter.workerPrompt(tctx)}`,
          prompt: [
            fixBrief(verdict),
            ...ctx.takeInstructions().map((i) => `Operator instruction: ${i}`),
          ].join('\n\n'),
          outputSchema: GenerateResult,
          maxTurns: 120,
          resume: sessionId,
          env: avail.env,
        },
        agent,
      )
      if (!result.ok) return workerFailure(result, 'fix worker failed')
      const summary = GenerateResult.parse(
        result.structured ?? { filesWritten: [], behaviorsCovered: [] },
      )
      ctx.log(
        'info',
        `fix applied: ${summary.filesWritten.length} files touched; rerunning build, tests, and review`,
      )
      return {
        status: 'succeeded',
        costUsd: result.costUsd,
        result: { rerun: true, round: verdict.round, filesWritten: summary.filesWritten.length },
      }
    },
  }
}
