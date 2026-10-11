import { z } from 'zod'
import { Id, IsoDate } from './common.ts'
import { Artifact } from './artifact.ts'
import { Run } from './run.ts'
import { Stage } from './stage.ts'
import { TestResult } from './testresult.ts'
import { ReviewEntry } from './review.ts'
import { Verdict } from './verdict.ts'

export const EventBase = z.object({
  runId: Id,
  stageId: Id.optional(),
  ts: IsoDate,
})

export const EventPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('review.entry'), entry: ReviewEntry }),
  z.object({ type: z.literal('run.status'), run: Run }),
  z.object({ type: z.literal('stage.status'), stage: Stage }),
  z.object({
    type: z.literal('agent.message'),
    role: z.enum(['assistant', 'user', 'system']),
    text: z.string(),
    partial: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('agent.tool_use'),
    toolUseId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('agent.tool_result'),
    toolUseId: z.string(),
    tool: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal('proc.started'),
    procId: z.string(),
    command: z.string(),
    cwd: z.string(),
  }),
  z.object({ type: z.literal('proc.stdout'), procId: z.string(), chunk: z.string() }),
  z.object({ type: z.literal('proc.stderr'), procId: z.string(), chunk: z.string() }),
  z.object({
    type: z.literal('proc.exited'),
    procId: z.string(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal('build.result'),
    ok: z.boolean(),
    errors: z.number().int(),
    warnings: z.number().int(),
  }),
  z.object({ type: z.literal('test.result'), result: TestResult }),
  z.object({ type: z.literal('critic.verdict'), verdict: Verdict }),
  z.object({ type: z.literal('cost.update'), stageCostUsd: z.number(), runCostUsd: z.number() }),
  z.object({ type: z.literal('artifact.added'), artifact: Artifact }),
  z.object({
    type: z.literal('control'),
    action: z.enum([
      'approve',
      'reject',
      'pause',
      'resume',
      'cancel',
      'instruct',
      'rerun',
      'topup',
    ]),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    type: z.literal('human.required'),
    reason: z.string(),
    choices: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
  z.object({
    type: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
  }),
])
export type EventPayload = z.infer<typeof EventPayload>

export const Event = z.intersection(
  EventBase.extend({ seq: z.number().int().nonnegative() }),
  EventPayload,
)
export type Event = z.infer<typeof Event>

/** An event before the store assigns `seq`. Keeps the payload union intact for callers. */
export type EventInput = z.infer<typeof EventBase> & EventPayload

export type EventType = EventPayload['type']
