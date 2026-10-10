import { describe, expect, it } from 'vitest'
import type { CriticOutput, Verdict } from '@mpf/core'
import { decideVerdict, findingId, fixBrief } from '../src/decide.ts'
import { rubricsFor } from '../src/rubrics.ts'

const output = (overrides: Partial<CriticOutput> = {}): CriticOutput => ({
  scores: { fidelity: 4, idiomatic: 4, testAdequacy: 3, parityDocs: 4, buildHealth: 5 },
  findings: [],
  confidence: 0.9,
  acceptedDeviationsSeen: [],
  summary: 's',
  ...overrides,
})
const blocking = (description: string, file = 'A.kt') => ({
  id: 'x',
  severity: 'blocking' as const,
  category: 'fidelity' as const,
  file,
  description,
  suggestedFix: 'f',
  evidence: 'e',
})
const advisory = (description: string) => ({
  id: 'x',
  severity: 'advisory' as const,
  category: 'idiomatic' as const,
  description,
  suggestedFix: 'f',
  evidence: 'e',
})
const base = {
  stageId: 'critique:android',
  target: 'android' as const,
  maxRounds: 2,
  accepted: new Set<string>(),
}

describe('decideVerdict', () => {
  it('passes with only advisory findings and assigns stable ids', () => {
    const d = decideVerdict({
      ...base,
      round: 1,
      output: output({ findings: [advisory('use a ViewModel')] }),
    })
    expect(d.verdict.decision).toBe('pass')
    expect(d.verdict.findings[0]?.id).toBe(findingId(advisory('use a ViewModel')))
  })
  it('asks for a fix on blocking findings and escalates once the rounds are spent', () => {
    expect(
      decideVerdict({ ...base, round: 1, output: output({ findings: [blocking('missing tag')] }) })
        .verdict.decision,
    ).toBe('fix')
    expect(
      decideVerdict({ ...base, round: 2, output: output({ findings: [blocking('missing tag')] }) })
        .verdict.decision,
    ).toBe('escalate')
  })
  it('escalates when the blocking set does not shrink between rounds', () => {
    const first = decideVerdict({
      ...base,
      round: 1,
      output: output({ findings: [blocking('a'), blocking('b')] }),
    }).verdict
    const same = decideVerdict({
      ...base,
      round: 2,
      maxRounds: 3,
      prior: first,
      output: output({ findings: [blocking('a'), blocking('b')] }),
    })
    expect(same.verdict.decision).toBe('escalate')
    const smaller = decideVerdict({
      ...base,
      round: 2,
      maxRounds: 3,
      prior: first,
      output: output({ findings: [blocking('a')] }),
    })
    expect(smaller.verdict.decision).toBe('fix')
    const different = decideVerdict({
      ...base,
      round: 2,
      maxRounds: 3,
      prior: first,
      output: output({ findings: [blocking('a'), blocking('c')] }),
    })
    expect(different.verdict.decision).toBe('fix')
  })
  it('drops accepted findings and escalates on low confidence', () => {
    const f = blocking('keep the quirk')
    const accepted = new Set([findingId(f)])
    expect(
      decideVerdict({ ...base, round: 1, accepted, output: output({ findings: [f] }) }).verdict
        .decision,
    ).toBe('pass')
    expect(
      decideVerdict({ ...base, round: 1, output: output({ confidence: 0.3 }) }).verdict.decision,
    ).toBe('escalate')
  })
  it('writes a fix brief with ids and suggestions', () => {
    const v: Verdict = {
      ...decideVerdict({
        ...base,
        round: 1,
        output: output({ findings: [blocking('missing tag', 'Home.kt'), advisory('naming')] }),
      }).verdict,
    }
    const brief = fixBrief(v)
    expect(brief).toContain('1 blocking issue')
    expect(brief).toContain('Home.kt')
    expect(brief).toContain('Advisory:')
  })
})

describe('rubricsFor', () => {
  it('includes the platform rubric', () => {
    expect(rubricsFor('ios')).toContain('Idiomatic iOS')
    expect(rubricsFor('android')).toContain('Idiomatic Android')
    expect(rubricsFor('web')).toContain('Idiomatic web')
  })
})
