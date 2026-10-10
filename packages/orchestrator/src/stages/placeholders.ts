import type { PortPlan } from '@mpf/core'
import type { StageOutcome, StageRunner } from '@mpf/harness'

/**
 * Stages whose real implementation lands in later milestones. They never pretend
 * to succeed: a shared core that the plan enabled blocks with a clear message,
 * a disabled core skips, and the critic placeholders skip with a reason.
 */

export function coreExtractPlaceholder(): StageRunner {
  return {
    async run(ctx): Promise<StageOutcome> {
      const plan = ctx.readJsonArtifact<PortPlan>('portplan')
      if (!plan?.core.enabled)
        return {
          status: 'skipped',
          reason: `no shared core for this run (${plan?.core.rationale ?? 'plan missing'})`,
        }
      return {
        status: 'failed',
        retryable: false,
        error: {
          class: 'internal',
          message:
            'the shared WASM core is not implemented in this build (milestone 6); rerun with coreMode "never"',
          diagnostics: [],
        },
      }
    },
  }
}

export function coreFollowerPlaceholder(): StageRunner {
  return {
    async run(ctx): Promise<StageOutcome> {
      const extract = ctx.store.getStage(ctx.run.id, 'core.extract')
      if (extract?.status === 'skipped')
        return { status: 'skipped', reason: 'no shared core for this run' }
      return {
        status: 'failed',
        retryable: false,
        error: {
          class: 'internal',
          message: 'shared core stages are not implemented in this build',
          diagnostics: [],
        },
      }
    },
  }
}

export function critiquePlaceholder(): StageRunner {
  return {
    async run(): Promise<StageOutcome> {
      return {
        status: 'skipped',
        reason: 'the critic lands in milestone 5; tests are the only verification in this build',
      }
    },
  }
}

export function fixPlaceholder(): StageRunner {
  return {
    async run(): Promise<StageOutcome> {
      return { status: 'skipped', reason: 'no critic findings to fix in this build' }
    },
  }
}
