import type { AppSpec, Behavior } from '@mpf/core'

/**
 * Where a flow opens. A behavior's `screen` is a hint; its steps are the truth. When no leading
 * `navigate` or `openRoute` says where to start and the first element step belongs to exactly one
 * other screen, the flow opens there. Five behaviors of the Compose sample's web port said
 * `task-detail` and began by tapping the list's add button; opening the detail screen failed them
 * all on step one.
 */
export function startScreenOf(
  spec: AppSpec,
  behavior: Behavior,
): { screen: string; corrected?: string } {
  const first = behavior.steps[0]
  if (first && (first.op === 'navigate' || first.op === 'openRoute')) {
    return { screen: behavior.screen }
  }
  const step = behavior.steps.find((s) => 'element' in s && s.op !== 'expectHidden')
  if (!step || !('element' in step)) return { screen: behavior.screen }
  const owners = spec.screens
    .filter((s) => s.elements.some((e) => e.id === step.element))
    .map((s) => s.id)
  if (owners.length !== 1 || owners[0] === behavior.screen) return { screen: behavior.screen }
  return { screen: owners[0]!, corrected: behavior.screen }
}
