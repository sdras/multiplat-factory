import { createHash } from 'node:crypto'
import type { CriticOutput, Finding, Verdict } from '@mpf/core'

/** Stable id from what a finding is about, so rounds can be compared and accepted items filtered. */
export function findingId(
  f: Pick<Finding, 'category' | 'behaviorId' | 'file' | 'description'>,
): string {
  const key = [
    f.category,
    f.behaviorId ?? '',
    f.file ?? '',
    f.description.toLowerCase().replace(/\s+/g, ' ').slice(0, 80),
  ].join('|')
  return createHash('sha1').update(key).digest('hex').slice(0, 10)
}

export interface DecisionInput {
  output: CriticOutput
  stageId: string
  target: Verdict['target']
  round: number
  maxRounds: number
  /** Finding ids and deviation texts a human accepted. */
  accepted: Set<string>
  prior?: Verdict
}

export interface Decision {
  verdict: Verdict
  /** Why the deterministic layer chose the decision (for the log). */
  reason: string
}

/**
 * Deterministic decision on top of the LLM's assessment:
 * - drop findings that were accepted,
 * - blocking findings mean "fix" unless the round budget is spent or the set did not shrink, then "escalate",
 * - low confidence escalates,
 * - otherwise pass.
 */
export function decideVerdict(i: DecisionInput): Decision {
  const findings: Finding[] = i.output.findings
    .map((f) => ({ ...f, id: findingId(f) }))
    .filter((f) => !i.accepted.has(f.id) && !i.accepted.has(f.description))
  const blocking = findings.filter((f) => f.severity === 'blocking')
  const base: Omit<Verdict, 'decision'> = {
    stageId: i.stageId,
    target: i.target,
    round: i.round,
    scores: i.output.scores,
    findings,
    confidence: i.output.confidence,
    acceptedDeviationsSeen: i.output.acceptedDeviationsSeen,
    summary: i.output.summary,
  }
  if (i.output.confidence < 0.5) {
    return {
      verdict: { ...base, decision: 'escalate' },
      reason: `critic confidence ${i.output.confidence.toFixed(2)} is below 0.5`,
    }
  }
  if (blocking.length === 0) {
    return {
      verdict: { ...base, decision: 'pass' },
      reason: findings.length
        ? `${findings.length} advisory finding(s), nothing blocking`
        : 'no findings',
    }
  }
  if (i.round >= i.maxRounds) {
    return {
      verdict: { ...base, decision: 'escalate' },
      reason: `${blocking.length} blocking finding(s) after the last allowed round`,
    }
  }
  if (i.prior) {
    const before = new Set(
      i.prior.findings.filter((f) => f.severity === 'blocking').map((f) => f.id),
    )
    const now = new Set(blocking.map((f) => f.id))
    const shrank = now.size < before.size && [...now].every((id) => before.has(id))
    const anyNew = [...now].some((id) => !before.has(id))
    if (!shrank && !anyNew) {
      return {
        verdict: { ...base, decision: 'escalate' },
        reason: 'the blocking set did not shrink since the previous round',
      }
    }
  }
  return { verdict: { ...base, decision: 'fix' }, reason: `${blocking.length} blocking finding(s)` }
}

/** Short brief handed to the fix worker. */
export function fixBrief(verdict: Verdict): string {
  const blocking = verdict.findings.filter((f) => f.severity === 'blocking')
  const advisory = verdict.findings.filter((f) => f.severity === 'advisory')
  return [
    `The independent critic reviewed the ${verdict.target} port (round ${verdict.round}) and found ${blocking.length} blocking issue(s). Fix every blocking issue; fix advisory ones when cheap. Rebuild and rerun unit tests until green, then return the structured output again.`,
    '',
    'Blocking:',
    ...blocking.map(
      (f) =>
        `- [${f.id}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''}${f.behaviorId ? ` (${f.behaviorId})` : ''} ${f.description}\n  fix: ${f.suggestedFix}\n  evidence: ${f.evidence}`,
    ),
    advisory.length ? '' : '',
    ...(advisory.length
      ? [
          'Advisory:',
          ...advisory.map(
            (f) => `- [${f.id}] ${f.file ?? ''} ${f.description} (fix: ${f.suggestedFix})`,
          ),
        ]
      : []),
  ].join('\n')
}
