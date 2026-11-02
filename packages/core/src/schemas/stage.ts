import { z } from 'zod'
import { Diagnostic, Id, IsoDate, Target } from './common.ts'

/** Stage kinds. Target-scoped kinds carry `target`; the id is `${kind}:${target}`. */
export const StageKind = z.enum([
  'ingest',
  'inventory',
  'spec',
  'behaviors',
  'observe',
  'plan',
  'core.extract',
  'core.vectors',
  'core.build',
  'generate',
  'build',
  'test',
  'critique',
  'fix',
  'report',
])
export type StageKind = z.infer<typeof StageKind>

export const TARGET_SCOPED_KINDS: ReadonlySet<StageKind> = new Set([
  'generate',
  'build',
  'test',
  'critique',
  'fix',
])

export const StageStatus = z.enum([
  'pending',
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'waiting_human',
  'paused',
  'skipped',
  'cancelled',
])
export type StageStatus = z.infer<typeof StageStatus>

export const TERMINAL_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set([
  'succeeded',
  'blocked',
  'skipped',
  'cancelled',
])

export const StageError = z.object({
  class: z.enum([
    'toolchain-missing',
    'unsupported-source',
    'build-error',
    'test-failure',
    'budget-exhausted',
    'llm-error',
    'model-unsuitable',
    'rate-limit',
    'human-needed',
    'timeout',
    'internal',
  ]),
  message: z.string(),
  diagnostics: z.array(Diagnostic).default([]),
})
export type StageError = z.infer<typeof StageError>

export const Stage = z.object({
  id: Id,
  runId: Id,
  kind: StageKind,
  target: Target.optional(),
  status: StageStatus,
  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  dependsOn: z.array(Id).default([]),
  /** Display order within the run. */
  ord: z.number().int().nonnegative().default(0),
  startedAt: IsoDate.optional(),
  endedAt: IsoDate.optional(),
  inputs: z.array(Id).default([]),
  outputs: z.array(Id).default([]),
  costUsd: z.number().nonnegative().default(0),
  sessionId: z.string().optional(),
  error: StageError.optional(),
  skipReason: z.string().optional(),
  /** Free-form structured result the stage runner produced (validated per kind elsewhere). */
  result: z.record(z.string(), z.unknown()).optional(),
})
export type Stage = z.infer<typeof Stage>

export function stageId(kind: StageKind, target?: Target): string {
  return target ? `${kind}:${target}` : kind
}
