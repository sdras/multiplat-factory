import type { AppSpec, CoreMode } from '@mpf/core'

export interface Candidacy {
  enabled: boolean
  score: number
  pureLoc: number
  rationale: string
  functions: string[]
}

const VALUABLE =
  /date|schedul|calendar|week|streak|price|pricing|total|tax|discount|score|rank|serializ|deserializ|parse|format|validat|convert|currenc|unit|recurr|budget|interest|payroll|shipping|inventory|match|sort|filter|search|diff|merge/i

/**
 * Deterministic first pass on whether a shared WASM core is worth it.
 * The plan stage may confirm or override with a rationale; `always`/`never` win.
 */
export function coreCandidacy(spec: AppSpec, mode: CoreMode): Candidacy {
  const pure = spec.logic.filter((l) => l.purity === 'pure')
  const candidates = pure.filter((l) => l.coreCandidate)
  const pureLoc = candidates.reduce((n, l) => n + l.loc, 0)
  const valuable = candidates.filter(
    (l) => VALUABLE.test(`${l.description} ${l.symbol}`) && l.loc >= 30,
  )
  const score = Math.min(1, pureLoc / 150 + valuable.length * 0.35)
  const functions = candidates.map((l) => l.symbol)
  const heuristic = pureLoc >= 150 || valuable.length > 0
  if (mode === 'never')
    return { enabled: false, score, pureLoc, rationale: 'disabled by run option', functions }
  if (mode === 'always') {
    return {
      enabled: true,
      score,
      pureLoc,
      rationale: candidates.length
        ? 'forced by run option'
        : 'forced by run option, but no pure logic candidates were found; the core will be small',
      functions,
    }
  }
  return {
    enabled: heuristic,
    score,
    pureLoc,
    rationale: heuristic
      ? `${candidates.length} pure logic units (${pureLoc} lines)${valuable.length ? `, including ${valuable.map((v) => v.symbol).join(', ')}` : ''} justify one shared implementation`
      : `only ${pureLoc} lines of pure, platform-independent logic; native implementations per target with parity tests are cheaper`,
    functions,
  }
}
