import type {
  Artifact,
  ArtifactKind,
  EventPayload,
  MpfConfig,
  Run,
  RunEventBus,
  RunStore,
  Stage,
  StageKind,
} from '@mpf/core'
import type { Lanes } from './lanes.ts'

/** Everything a stage runner may touch. Runners never reach around this to the scheduler. */
export interface StageContext {
  run: Run
  stage: Stage
  store: RunStore
  bus: RunEventBus
  config: MpfConfig
  lanes: Lanes
  /** Aborted on pause or cancel. Runners must stop promptly. */
  signal: AbortSignal
  emit(payload: EventPayload): void
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  /** Instructions queued by a human for this stage while it runs. */
  takeInstructions(): string[]
  /** The choice a human made when this stage last waited (e.g. 'approve'), if any. */
  humanChoice?: string
  /** Registers a file under the run directory as an artifact and announces it. */
  addArtifact(input: {
    kind: ArtifactKind
    relPath: string
    mime?: string
    meta?: Record<string, unknown>
  }): Artifact
  /** Latest artifact of a kind in this run, parsed as JSON. */
  readJsonArtifact<T>(kind: ArtifactKind, meta?: Record<string, unknown>): T | undefined
  /** Patch the run record (e.g. detected source platform) and announce it. */
  updateRun(patch: Partial<Pick<Run, 'source' | 'summary'>>): Run
  /**
   * Record money spent right away (a worker result), so a crash or pause after it never loses
   * the charge. The stage outcome's costUsd may still include the same amount; the runner adds
   * only what exceeds what was charged.
   */
  chargeCost(usd: number): void
}

export type StageOutcome =
  | { status: 'succeeded'; result?: Record<string, unknown>; costUsd?: number }
  | {
      status: 'failed'
      error: NonNullable<Stage['error']>
      costUsd?: number
      /** false blocks the stage immediately instead of retrying (deterministic failures). */
      retryable?: boolean
    }
  | { status: 'skipped'; reason: string }
  | {
      status: 'waiting_human'
      reason: string
      choices: { id: string; label: string }[]
      costUsd?: number
    }

export interface StageRunner {
  run(ctx: StageContext): Promise<StageOutcome>
}

export type StageRunnerRegistry = Partial<Record<StageKind, StageRunner>>
