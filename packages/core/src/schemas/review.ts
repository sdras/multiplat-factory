import { z } from 'zod'
import { Id, IsoDate, Target } from './common.ts'
import { DesignOption, DesignOptions } from './design.ts'

const Point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
export const ReviewMark = z
  .object({
    kind: z.enum(['pin', 'arrow', 'rectangle', 'pen']),
    points: z.array(Point).min(1).max(1000),
  })
  .superRefine((mark, ctx) => {
    if (mark.kind !== 'pin' && mark.points.length < 2)
      ctx.addIssue({ code: 'custom', message: 'Draw at least two points.' })
  })
export type ReviewMark = z.infer<typeof ReviewMark>
export const ReviewContext = z.object({
  page: z.enum(['project', 'plan', 'attention', 'tests', 'release']).default('project'),
  target: z.union([Target, z.literal('source')]).optional(),
  screenId: z.string().max(200).optional(),
  feedbackIds: z.array(Id).max(30).default([]),
})
export type ReviewContext = z.infer<typeof ReviewContext>
export const ChatInput = z.object({
  requestId: Id,
  text: z.string().trim().min(1).max(12000),
  context: ReviewContext.prefault({}),
  mode: z.enum(['chat', 'design']).default('chat'),
  impeccable: z.boolean().default(false),
})
export const FeedbackInput = z.object({
  requestId: Id,
  artifactId: Id,
  text: z.string().trim().min(1).max(6000),
  marks: z.array(ReviewMark).max(40).default([]),
})
export const RevisionProposal = z.object({
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(12000),
  kind: z.enum(['plan', 'revision']),
  targets: z.array(Target).min(1).max(3),
  design: DesignOption.optional(),
})
export const ChatReply = z.object({
  text: z.string().min(1).max(20000),
  proposal: RevisionProposal.nullable(),
})
export type RevisionProposal = z.infer<typeof RevisionProposal>
const Base = { id: Id, runId: Id, createdAt: IsoDate }
export const ReviewEntry = z.discriminatedUnion('kind', [
  z.object({
    ...Base,
    kind: z.literal('message'),
    role: z.enum(['user', 'assistant', 'system']),
    text: z.string(),
    context: ReviewContext.optional(),
    costUsd: z.number().optional(),
    requestId: Id.optional(),
  }),
  z.object({
    ...Base,
    kind: z.literal('feedback'),
    text: z.string(),
    artifactId: Id,
    snapshotId: Id,
    screenId: z.string(),
    target: z.string(),
    marks: z.array(ReviewMark),
    status: z.enum(['open', 'resolved']),
    requestId: Id,
  }),
  z.object({
    ...Base,
    kind: z.literal('proposal'),
    proposal: RevisionProposal,
    status: z.enum(['proposed', 'applied', 'dismissed']),
    revisionRunId: Id.optional(),
    feedbackIds: z.array(Id).default([]),
  }),
  z.object({
    ...Base,
    kind: z.literal('checklist'),
    target: Target,
    item: z.string().max(100),
    checked: z.boolean(),
  }),
  z.object({
    ...Base,
    kind: z.literal('design'),
    text: z.string(),
    options: DesignOptions,
    impeccable: z.boolean().default(false),
    impeccableVersion: z.string().optional(),
    target: Target,
    requestId: Id,
    feedbackIds: z.array(Id).default([]),
    selectedOption: z.enum(['a', 'b', 'c']).optional(),
    proposalId: Id.optional(),
  }),
  z.object({
    ...Base,
    kind: z.literal('direction'),
    value: z.enum(['adapt', 'match', 'explore']),
    notes: z.string().max(6000),
  }),
])
export type ReviewEntry = z.infer<typeof ReviewEntry>
/** Entries are immutable events; later updates replace the same id in the projected view. */
export function reduceReview(entries: ReviewEntry[]): ReviewEntry[] {
  const byId = new Map<string, ReviewEntry>()
  for (const entry of entries) byId.set(entry.id, entry)
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

export const RELEASE_STEPS = {
  web: [
    { id: 'review', title: 'Review the site in a browser' },
    { id: 'config', title: 'Set up your hosting environment' },
    { id: 'preview', title: 'Deploy a preview and test it' },
    { id: 'publish', title: 'Publish and check the live URL' },
  ],
  ios: [
    { id: 'review', title: 'Review the app and its screenshots' },
    { id: 'privacy', title: 'Complete your listing and privacy information' },
    { id: 'sign', title: 'Create a signed distribution build' },
    { id: 'submit', title: 'Upload and submit for review' },
  ],
  android: [
    { id: 'review', title: 'Review the app on a device' },
    { id: 'listing', title: 'Prepare the listing and app content' },
    { id: 'sign', title: 'Build a signed Android App Bundle' },
    { id: 'submit', title: 'Test the release and submit it' },
  ],
} as const
