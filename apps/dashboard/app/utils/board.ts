import type { Run, Stage } from '@mpf/core/schemas'

export function projectName(locator: string): string {
  return (
    locator
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.git$/, '') || 'Untitled project'
  )
}
export const boardPlatform: Record<string, string> = {
  web: 'Web',
  ios: 'iPhone & iPad',
  android: 'Android',
  source: 'Original',
  core: 'Shared logic',
}
export const boardStatus: Record<string, string> = {
  queued: 'Getting ready',
  running: 'In progress',
  paused: 'Paused',
  waiting_human: 'Needs your input',
  succeeded: 'Build complete',
  partial: 'Partially complete',
  failed: 'Needs attention',
  cancelled: 'Cancelled',
}
export function groupProjects(runs: Run[]) {
  const groups = new Map<string, Run[]>()
  for (const run of runs) {
    const key = run.source.locator
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  return [...groups.entries()]
    .map(([source, history]) => ({
      source,
      name: projectName(source),
      history: history.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }))
    .sort((a, b) => b.history[0]!.createdAt.localeCompare(a.history[0]!.createdAt))
}

export const boardStage: Record<string, string> = {
  ingest: 'Bringing in your project',
  inventory: 'Understanding your app',
  spec: 'Mapping your screens',
  behaviors: 'Learning how your app works',
  observe: 'Checking the original',
  plan: 'Preparing your plan',
  'core.extract': 'Sharing your app logic',
  'core.vectors': 'Checking shared behavior',
  'core.build': 'Building shared logic',
  generate: 'Creating your new app',
  build: 'Building the app',
  test: 'Checking features and screens',
  critique: 'Reviewing quality',
  fix: 'Refining the app',
  report: 'Preparing your release guide',
}

/** The last segments of a project's locator: enough to tell projects apart without the whole path. */
export function boardPath(locator: string): string {
  return (
    locator
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .slice(-3)
      .join('/') || locator
  )
}

const RUN_SUMMARY = /(\w+): (\d+)\/(\d+) flows, (\d+)\/(\d+) unit, critic (\w+) ([\d.]+)\/5/g

/**
 * One or two sentences on a project card. A finished run's summary line
 * (`android: 11/11 flows, 59/59 unit, critic pass 4.3/5`) is rewritten in the
 * board's words; a live run names the step it is on.
 */
export function boardSummary(run: Run, stages: Stage[]): string {
  if (run.summary) {
    const parts = [...run.summary.matchAll(RUN_SUMMARY)].map(
      ([, target, flowsPassed, flows, unitPassed, unit, decision, score]) =>
        `${boardPlatform[target!] ?? target}: ${flowsPassed} of ${flows} user flows pass, ` +
        `${unitPassed} of ${unit} unit tests, quality review ${score} of 5` +
        `${decision === 'escalate' ? ' with accepted differences' : ''}.`,
    )
    return parts.length ? parts.join(' ') : run.summary
  }
  const done = stages.filter((s) => ['succeeded', 'skipped'].includes(s.status)).length
  const live =
    stages.find((s) => s.status === 'running') ?? stages.find((s) => s.status === 'waiting_human')
  if (live) {
    const lead = live.status === 'waiting_human' ? 'Waiting for you at' : 'Now'
    return `${lead}: ${boardStage[live.kind] ?? live.kind}. ${done} of ${stages.length} steps done.`
  }
  if (run.status === 'paused')
    return `Paused with ${done} of ${stages.length} steps done. Resume when you are ready.`
  return 'Open the project to see its current step, test results, and any issues.'
}
