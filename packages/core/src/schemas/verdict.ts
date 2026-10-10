import { z } from 'zod'
import { Id, Severity, Target } from './common.ts'

export const Finding = z.object({
  id: z.string().describe('Stable hash of category + behaviorId + file'),
  severity: Severity,
  category: z.enum(['fidelity', 'idiomatic', 'tests', 'parity-docs', 'build', 'privacy', 'other']),
  behaviorId: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  description: z.string(),
  suggestedFix: z.string(),
  evidence: z.string(),
})
export type Finding = z.infer<typeof Finding>

export const Verdict = z.object({
  stageId: Id,
  target: Target,
  round: z.number().int().positive(),
  scores: z.object({
    fidelity: z.number().min(0).max(5),
    idiomatic: z.number().min(0).max(5),
    testAdequacy: z.number().min(0).max(5),
    parityDocs: z.number().min(0).max(5),
    buildHealth: z.number().min(0).max(5),
  }),
  findings: z.array(Finding),
  decision: z.enum(['pass', 'fix', 'escalate']),
  confidence: z.number().min(0).max(1),
  acceptedDeviationsSeen: z.array(z.string()).default([]),
  summary: z.string(),
})
export type Verdict = z.infer<typeof Verdict>

/** What the critic LLM returns; the deterministic decision layer adds `decision` and ids. */
export const CriticOutput = Verdict.omit({
  stageId: true,
  target: true,
  round: true,
  decision: true,
})
export type CriticOutput = z.infer<typeof CriticOutput>
