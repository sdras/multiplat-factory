import { describe, expect, it } from 'vitest'
import { RunOptions, type AppSpec, type BehaviorSpec, type PortPlan, type Run } from '@mpf/core'
import { coreCandidacy } from '../src/candidacy.ts'
import { pruneInvalidBehaviors, validateBehaviorRefs, validatePlan } from '../src/validate.ts'

const spec: AppSpec = {
  name: 'x',
  source: {
    platform: 'web',
    framework: 'static-html',
    language: 'javascript',
    entry: 'index.html',
  },
  screens: [
    {
      id: 'home',
      name: 'Home',
      route: '/',
      purpose: 'p',
      elements: [{ id: 'add', kind: 'button', label: 'Add', testId: 'add' }],
      navigatesTo: [],
    },
    {
      id: 'settings',
      name: 'Settings',
      route: '#/settings',
      purpose: 'p',
      elements: [],
      navigatesTo: [],
    },
  ],
  navigation: { style: 'routes', root: 'home', edges: [] },
  state: { entities: {}, storeStyle: 'module', persistence: [] },
  logic: [
    {
      id: 'l1',
      file: 'main.js',
      symbol: 'schedule',
      purity: 'pure',
      loc: 40,
      inputs: '',
      outputs: '',
      description: 'weekly schedule math',
      coreCandidate: true,
    },
    {
      id: 'l2',
      file: 'main.js',
      symbol: 'render',
      purity: 'ui',
      loc: 200,
      inputs: '',
      outputs: '',
      description: 'dom',
      coreCandidate: false,
    },
  ],
  integrations: [],
  assets: [],
  permissions: [],
  platformFeatures: [],
  unknowns: [],
}

const behaviors: BehaviorSpec = {
  behaviors: [
    {
      id: 'B-001',
      title: 't',
      screen: 'home',
      priority: 'must',
      category: 'state',
      steps: [{ op: 'tap', element: 'add' }],
      evidence: [],
      verifiedOnSource: false,
    },
    {
      id: 'B-002',
      title: 't',
      screen: 'settings',
      priority: 'should',
      category: 'nav',
      steps: [{ op: 'navigate', screen: 'home' }],
      evidence: [],
      verifiedOnSource: false,
    },
  ],
  invariants: [],
  seedData: {},
}

const run = (coreMode: 'auto' | 'always' | 'never' = 'auto'): Run => ({
  id: 'r',
  createdAt: 'x',
  updatedAt: 'x',
  status: 'running',
  source: { locator: '.' },
  targets: ['ios'],
  options: RunOptions.parse({ coreMode }),
  runDir: '/tmp',
  costUsd: 0,
})

describe('validateBehaviorRefs / prune', () => {
  it('accepts valid references', () => {
    expect(validateBehaviorRefs(spec, behaviors)).toEqual([])
  })
  it('reports a behavior whose first step touches an element of another screen', () => {
    const mismatched: BehaviorSpec = {
      ...behaviors,
      behaviors: [
        {
          ...behaviors.behaviors[0]!,
          screen: spec.screens[1]!.id,
          steps: [{ op: 'expectVisible', element: spec.screens[0]!.elements[0]!.id }],
        },
      ],
    }
    const errors = validateBehaviorRefs(spec, mismatched)
    expect(errors.some((e) => /starts on screen .* but its first step uses/.test(e))).toBe(true)
    const navigated: BehaviorSpec = {
      ...mismatched,
      behaviors: [
        {
          ...mismatched.behaviors[0]!,
          steps: [
            { op: 'navigate', screen: spec.screens[0]!.id },
            ...mismatched.behaviors[0]!.steps,
          ],
        },
      ],
    }
    expect(validateBehaviorRefs(spec, navigated).some((e) => /first step uses/.test(e))).toBe(false)
  })

  it('reports unknown ids, duplicates, and uncovered screens', () => {
    const bad: BehaviorSpec = {
      ...behaviors,
      behaviors: [
        { ...behaviors.behaviors[0]!, steps: [{ op: 'tap', element: 'nope' }] },
        { ...behaviors.behaviors[0]!, id: 'B-001', screen: 'ghost' },
      ],
    }
    const errors = validateBehaviorRefs(spec, bad)
    expect(errors.join('\n')).toMatch(/unknown element "nope"/)
    expect(errors.join('\n')).toMatch(/duplicate id/)
    expect(errors.join('\n')).toMatch(/unknown screen "ghost"/)
    expect(errors.join('\n')).toMatch(/screen "settings" has no behaviors/)
    const { kept, dropped } = pruneInvalidBehaviors(spec, bad)
    expect(kept.behaviors).toHaveLength(0)
    expect(dropped).toHaveLength(2)
  })
})

describe('coreCandidacy', () => {
  it('enables a core for valuable pure logic and honors overrides', () => {
    expect(coreCandidacy(spec, 'auto').enabled).toBe(true)
    expect(coreCandidacy(spec, 'never').enabled).toBe(false)
    expect(coreCandidacy({ ...spec, logic: [] }, 'always').enabled).toBe(true)
    expect(
      coreCandidacy(
        { ...spec, logic: [{ ...spec.logic[0]!, description: 'tiny helper', loc: 10 }] },
        'auto',
      ).enabled,
    ).toBe(false)
  })
})

describe('validatePlan', () => {
  const plan: PortPlan = {
    targets: [
      {
        target: 'ios',
        uiFramework: 'SwiftUI',
        layout: 'x',
        stateStrategy: 's',
        screenMap: [
          { screen: 'home', file: 'Home.swift' },
          { screen: 'settings', file: 'Settings.swift' },
        ],
        persistenceMap: [],
        integrationMap: [],
        deviations: [],
      },
    ],
    core: {
      enabled: true,
      rationale: 'r',
      functions: [
        {
          name: 'schedule',
          description: 'd',
          inputSchema: {},
          outputSchema: {},
          sourceSymbols: ['schedule'],
        },
      ],
    },
    testPlan: { unit: [], e2e: ['B-001'], parity: ['schedule'] },
    estimate: { stages: 10, costUsd: 5, minutes: 30 },
    questionsForHuman: [],
  }
  it('passes a complete plan', () => {
    expect(validatePlan(plan, spec, behaviors, run())).toEqual([])
  })
  it('flags missing targets, screens, must-behaviors, and core inconsistencies', () => {
    const errors = validatePlan(
      {
        ...plan,
        targets: [{ ...plan.targets[0]!, target: 'android', screenMap: [] }],
        testPlan: { unit: [], e2e: [], parity: [] },
      },
      spec,
      behaviors,
      run('never'),
    )
    const text = errors.join('\n')
    expect(text).toMatch(/no plan for target "ios"/)
    expect(text).toMatch(/not requested/)
    expect(text).toMatch(/screen "home" is not in screenMap/)
    expect(text).toMatch(/must-behavior B-001/)
    expect(text).toMatch(/core.enabled must be false/)
  })
})
