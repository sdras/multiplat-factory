import type { AppSpec, BehaviorSpec, PortPlan, Run } from '@mpf/core'
import { routeParameter } from '@mpf/core'

/** Every behavior must reference screens and elements that exist in the spec. */
export function validateBehaviorRefs(spec: AppSpec, behaviors: BehaviorSpec): string[] {
  const screens = new Set(spec.screens.map((s) => s.id))
  const routeOf = new Map(spec.screens.map((s) => [s.id, s.route]))
  const elements = new Set(spec.screens.flatMap((s) => s.elements.map((e) => e.id)))
  const screenOf = new Map(
    spec.screens.flatMap((s) => s.elements.map((e) => [e.id, s.id] as const)),
  )
  const errors: string[] = []
  const ids = new Set<string>()
  for (const b of behaviors.behaviors) {
    if (ids.has(b.id)) errors.push(`${b.id}: duplicate id`)
    ids.add(b.id)
    if (!screens.has(b.screen)) errors.push(`${b.id}: unknown screen "${b.screen}"`)
    // A flow opens on `screen` (or where its leading navigate/openRoute/seed says); the first element it
    // touches must live there, or the flow walks to the wrong place before its first step.
    const first = b.steps[0]
    if (
      first &&
      'element' in first &&
      !['navigate', 'openRoute', 'seed', 'restart'].includes(first.op)
    ) {
      const at = screenOf.get(first.element)
      if (at && at !== b.screen)
        errors.push(
          `${b.id}: starts on screen "${b.screen}" but its first step uses "${first.element}" from screen "${at}"; set screen to "${at}" or begin with a navigate step`,
        )
    }
    // A screen whose route has a parameter has no URL of its own: a flow cannot open it directly.
    const param = routeParameter(routeOf.get(b.screen))
    if (param && !['navigate', 'openRoute'].includes(first?.op ?? ''))
      errors.push(
        `${b.id}: starts on screen "${b.screen}" whose route "${routeOf.get(b.screen)}" has a parameter (${param}); start on a screen with a concrete route and reach "${b.screen}" by tapping the item that leads there`,
      )
    for (const [i, step] of b.steps.entries()) {
      if (step.op === 'navigate' && routeParameter(routeOf.get(step.screen)))
        errors.push(
          `${b.id} step ${i + 1}: navigate to "${step.screen}" whose route has a parameter; reach it through the UI instead`,
        )
      if (step.op === 'navigate' && !screens.has(step.screen)) {
        errors.push(`${b.id} step ${i + 1}: unknown screen "${step.screen}"`)
      }
      if ('element' in step && !elements.has(step.element)) {
        errors.push(`${b.id} step ${i + 1}: unknown element "${step.element}"`)
      }
    }
  }
  const covered = new Set(behaviors.behaviors.map((b) => b.screen))
  for (const s of spec.screens)
    if (!covered.has(s.id)) errors.push(`screen "${s.id}" has no behaviors`)
  return errors
}

/** Drop behaviors that still reference unknown ids after a repair attempt. */
export function pruneInvalidBehaviors(
  spec: AppSpec,
  behaviors: BehaviorSpec,
): { kept: BehaviorSpec; dropped: string[] } {
  const screens = new Set(spec.screens.map((s) => s.id))
  const elements = new Set(spec.screens.flatMap((s) => s.elements.map((e) => e.id)))
  const dropped: string[] = []
  const list = behaviors.behaviors.filter((b) => {
    const ok =
      screens.has(b.screen) &&
      b.steps.every((s) =>
        s.op === 'navigate'
          ? screens.has(s.screen)
          : 'element' in s
            ? elements.has(s.element)
            : true,
      )
    if (!ok) dropped.push(b.id)
    return ok
  })
  return { kept: { ...behaviors, behaviors: list }, dropped }
}

/** Deterministic completeness checks on a port plan. */
export function validatePlan(
  plan: PortPlan,
  spec: AppSpec,
  behaviors: BehaviorSpec,
  run: Run,
): string[] {
  const errors: string[] = []
  const planned = new Set(plan.targets.map((t) => t.target))
  for (const t of run.targets) if (!planned.has(t)) errors.push(`no plan for target "${t}"`)
  for (const tp of plan.targets) {
    if (!run.targets.includes(tp.target))
      errors.push(`plan includes target "${tp.target}" that was not requested`)
    const mapped = new Set(tp.screenMap.map((m) => m.screen))
    for (const s of spec.screens)
      if (!mapped.has(s.id)) errors.push(`${tp.target}: screen "${s.id}" is not in screenMap`)
    for (const m of tp.screenMap) {
      if (!spec.screens.some((s) => s.id === m.screen)) {
        errors.push(`${tp.target}: screenMap references unknown screen "${m.screen}"`)
      }
    }
  }
  const must = behaviors.behaviors.filter((b) => b.priority === 'must').map((b) => b.id)
  const e2e = new Set(plan.testPlan.e2e)
  for (const id of must) if (!e2e.has(id)) errors.push(`must-behavior ${id} is not in testPlan.e2e`)
  for (const id of plan.testPlan.e2e) {
    if (!behaviors.behaviors.some((b) => b.id === id))
      errors.push(`testPlan.e2e references unknown behavior ${id}`)
  }
  if (run.options.coreMode === 'never' && plan.core.enabled)
    errors.push('core.enabled must be false when coreMode is never')
  if (run.options.coreMode === 'always' && !plan.core.enabled)
    errors.push('core.enabled must be true when coreMode is always')
  if (plan.core.enabled && plan.core.functions.length === 0)
    errors.push('core.enabled is true but no functions are listed')
  return errors
}
