import { z } from 'zod'
import { Target } from './common.ts'
import { IntegrationKind, PersistenceMechanism } from './appspec.ts'

export const Deviation = z.object({
  what: z.string(),
  why: z.string(),
  accepted: z.boolean().default(false),
})

export const TargetPlan = z.object({
  target: Target,
  uiFramework: z.string(),
  layout: z.string().describe('Project layout summary'),
  screenMap: z.array(
    z.object({ screen: z.string(), file: z.string(), notes: z.string().optional() }),
  ),
  stateStrategy: z.string(),
  persistenceMap: z.array(
    z.object({
      sourceKey: z.string(),
      mechanism: PersistenceMechanism,
      sameWireFormat: z.boolean(),
    }),
  ),
  integrationMap: z.array(
    z.object({
      kind: IntegrationKind,
      decision: z.enum(['port', 'stub', 'omit']),
      rationale: z.string(),
    }),
  ),
  deviations: z.array(Deviation).default([]),
})

export const CoreFunction = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  sourceSymbols: z.array(z.string()),
})

export type Deviation = z.infer<typeof Deviation>
export type TargetPlan = z.infer<typeof TargetPlan>
export type CoreFunction = z.infer<typeof CoreFunction>

export const PortPlan = z.object({
  targets: z.array(TargetPlan).min(1),
  core: z.object({
    enabled: z.boolean(),
    rationale: z.string(),
    functions: z.array(CoreFunction).default([]),
  }),
  testPlan: z.object({
    unit: z.array(z.string()).default([]),
    e2e: z.array(z.string()).default([]).describe('behavior ids'),
    parity: z.array(z.string()).default([]),
  }),
  estimate: z.object({
    stages: z.number().int(),
    costUsd: z.number().nonnegative(),
    minutes: z.number().nonnegative(),
  }),
  questionsForHuman: z.array(z.string()).default([]),
})
export type PortPlan = z.infer<typeof PortPlan>
