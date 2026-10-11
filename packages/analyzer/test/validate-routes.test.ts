import { describe, expect, it } from 'vitest'
import type { AppSpec, BehaviorSpec } from '@mpf/core'
import { validateBehaviorRefs } from '../src/validate.ts'

const spec = {
  screens: [
    { id: 'home', route: '/', elements: [{ id: 'article-link' }] },
    { id: 'article', route: '/article/[slug]', elements: [{ id: 'article-title' }] },
  ],
} as unknown as AppSpec

const behavior = (id: string, screen: string, steps: unknown[]) =>
  ({ id, screen, steps }) as unknown as BehaviorSpec['behaviors'][number]

describe('validateBehaviorRefs with parameterized routes', () => {
  it('rejects a behavior that starts on, or navigates to, a screen whose route has a parameter', () => {
    const behaviors = {
      behaviors: [
        behavior('B-001', 'article', [{ op: 'expectVisible', element: 'article-title' }]),
        behavior('B-002', 'home', [
          { op: 'navigate', screen: 'article' },
          { op: 'expectVisible', element: 'article-title' },
        ]),
      ],
    } as unknown as BehaviorSpec
    const errors = validateBehaviorRefs(spec, behaviors)
    expect(
      errors.some((e) =>
        /B-001: starts on screen "article" whose route "\/article\/\[slug\]" has a parameter/.test(
          e,
        ),
      ),
    ).toBe(true)
    expect(
      errors.some((e) => /B-002 step 1: navigate to "article" whose route has a parameter/.test(e)),
    ).toBe(true)
  })

  it('accepts reaching such a screen through the UI', () => {
    const behaviors = {
      behaviors: [
        behavior('B-003', 'home', [
          { op: 'tap', element: 'article-link' },
          { op: 'expectVisible', element: 'article-title' },
        ]),
      ],
    } as unknown as BehaviorSpec
    // Other rules (a screen without behaviors) still apply; none of them is about the route.
    expect(validateBehaviorRefs(spec, behaviors).filter((e) => /parameter/.test(e))).toEqual([])
  })
})
