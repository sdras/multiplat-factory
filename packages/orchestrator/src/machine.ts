import {
  TERMINAL_STAGE_STATUSES,
  type Run,
  type RunStatus,
  type Stage,
  type StageKind,
  type StageStatus,
} from '@mpf/core'

/** Skip reason prefix for stages that never ran because a dependency was blocked. */
export const UNREACHABLE = 'unreachable:'

/** A stage skipped on purpose (not warranted, toolchain missing) is satisfied; an unreachable one is not. */
export function isUnreachable(stage: Stage | undefined): boolean {
  return stage?.status === 'skipped' && Boolean(stage.skipReason?.startsWith(UNREACHABLE))
}

/** Stages that summarize a run wait for their dependencies to end, however they ended. */
const SOFT_DEPS: ReadonlySet<StageKind> = new Set<StageKind>(['report'])

/** Dependencies count as satisfied when they succeeded or were skipped on purpose (report: when they ended at all). */
export function depsSatisfied(stage: Stage, byId: Map<string, Stage>): boolean {
  if (SOFT_DEPS.has(stage.kind))
    return stage.dependsOn.every((id) => isTerminal(byId.get(id)?.status ?? 'pending'))
  return stage.dependsOn.every((id) => {
    const d = byId.get(id)
    return d?.status === 'succeeded' || (d?.status === 'skipped' && !isUnreachable(d))
  })
}

/** A dependency that ended blocked, cancelled, or itself unreachable makes this stage unreachable (never a report). */
export function depsBlocked(stage: Stage, byId: Map<string, Stage>): boolean {
  if (SOFT_DEPS.has(stage.kind)) return false
  return stage.dependsOn.some((id) => {
    const d = byId.get(id)
    return d?.status === 'blocked' || d?.status === 'cancelled' || isUnreachable(d)
  })
}

export function indexStages(stages: Stage[]): Map<string, Stage> {
  return new Map(stages.map((s) => [s.id, s]))
}

/** Stages that can start now: pending or queued with all deps satisfied. */
export function readyStages(stages: Stage[]): Stage[] {
  const byId = indexStages(stages)
  return stages.filter(
    (s) => (s.status === 'pending' || s.status === 'queued') && depsSatisfied(s, byId),
  )
}

/** Pending stages whose dependencies can never be satisfied. */
export function unreachableStages(stages: Stage[]): Stage[] {
  const byId = indexStages(stages)
  return stages.filter((s) => s.status === 'pending' && depsBlocked(s, byId))
}

export type StageAction =
  | { type: 'start'; at: string }
  | { type: 'succeed'; at: string; result?: Record<string, unknown>; costUsd?: number }
  | { type: 'fail'; at: string; error: NonNullable<Stage['error']>; costUsd?: number }
  | { type: 'skip'; at: string; reason: string }
  | { type: 'wait_human'; at: string }
  | { type: 'resume'; at: string }
  | { type: 'pause'; at: string }
  | { type: 'cancel'; at: string }
  | { type: 'requeue'; at: string }

const ALLOWED: Record<StageAction['type'], StageStatus[]> = {
  start: ['pending', 'queued'],
  succeed: ['running'],
  fail: ['running'],
  skip: ['pending', 'queued'],
  wait_human: ['running'],
  resume: ['waiting_human', 'paused'],
  pause: ['running', 'queued'],
  cancel: ['pending', 'queued', 'running', 'waiting_human', 'paused', 'failed'],
  // `running` and `queued` requeue when the process that owned them died (the attempt stays counted).
  requeue: ['failed', 'succeeded', 'blocked', 'paused', 'waiting_human', 'running', 'queued'],
}

export class InvalidTransition extends Error {
  constructor(stage: Stage, action: StageAction['type']) {
    super(`stage ${stage.id}: cannot ${action} from ${stage.status}`)
  }
}

/** Pure transition. Throws InvalidTransition for illegal moves so bugs surface in tests. */
export function transition(stage: Stage, action: StageAction): Stage {
  if (!ALLOWED[action.type].includes(stage.status)) throw new InvalidTransition(stage, action.type)
  switch (action.type) {
    case 'start':
      return {
        ...stage,
        status: 'running',
        attempt: stage.attempt + 1,
        startedAt: action.at,
        endedAt: undefined,
        error: undefined,
      }
    case 'succeed':
      return {
        ...stage,
        status: 'succeeded',
        endedAt: action.at,
        result: action.result ?? stage.result,
        costUsd: stage.costUsd + (action.costUsd ?? 0),
      }
    case 'fail': {
      const exhausted = stage.attempt >= stage.maxAttempts
      return {
        ...stage,
        status: exhausted ? 'blocked' : 'failed',
        endedAt: action.at,
        error: action.error,
        costUsd: stage.costUsd + (action.costUsd ?? 0),
      }
    }
    case 'skip':
      return { ...stage, status: 'skipped', endedAt: action.at, skipReason: action.reason }
    case 'wait_human':
      return { ...stage, status: 'waiting_human' }
    case 'resume':
      return { ...stage, status: 'running' }
    case 'pause':
      return { ...stage, status: 'paused' }
    case 'cancel':
      return { ...stage, status: 'cancelled', endedAt: action.at }
    case 'requeue':
      return { ...stage, status: 'queued', endedAt: undefined, error: undefined }
  }
}

export function isTerminal(status: StageStatus): boolean {
  return TERMINAL_STAGE_STATUSES.has(status)
}

/**
 * Run status derived from stages. Explicit run-level pause/cancel win over derivation
 * because the caller records them on the run before calling this.
 */
export function deriveRunStatus(run: Run, stages: Stage[]): RunStatus {
  if (run.status === 'cancelled') return 'cancelled'
  if (stages.some((s) => s.status === 'waiting_human')) return 'waiting_human'
  if (run.status === 'paused') return 'paused'
  const allDone = stages.every((s) => isTerminal(s.status))
  if (!allDone) return stages.some((s) => s.status !== 'pending') ? 'running' : 'queued'
  const blocked = stages.filter((s) => s.status === 'blocked')
  // A target whose generation was skipped (no adapter or toolchain) was requested but not delivered.
  const undelivered = new Set(
    [...blocked, ...stages.filter((s) => s.kind === 'generate' && s.status === 'skipped')]
      .map((s) => s.target)
      .filter(Boolean),
  )
  if (blocked.length === 0 && undelivered.size === 0) return 'succeeded'
  const allTargetsUndelivered = run.targets.every((t) => undelivered.has(t))
  const untargetedBlocked = blocked.some((s) => !s.target)
  return untargetedBlocked || allTargetsUndelivered ? 'failed' : 'partial'
}
