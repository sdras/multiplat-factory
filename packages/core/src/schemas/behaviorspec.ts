import { z } from 'zod'
import { Priority } from './common.ts'

export const Step = z.discriminatedUnion('op', [
  z.object({ op: z.literal('navigate'), screen: z.string() }),
  z.object({
    op: z.literal('openRoute'),
    route: z
      .string()
      .describe(
        'Open a raw route by id, possibly one the app does not recognize (e.g. "nope"), to test fallbacks',
      ),
  }),
  z.object({
    op: z.literal('tap'),
    element: z.string(),
    text: z
      .string()
      .optional()
      .describe('When several elements share the id, the one whose visible text contains this'),
  }),
  z.object({ op: z.literal('type'), element: z.string(), text: z.string() }),
  z.object({
    op: z.literal('select'),
    element: z.string(),
    option: z.string().describe('The option to choose, by value or visible label'),
  }),
  z.object({ op: z.literal('expectVisible'), element: z.string() }),
  z.object({ op: z.literal('expectHidden'), element: z.string() }),
  z.object({
    op: z.literal('expectText'),
    element: z.string(),
    text: z.string(),
    exact: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('expectCount'),
    element: z.string(),
    count: z.number().int().nonnegative(),
  }),
  /** A swipe gesture on an element (swipe-to-delete, dismiss, carousel); web ports expose the same action as a visible control. */
  z.object({
    op: z.literal('swipe'),
    element: z.string(),
    direction: z.enum(['left', 'right', 'up', 'down']),
  }),
  z.object({ op: z.literal('restart') }),
  z.object({ op: z.literal('seed'), state: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('wait'), ms: z.number().int().positive().max(10_000) }),
  z.object({ op: z.literal('custom'), description: z.string() }),
])
export type Step = z.infer<typeof Step>

export const Behavior = z.object({
  id: z.string().regex(/^B-\d{3,}$/),
  title: z.string(),
  screen: z.string(),
  priority: Priority,
  category: z.enum([
    'nav',
    'state',
    'persistence',
    'validation',
    'logic',
    'integration',
    'display',
  ]),
  steps: z.array(Step).min(1),
  evidence: z.array(z.string()).default([]).describe('file:line references in the source'),
  verifiedOnSource: z.boolean().default(false),
  observedScreenshot: z.string().optional(),
})
export type Behavior = z.infer<typeof Behavior>

export const BehaviorSpec = z.object({
  behaviors: z.array(Behavior).min(1),
  invariants: z.array(z.string()).default([]).describe('Wire-format pins and intentional quirks'),
  seedData: z.record(z.string(), z.unknown()).default({}),
})
export type BehaviorSpec = z.infer<typeof BehaviorSpec>
