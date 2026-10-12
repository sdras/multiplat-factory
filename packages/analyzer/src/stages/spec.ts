import { writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { AppSpec, type Inventory, type MpfConfig } from '@mpf/core'
import type { StageContext, StageOutcome, StageRunner } from '@mpf/harness'
import { runAgent } from '@mpf/llm'
import {
  SPEC_SYSTEM,
  duplicateTestIdRepairPrompt,
  duplicateTestIds,
  proseSelectorRepairPrompt,
  proseSelectors,
  specPrompt,
  testIdRepairPrompt,
  unmatchedTestIds,
} from '../prompts.ts'
import { runWorker, workerFailure, type AgentFn } from '../worker.ts'
import type { DetectionArtifact } from './ingest.ts'

/** Share of the run budget for the spec worker: 15% for a small app, up to 35% for one with hundreds of files. */
export function specBudgetShare(fileCount: number): number {
  return Math.min(0.35, 0.15 + Math.max(0, fileCount - 150) / 1000)
}

export interface AnalysisDeps {
  agent?: AgentFn
}

/** LLM worker with read-only access to the source produces the framework-neutral AppSpec. */
export function specStage(_config: MpfConfig, deps: AnalysisDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  return {
    async run(ctx: StageContext): Promise<StageOutcome> {
      const detection = ctx.readJsonArtifact<DetectionArtifact>('detection')
      const inventory = ctx.readJsonArtifact<Inventory>('inventory')
      if (!detection || !inventory) {
        return {
          status: 'failed',
          retryable: false,
          error: {
            class: 'internal',
            message: 'detection or inventory artifact missing',
            diagnostics: [],
          },
        }
      }
      const sourceDir = join(ctx.run.runDir, 'source')
      // A large source (Apple's Food Truck sample: 550 files) needs more reading than a counter app;
      // the allowance grows with the inventory, and one continuation keeps a partial spec from
      // being thrown away when the first session runs out mid-way.
      const worker = {
        role: 'generate' as const,
        budgetShare: specBudgetShare(inventory.files.length),
        cwd: sourceDir,
        systemPrompt: SPEC_SYSTEM,
        prompt: specPrompt(detection.best, inventory, ctx.takeInstructions()),
        outputSchema: AppSpec,
        maxTurns: 120,
      }
      let result = await runWorker(ctx, worker, agent)
      // The run was charged for each session as it returned; the stage's own total is both.
      let priorCost = 0
      if (!result.ok && /budget/i.test(result.error ?? '') && result.sessionId) {
        priorCost = result.costUsd
        ctx.log('warn', 'the spec worker ran out of its allowance; continuing the session once')
        result = await runWorker(
          ctx,
          {
            ...worker,
            budgetShare: 0.15,
            resume: result.sessionId,
            prompt:
              'Continue where you left off and return the complete AppSpec now: keep every screen, element, and logic unit you already identified, finish the remaining screens from what you have read, and stop reading files unless a screen is still entirely unknown.',
          },
          agent,
        )
      }
      if (!result.ok || !result.structured) {
        const failure = workerFailure(result, 'worker produced no AppSpec')
        return { ...failure, costUsd: priorCost + failure.costUsd }
      }
      let spec = AppSpec.parse(result.structured)
      let cost = priorCost + result.costUsd
      // Ids that do not exist in the source verify nothing; give the worker one round to map them,
      // by hook or, where the source has none, by a sourceSelector.
      const hooks = inventory.hints.testHooks
      if (!hooks.length)
        ctx.log(
          'warn',
          'the inventory found no test hooks in the source; elements can only be found on it through their sourceSelector (web: a CSS selector, mobile: the visible label)',
        )
      let unmatched = unmatchedTestIds(spec, hooks)
      if (unmatched.length && result.sessionId) {
        ctx.log(
          'warn',
          `${unmatched.length} elements match no test hook in the source and carry no sourceSelector; asking the worker to map them`,
        )
        const repair = await runWorker(
          ctx,
          {
            role: 'generate',
            budgetShare: 0.05,
            cwd: sourceDir,
            systemPrompt: SPEC_SYSTEM,
            prompt: testIdRepairPrompt(unmatched, hooks),
            outputSchema: AppSpec,
            maxTurns: 30,
            resume: result.sessionId,
          },
          agent,
        )
        cost += repair.costUsd
        if (repair.ok && repair.structured) {
          const repaired = AppSpec.parse(repair.structured)
          const still = unmatchedTestIds(repaired, hooks)
          if (still.length <= unmatched.length) {
            spec = repaired
            unmatched = still
          }
        }
        ctx.log(
          unmatched.length ? 'warn' : 'info',
          `${unmatched.length} elements still have neither a source hook nor a sourceSelector after repair`,
        )
      }
      // Two elements with one test id cannot be told apart by a flow: one repair round makes them distinct.
      let duplicates = duplicateTestIds(spec)
      if (duplicates.length && result.sessionId) {
        ctx.log(
          'warn',
          `${duplicates.length} test id(s) are shared by several elements on one screen; asking the worker to make them distinct`,
        )
        const repair = await runWorker(
          ctx,
          {
            role: 'generate',
            budgetShare: 0.05,
            cwd: sourceDir,
            systemPrompt: SPEC_SYSTEM,
            prompt: duplicateTestIdRepairPrompt(duplicates),
            outputSchema: AppSpec,
            maxTurns: 30,
            resume: result.sessionId,
          },
          agent,
        )
        cost += repair.costUsd
        if (repair.ok && repair.structured) {
          const repaired = AppSpec.parse(repair.structured)
          const still = duplicateTestIds(repaired)
          if (
            still.length <= duplicates.length &&
            unmatchedTestIds(repaired, hooks).length <= unmatched.length
          ) {
            spec = repaired
            duplicates = still
          }
        }
        ctx.log(
          duplicates.length ? 'warn' : 'info',
          `${duplicates.length} shared test id(s) remain after repair`,
        )
      }
      // On a phone a selector is a caption or a content description; an explanation is not one.
      let prose = proseSelectors(spec, ctx.run.source.platform)
      if (prose.length && result.sessionId) {
        ctx.log(
          'warn',
          `${prose.length} mobile sourceSelector value(s) describe the element instead of naming its text; asking the worker to fix them`,
        )
        const repair = await runWorker(
          ctx,
          {
            role: 'generate',
            budgetShare: 0.05,
            cwd: sourceDir,
            systemPrompt: SPEC_SYSTEM,
            prompt: proseSelectorRepairPrompt(prose),
            outputSchema: AppSpec,
            maxTurns: 30,
            resume: result.sessionId,
          },
          agent,
        )
        cost += repair.costUsd
        if (repair.ok && repair.structured) {
          const repaired = AppSpec.parse(repair.structured)
          const still = proseSelectors(repaired, ctx.run.source.platform)
          if (
            still.length <= prose.length &&
            unmatchedTestIds(repaired, hooks).length <= unmatched.length
          ) {
            spec = repaired
            prose = still
          }
        }
        ctx.log(
          prose.length ? 'warn' : 'info',
          `${prose.length} prose selector(s) remain after repair`,
        )
      }
      writeFileSync(join(ctx.run.runDir, 'appspec.json'), JSON.stringify(spec, null, 2))
      ctx.addArtifact({ kind: 'appspec', relPath: 'appspec.json' })
      const elements = spec.screens.reduce((n, s) => n + s.elements.length, 0)
      ctx.log(
        'info',
        `AppSpec: ${spec.screens.length} screens, ${elements} elements, ${spec.logic.length} logic units, ${spec.integrations.length} integrations`,
      )
      return {
        status: 'succeeded',
        costUsd: cost,
        result: {
          screens: spec.screens.length,
          elements,
          logic: spec.logic.length,
          unmatchedTestIds: unmatched.length,
          sessionId: result.sessionId,
        },
      }
    },
  }
}
