import { describe, expect, it } from 'vitest'
import type { AppSpec, Detection, Inventory } from '@mpf/core'
import {
  BEHAVIORS_SYSTEM,
  SPEC_SYSTEM,
  specPrompt,
  testIdRepairPrompt,
  unmatchedTestIds,
} from '../src/prompts.ts'

describe('behaviors prompt', () => {
  it('tells the worker to qualify a tap on a shared row hook by text instead of a custom step', () => {
    expect(BEHAVIORS_SYSTEM).toContain('give `tap` a `text`')
    expect(BEHAVIORS_SYSTEM).toContain('never write a custom step for a tap')
  })
})

const detection: Detection = {
  adapterId: 'web-vite',
  platform: 'web',
  framework: 'vue',
  language: 'javascript',
  entry: 'index.html',
  score: 1,
  evidence: [],
  supported: true,
}

const inventory = (testHooks: string[]): Inventory => ({
  root: '/src',
  files: [],
  totals: { files: 0, loc: 0, byLanguage: {}, byRole: {} },
  hints: {
    framework: 'vue',
    entryFiles: [],
    routeHints: [],
    stateHints: [],
    persistenceHints: [],
    integrationHints: [],
    testHooks,
    notes: [],
  },
  skipped: [],
})

/** A TodoMVC-like spec: one element reuses a source hook, one maps itself with a selector, one does neither. */
const spec: AppSpec = {
  name: 'Todos',
  source: { platform: 'web', framework: 'vue', language: 'javascript', entry: 'index.html' },
  screens: [
    {
      id: 'todos',
      name: 'Todos',
      route: '#/',
      purpose: 'p',
      elements: [
        { id: 'toggle-all', kind: 'toggle', label: 'Mark all as complete', testId: 'toggle-all' },
        {
          id: 'new-todo',
          kind: 'input',
          label: 'What needs to be done?',
          testId: 'new-todo',
          sourceSelector: '.new-todo',
        },
        { id: 'clear-completed', kind: 'button', label: 'Clear completed', testId: 'clear-done' },
      ],
      navigatesTo: [],
    },
  ],
  navigation: { style: 'routes', root: 'todos', edges: [] },
  state: { entities: {}, storeStyle: 'x', persistence: [] },
  logic: [],
  integrations: [],
  assets: [],
  permissions: [],
  platformFeatures: [],
  unknowns: [],
}

describe('spec prompt', () => {
  it('asks for a sourceSelector next to the testId when the source has no hook for an element', () => {
    expect(SPEC_SYSTEM).toContain('set `sourceSelector`')
    expect(SPEC_SYSTEM).toContain('never a generated or positional selector')
    expect(SPEC_SYSTEM).toContain('still give it a stable testId')
  })

  it('tells the worker about the hooks it found, or that every element needs a selector', () => {
    const hooked = specPrompt(detection, inventory(['toggle-all']), [])
    expect(hooked).toContain('Test hooks already in the source')
    expect(hooked).toContain('toggle-all')
    expect(hooked).toContain('give that element a sourceSelector')
    const hookless = specPrompt(detection, inventory([]), [])
    expect(hookless).toContain('found no test hooks')
    expect(hookless).toContain('every element needs a sourceSelector')
    expect(hookless).not.toContain('Test hooks already in the source')
  })

  it('reports only elements with neither a source hook nor a sourceSelector as unmatched', () => {
    expect(unmatchedTestIds(spec, ['toggle-all'])).toEqual([
      { screen: 'todos', element: 'clear-completed', testId: 'clear-done' },
    ])
    // A hookless source still gets its repair round: the selector is the mapping.
    expect(unmatchedTestIds(spec, []).map((u) => u.element)).toEqual([
      'toggle-all',
      'clear-completed',
    ])
    const blank: AppSpec = {
      ...spec,
      screens: [
        {
          ...spec.screens[0]!,
          elements: [{ ...spec.screens[0]!.elements[1]!, sourceSelector: '  ' }],
        },
      ],
    }
    expect(unmatchedTestIds(blank, [])).toHaveLength(1)
  })

  it('asks the repair round for a hook or a selector, and says when the source has no hooks', () => {
    const unmatched = unmatchedTestIds(spec, ['toggle-all'])
    const withHooks = testIdRepairPrompt(unmatched, ['toggle-all'])
    expect(withHooks).toContain('set sourceSelector')
    expect(withHooks).toContain('element clear-completed: testId "clear-done"')
    expect(withHooks).toContain('Hooks present in the source: toggle-all')
    const hookless = testIdRepairPrompt(unmatchedTestIds(spec, []), [])
    expect(hookless).toContain('no test hooks at all')
    expect(hookless).not.toContain('Hooks present in the source')
  })
})
