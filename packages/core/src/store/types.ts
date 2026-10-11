import type { Artifact, Event, EventInput, Run, Stage } from '../schemas/index.ts'

/**
 * Persistence seam. The local implementation is SQLite; a hosted mode can
 * implement this over a service without touching the orchestrator.
 */
export interface RunStore {
  createRun(run: Run): void
  getRun(id: string): Run | undefined
  listRuns(limit?: number): Run[]
  updateRun(run: Run): void

  upsertStage(stage: Stage): void
  getStage(runId: string, stageId: string): Stage | undefined
  listStages(runId: string): Stage[]

  /** Assigns a per-run monotonic `seq` and persists. */
  appendEvent(event: EventInput): Event
  listEvents(runId: string, afterSeq?: number, limit?: number): Event[]
  /** Every event after `afterSeq`, however many: readers that derive state (reports, verdict ledgers, the dashboard replay) must not stop at a page. */
  listAllEvents(runId: string, afterSeq?: number): Event[]

  addArtifact(artifact: Artifact): void
  listArtifacts(runId: string): Artifact[]

  close(): void
}
