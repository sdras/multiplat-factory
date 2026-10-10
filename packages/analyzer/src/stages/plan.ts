import { writeFileSync } from 'node:fs'
import { join } from 'pathe'
import {
  PortPlan,
  type AppSpec,
  type BehaviorSpec,
  type MpfConfig,
  type ToolchainReport,
} from '@mpf/core'
import { runDoctor, type StageContext, type StageOutcome, type StageRunner } from '@mpf/harness'
import { runAgent } from '@mpf/llm'
import { coreCandidacy } from '../candidacy.ts'
import { PLAN_SYSTEM, planPrompt, repairPrompt } from '../prompts.ts'
import { validatePlan } from '../validate.ts'
import { runWorker, workerFailure } from '../worker.ts'
import type { AnalysisDeps } from './spec.ts'

export interface PlanDeps extends AnalysisDeps {
  doctor?: (config: MpfConfig) => Promise<ToolchainReport>
}

/**
 * Produces the PortPlan, checks it deterministically, and pauses for approval
 * when the run asks for a plan checkpoint. On approval the stage runs again and
 * returns immediately without redoing the work.
 */
export function planStage(config: MpfConfig, deps: PlanDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  const doctor = deps.doctor ?? runDoctor
  return {
    async run(ctx: StageContext): Promise<StageOutcome> {
      const existing = ctx.readJsonArtifact<PortPlan>('portplan')
      if (existing && ctx.humanChoice === 'approve') {
        ctx.log('info', 'plan approved')
        return {
          status: 'succeeded',
          result: {
            approved: true,
            targets: existing.targets.map((t) => t.target),
            core: existing.core.enabled,
          },
        }
      }
      const spec = ctx.readJsonArtifact<AppSpec>('appspec')
      const behaviors = ctx.readJsonArtifact<BehaviorSpec>('behaviorspec')
      if (!spec || !behaviors) {
        return {
          status: 'failed',
          retryable: false,
          error: {
            class: 'internal',
            message: 'appspec or behaviorspec artifact missing',
            diagnostics: [],
          },
        }
      }
      const candidacy = coreCandidacy(spec, ctx.run.options.coreMode)
      let report: ToolchainReport | undefined
      try {
        report = await doctor(config)
      } catch {
        report = undefined
      }
      const sourceDir = join(ctx.run.runDir, 'source')
      let cost = 0
      const first = await runWorker(
        ctx,
        {
          role: 'generate',
          budgetShare: 0.15,
          cwd: sourceDir,
          systemPrompt: PLAN_SYSTEM,
          prompt: planPrompt(ctx.run, spec, behaviors, candidacy, report, ctx.takeInstructions()),
          outputSchema: PortPlan,
          maxTurns: 30,
        },
        agent,
      )
      cost += first.costUsd
      if (!first.ok || !first.structured) return workerFailure(first, 'worker produced no PortPlan')
      let plan = PortPlan.parse(first.structured)
      let errors = validatePlan(plan, spec, behaviors, ctx.run)
      if (errors.length && first.sessionId) {
        ctx.log('warn', `${errors.length} plan problems; asking the worker to repair once`)
        const repair = await runWorker(
          ctx,
          {
            role: 'generate',
            budgetShare: 0.03,
            cwd: sourceDir,
            systemPrompt: PLAN_SYSTEM,
            prompt: repairPrompt(errors),
            outputSchema: PortPlan,
            maxTurns: 15,
            resume: first.sessionId,
          },
          agent,
        )
        cost += repair.costUsd
        if (repair.ok && repair.structured) {
          plan = PortPlan.parse(repair.structured)
          errors = validatePlan(plan, spec, behaviors, ctx.run)
        }
      }
      for (const e of errors) ctx.log('warn', `plan check: ${e}`)
      if (plan.core.enabled !== candidacy.enabled && ctx.run.options.coreMode === 'auto') {
        ctx.log(
          'info',
          `plan ${plan.core.enabled ? 'enables' : 'disables'} the shared core against the heuristic (${candidacy.rationale}); rationale: ${plan.core.rationale}`,
        )
      }
      writeFileSync(join(ctx.run.runDir, 'portplan.json'), JSON.stringify(plan, null, 2))
      ctx.addArtifact({
        kind: 'portplan',
        relPath: 'portplan.json',
        meta: { checks: errors.length },
      })
      ctx.log(
        'info',
        `PortPlan: ${plan.targets.map((t) => `${t.target} (${t.uiFramework})`).join(', ')}; core ${plan.core.enabled ? 'on' : 'off'}; ${plan.questionsForHuman.length} questions`,
      )
      if (ctx.run.options.checkpoints.planApproval) {
        const q = plan.questionsForHuman.length
          ? ` The plan asks ${plan.questionsForHuman.length} question(s).`
          : ''
        return {
          status: 'waiting_human',
          costUsd: cost,
          reason: `Review the port plan before generation starts.${q}${errors.length ? ` ${errors.length} check(s) did not pass; see the run log.` : ''}`,
          choices: [
            { id: 'approve', label: 'Approve plan' },
            { id: 'reject', label: 'Reject and cancel' },
          ],
        }
      }
      return {
        status: 'succeeded',
        costUsd: cost,
        result: {
          targets: plan.targets.map((t) => t.target),
          core: plan.core.enabled,
          checks: errors.length,
        },
      }
    },
  }
}
