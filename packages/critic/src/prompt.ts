import type { AppSpec, BehaviorSpec, Diagnostic, TargetPlan, TestResult, Verdict } from '@mpf/core'

export interface CriticInput {
  target: string
  round: number
  maxRounds: number
  spec: AppSpec
  behaviors: BehaviorSpec
  plan: TargetPlan
  /** Latest test results per kind for this target. */
  tests: TestResult[]
  /** Diagnostics from the last build, if any. */
  buildDiagnostics: Diagnostic[]
  /** What the generation worker reported: deviations and notes. */
  workerSummary?: {
    deviations: { what: string; why: string }[]
    notes: string
    behaviorsCovered: string[]
  }
  /** Deviations the human or the plan accepted; findings about these are not raised. */
  acceptedDeviations: string[]
  /** Findings from earlier rounds, so the critic can mark what is resolved. */
  priorVerdicts: Verdict[]
  /** Paths (absolute) of screenshots the critic may open, labeled. */
  screenshots: { label: string; path: string }[]
  /** Where the generated project and the read-only source live. */
  workspace: string
  sourceDir: string
  instructions: string[]
}

export function criticPrompt(i: CriticInput): string {
  const testLines = i.tests.length
    ? i.tests.map((t) => {
        const failing = t.cases
          .filter((c) => c.status === 'fail')
          .map((c) => `${c.name}${c.behaviorId ? ` (${c.behaviorId})` : ''}: ${c.message ?? ''}`)
        const skipped = t.cases
          .filter((c) => c.status === 'skip')
          .map(
            (c) =>
              `${c.name}${c.behaviorId ? ` (${c.behaviorId})` : ''}${c.message ? `: ${c.message}` : ''}`,
          )
        return [
          `- ${t.kind}: ${t.status} ${t.summary.passed}/${t.summary.total}${t.summary.flaky ? `, ${t.summary.flaky} flaky` : ''}${t.skipReason ? ` (${t.skipReason})` : ''}`,
          ...failing.slice(0, 30).map((f) => `    fail: ${f}`),
          ...skipped.slice(0, 30).map((s) => `    skipped: ${s}`),
        ].join('\n')
      })
    : ['- no test results were recorded']
  const covered = new Set(
    i.tests.flatMap((t) =>
      t.cases.filter((c) => c.status === 'pass' && c.behaviorId).map((c) => c.behaviorId!),
    ),
  )
  const unverified = i.behaviors.behaviors.filter((b) => !covered.has(b.id))
  return [
    `Target: ${i.target}. Review round ${i.round} of ${i.maxRounds}.`,
    `Generated project (read it): ${i.workspace}`,
    `Source app (read-only, for comparison): ${i.sourceDir}`,
    '',
    'Target plan:',
    '```json',
    JSON.stringify(i.plan, null, 1).slice(0, 25_000),
    '```',
    '',
    'AppSpec:',
    '```json',
    JSON.stringify(i.spec, null, 1).slice(0, 40_000),
    '```',
    '',
    'BehaviorSpec:',
    '```json',
    JSON.stringify(i.behaviors, null, 1).slice(0, 30_000),
    '```',
    '',
    'Test results (latest):',
    ...testLines,
    '',
    unverified.length
      ? `Behaviors without a passing automated check (verify these by reading the code): ${unverified.map((b) => `${b.id}${b.priority === 'must' ? ' (must)' : ''}`).join(', ')}`
      : 'Every behavior has a passing automated check.',
    '',
    i.buildDiagnostics.length
      ? [
          'Last build diagnostics:',
          ...i.buildDiagnostics
            .slice(0, 20)
            .map(
              (d) => `- ${d.severity} ${d.file ?? ''}${d.line ? `:${d.line}` : ''} ${d.message}`,
            ),
        ].join('\n')
      : 'The build is clean.',
    '',
    i.workerSummary
      ? [
          'Worker-reported deviations and notes:',
          ...i.workerSummary.deviations.map((d) => `- ${d.what}: ${d.why}`),
          i.workerSummary.notes ? `notes: ${i.workerSummary.notes}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    '',
    i.acceptedDeviations.length
      ? ['Accepted deviations (do not raise):', ...i.acceptedDeviations.map((d) => `- ${d}`)].join(
          '\n',
        )
      : 'No deviations have been accepted yet.',
    '',
    i.priorVerdicts.length
      ? [
          'Previous rounds:',
          ...i.priorVerdicts.map(
            (v) =>
              `- round ${v.round}: ${v.decision}, blocking ${
                v.findings
                  .filter((f) => f.severity === 'blocking')
                  .map((f) => f.id)
                  .join(', ') || 'none'
              }`,
          ),
        ].join('\n')
      : '',
    '',
    i.screenshots.length
      ? [
          'Screenshots you may open with the Read tool:',
          ...i.screenshots.map((s) => `- ${s.label}: ${s.path}`),
        ].join('\n')
      : 'No screenshots are available.',
    '',
    'Read the generated code and compare it with the source where the spec is ambiguous. Then return the structured verdict.',
    ...(i.instructions.length
      ? ['', 'Additional instructions from the operator:', ...i.instructions.map((x) => `- ${x}`)]
      : []),
  ]
    .filter((l) => l !== '')
    .join('\n')
}
