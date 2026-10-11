import { writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { AppSpec, type Inventory, type MpfConfig } from '@mpf/core'
import type { StageContext, StageOutcome, StageRunner } from '@mpf/harness'
import { runAgent } from '@mpf/llm'
import {
  SPEC_SYSTEM,
  duplicateTestIdRepairPrompt,
  duplicateTestIds,
  specPrompt,
  testIdRepairPrompt,
  unmatchedTestIds,
} from '../prompts.ts'
import { runWorker, workerFailure, type AgentFn } from '../worker.ts'
import type { DetectionArtifact } from './ingest.ts'

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
      const result = await runWorker(
        ctx,
        {
          role: 'generate',
          budgetShare: 0.15,
          cwd: sourceDir,
          systemPrompt: SPEC_SYSTEM,
          prompt: specPrompt(detection.best, inventory, ctx.takeInstructions()),
          outputSchema: AppSpec,
          maxTurns: 80,
        },
        agent,
      )
      if (!result.ok || !result.structured)
        return workerFailure(result, 'worker produced no AppSpec')
      let spec = AppSpec.parse(result.structured)
      let cost = result.costUsd
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
