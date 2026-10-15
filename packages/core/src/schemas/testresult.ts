import { z } from 'zod'
import { Id, Target } from './common.ts'

export const TestKind = z.enum(['build', 'unit', 'e2e', 'parity', 'lint', 'launch', 'screenshot'])
export type TestKind = z.infer<typeof TestKind>

export const TestStatus = z.enum(['pass', 'fail', 'skip', 'error', 'flaky'])
export type TestStatus = z.infer<typeof TestStatus>

export const TestCase = z.object({
  id: z.string(),
  name: z.string(),
  behaviorId: z.string().optional(),
  vectorId: z.string().optional(),
  status: TestStatus,
  durationMs: z.number().nonnegative().default(0),
  message: z.string().optional(),
  artifacts: z.array(Id).default([]),
  /** Workspace-relative files that show the failure (screenshot, view hierarchy). */
  evidence: z.array(z.string()).optional(),
  /** The 1-based BehaviorSpec step a flow failed at, when the runner can tell. */
  failedStep: z.number().int().positive().optional(),
})

/** Results also come from the shared core (parity) and from the source app's own suite, which are not port targets. */
export const TestResultTarget = z.union([Target, z.literal('core'), z.literal('source')])
export type TestResultTarget = z.infer<typeof TestResultTarget>

export type TestCase = z.infer<typeof TestCase>

export const TestResult = z.object({
  stageId: Id,
  target: TestResultTarget,
  kind: TestKind,
  status: TestStatus,
  skipReason: z.string().optional(),
  cases: z.array(TestCase).default([]),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative().default(0),
  }),
  reportPath: z.string().optional(),
})
export type TestResult = z.infer<typeof TestResult>
