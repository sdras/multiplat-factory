import type { Run } from '@mpf/core/schemas'

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
