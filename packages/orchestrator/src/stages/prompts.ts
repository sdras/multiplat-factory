import type { AppSpec, BehaviorSpec, Diagnostic, TargetPlan, TestResult } from '@mpf/core'

export const GENERATE_SYSTEM = `You are the generation worker inside multiplat-factory, a tool that ports apps between web, iOS, and Android.
You implement one target of a port inside a prepared project that already builds (the scaffold). You may be handed any kind of app; never assume a particular source stack.

Rules:
- Implement every screen in the target plan's screenMap and every element from the AppSpec. Each element must carry its \`testId\` as the platform test hook exactly as the project conventions describe; automated flows find elements by it.
- Reproduce every behavior in the BehaviorSpec. Must-behaviors are the acceptance bar; should-behaviors matter too.
- Persistence keeps the source app's keys and JSON wire formats byte-compatible (see the AppSpec pins). Never rename keys.
- Implement pure logic natively unless the plan enables a shared core; write unit tests for every logic unit, including edge cases from the behaviors.
- Keep every convention in the project's MPF.md: routes, deep links, root and screen tags, the debug seed extra, the store class. Do not edit files under maestro/ or flows/; the factory generates them.
- Build and run the unit tests yourself with the documented commands until both are green. Read compiler output carefully; do not guess APIs.
- The source app is mounted read-only; read it whenever the spec is ambiguous. Follow its behavior, not its implementation.
- Add no dependencies that need network access at runtime unless the plan ports that integration. Never write credentials.
- Precedence: where the plan names concrete file paths, a package or bundle id, or a deep-link scheme that differ from the project conventions, the conventions win; they are wired into the scaffold and into the factory's flows. Implement the plan's intent inside them. The plan's persistence mechanism may replace the store's backing implementation when it gives a fidelity reason, as long as the store's public interface and the debug seed hook keep working.
- Finish with the structured output: files written, behavior ids covered, deviations (what and why), and notes for the reviewer.`

export interface GeneratePromptInput {
  target: string
  plan: TargetPlan
  spec: AppSpec
  behaviors: BehaviorSpec
  sourceDir: string
  coreDir?: string
  instructions: string[]
}

export function generatePrompt(i: GeneratePromptInput): string {
  return [
    `Target: ${i.target}. The project in the current directory is the scaffold; it builds as is.`,
    `Source app (read-only): ${i.sourceDir}`,
    i.coreDir
      ? `Shared core (read-only, already built): ${i.coreDir}`
      : 'No shared core for this run: implement logic natively.',
    '',
    'Target plan:',
    '```json',
    JSON.stringify(i.plan, null, 1).slice(0, 30_000),
    '```',
    '',
    'AppSpec:',
    '```json',
    JSON.stringify(i.spec, null, 1).slice(0, 50_000),
    '```',
    '',
    'BehaviorSpec:',
    '```json',
    JSON.stringify(i.behaviors, null, 1).slice(0, 40_000),
    '```',
    '',
    'Implement the port now. Build and unit-test until green, then return the structured output.',
    ...(i.instructions.length
      ? ['', 'Additional instructions from the operator:', ...i.instructions.map((x) => `- ${x}`)]
      : []),
  ].join('\n')
}

export function buildFixPrompt(
  diagnostics: Diagnostic[],
  logTail: string,
  round: number,
  max: number,
): string {
  return [
    `The build failed (fix round ${round} of ${max}). Fix the causes below, rebuild until it passes, keep the unit tests green, and return the structured output again.`,
    '',
    'Diagnostics:',
    ...diagnostics
      .slice(0, 40)
      .map(
        (d) =>
          `- ${d.severity} ${d.file ?? ''}${d.line ? `:${d.line}` : ''}${d.column ? `:${d.column}` : ''} ${d.message}`,
      ),
    '',
    'Build output (tail):',
    '```',
    logTail.slice(-3000),
    '```',
  ].join('\n')
}

export function testFixPrompt(
  results: TestResult[],
  mustFailures: string[],
  round: number,
  max: number,
): string {
  const failing = results.flatMap((r) =>
    r.cases
      .filter((c) => c.status === 'fail')
      .map(
        (c) =>
          `- [${r.kind}] ${c.name}${c.behaviorId ? ` (${c.behaviorId})` : ''}: ${(c.message ?? 'failed').replace(/\n/g, '\n  ')}${c.evidence?.length ? `\n  Evidence in the workspace (open the screenshot with Read): ${c.evidence.join(', ')}` : ''}`,
      ),
  )
  return [
    `Tests failed (fix round ${round} of ${max}). Make the app satisfy the behaviors below without weakening tests. Rebuild and rerun the unit tests until green, then return the structured output again.`,
    mustFailures.length ? `Blocking (must-behaviors): ${mustFailures.join(', ')}` : '',
    '',
    'Failing cases:',
    ...failing.slice(0, 60),
    '',
    'Automated flows locate elements by the AppSpec testId (resource id / accessibility identifier). A missing element usually means a missing or misplaced test tag. A tap that completes without effect usually means the control sits under a system window (status bar, keyboard) or another composable; check the bounds in the evidence.',
  ]
    .filter((l) => l !== '')
    .join('\n')
}
