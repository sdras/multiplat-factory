import { writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { BehaviorSpec, type AppSpec, type Inventory, type MpfConfig } from '@mpf/core'
import type { StageContext, StageOutcome, StageRunner } from '@mpf/harness'
import { runAgent } from '@mpf/llm'
import { BEHAVIORS_SYSTEM, behaviorsPrompt, repairPrompt } from '../prompts.ts'
import { pruneInvalidBehaviors, validateBehaviorRefs } from '../validate.ts'
import { runWorker, workerFailure } from '../worker.ts'
import type { AnalysisDeps } from './spec.ts'

/** LLM worker writes the behavior contract; deterministic checks keep it tied to AppSpec ids. */
/** Share of the run budget for the behaviors worker: 15% for a few screens, up to 35% for dozens of them. */
export function behaviorsBudgetShare(spec: { screens: { elements: unknown[] }[] }): number {
  const elements = spec.screens.reduce((n, s) => n + s.elements.length, 0)
  return Math.min(0.35, 0.15 + Math.max(0, elements - 60) / 400)
}

export function behaviorsStage(_config: MpfConfig, deps: AnalysisDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  return {
    async run(ctx: StageContext): Promise<StageOutcome> {
      const spec = ctx.readJsonArtifact<AppSpec>('appspec')
      const inventory = ctx.readJsonArtifact<Inventory>('inventory')
      if (!spec || !inventory) {
        return {
          status: 'failed',
          retryable: false,
          error: {
            class: 'internal',
            message: 'appspec or inventory artifact missing',
            diagnostics: [],
          },
        }
      }
      const sourceDir = join(ctx.run.runDir, 'source')
      let cost = 0
      // A large spec (Apple's Food Truck: dozens of screens) makes every turn dear; the allowance
      // grows with the spec and one continuation keeps a half-written BehaviorSpec from being lost.
      const worker = {
        role: 'generate' as const,
        budgetShare: behaviorsBudgetShare(spec),
        cwd: sourceDir,
        systemPrompt: BEHAVIORS_SYSTEM,
        prompt: behaviorsPrompt(spec, inventory, ctx.takeInstructions()),
        outputSchema: BehaviorSpec,
        maxTurns: 90,
      }
      let first = await runWorker(ctx, worker, agent)
      if (!first.ok && /budget/i.test(first.error ?? '') && first.sessionId) {
        ctx.log(
          'warn',
          'the behaviors worker ran out of its allowance; continuing the session once',
        )
        cost += first.costUsd
        first = await runWorker(
          ctx,
          {
            ...worker,
            budgetShare: 0.15,
            resume: first.sessionId,
            prompt:
              'Continue where you left off and return the complete BehaviorSpec now: keep every behavior you already wrote, cover the remaining must-have screens briefly, and stop reading files.',
          },
          agent,
        )
      }
      cost += first.costUsd
      if (!first.ok || !first.structured)
        return { ...workerFailure(first, 'worker produced no BehaviorSpec'), costUsd: cost }
      let behaviors = BehaviorSpec.parse(first.structured)
      let errors = validateBehaviorRefs(spec, behaviors)
      if (errors.length && first.sessionId) {
        ctx.log('warn', `${errors.length} reference problems; asking the worker to repair once`)
        const repair = await runWorker(
          ctx,
          {
            role: 'generate',
            budgetShare: 0.05,
            cwd: sourceDir,
            systemPrompt: BEHAVIORS_SYSTEM,
            prompt: repairPrompt(errors),
            outputSchema: BehaviorSpec,
            maxTurns: 20,
            resume: first.sessionId,
          },
          agent,
        )
        cost += repair.costUsd
        if (repair.ok && repair.structured) {
          behaviors = BehaviorSpec.parse(repair.structured)
          errors = validateBehaviorRefs(spec, behaviors)
        }
      }
      if (errors.length) {
        const { kept, dropped } = pruneInvalidBehaviors(spec, behaviors)
        if (dropped.length)
          ctx.log('warn', `dropped behaviors with unknown references: ${dropped.join(', ')}`)
        for (const e of errors.filter((x) => x.includes('has no behaviors'))) ctx.log('warn', e)
        behaviors = kept
      }
      if (!behaviors.behaviors.length) {
        return {
          status: 'failed',
          costUsd: cost,
          error: {
            class: 'llm-error',
            message: 'no valid behaviors remained after validation',
            diagnostics: [],
          },
        }
      }
      writeFileSync(join(ctx.run.runDir, 'behaviorspec.json'), JSON.stringify(behaviors, null, 2))
      ctx.addArtifact({
        kind: 'behaviorspec',
        relPath: 'behaviorspec.json',
        meta: { verified: false },
      })
      const must = behaviors.behaviors.filter((b) => b.priority === 'must').length
      ctx.log(
        'info',
        `BehaviorSpec: ${behaviors.behaviors.length} behaviors (${must} must), ${behaviors.invariants.length} invariants`,
      )
      return {
        status: 'succeeded',
        costUsd: cost,
        result: { behaviors: behaviors.behaviors.length, must },
      }
    },
  }
}
