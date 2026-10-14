import { describe, expect, it } from 'vitest'
import type { AppSpec, Behavior } from '@mpf/core'
import {
  androidFiles,
  gradleProjectName,
  packageNameFor,
  screenClassName,
} from '../src/target/android/template.ts'
import { iosFiles } from '../src/target/ios/template.ts'
import { parseGradleOutput } from '../src/target/gradle.ts'
import { parseJUnitXml } from '../src/target/junit.ts'
import {
  compileMaestroFlow,
  hookMatcher,
  inputLines,
  navigationPath,
  rowPrefix,
  triggerElement,
} from '../src/target/maestro.ts'
import { startScreenOf } from '../src/target/start-screen.ts'

const spec: AppSpec = {
  name: 'Counter',
  source: {
    platform: 'web',
    framework: 'static-html',
    language: 'javascript',
    entry: 'index.html',
  },
  screens: [
    {
      id: 'counter',
      name: 'Counter',
      route: '#/',
      purpose: 'p',
      elements: [
        { id: 'count-value', kind: 'text', label: 'Count', testId: 'count-value' },
        { id: 'increment', kind: 'button', label: '+', testId: 'increment' },
      ],
      navigatesTo: ['settings'],
    },
    {
      id: 'settings',
      name: 'Settings',
      route: '#/settings',
      purpose: 'p',
      elements: [
        { id: 'step-input', kind: 'input', label: 'Step', testId: 'step-input' },
        { id: 'save-step', kind: 'button', label: 'Save', testId: 'save-step' },
      ],
      navigatesTo: [],
    },
  ],
  navigation: { style: 'routes', root: 'counter', edges: [] },
  state: { entities: {}, storeStyle: 'x', persistence: [] },
  logic: [],
  integrations: [],
  assets: [],
  permissions: [],
  platformFeatures: [],
  unknowns: [],
}

describe('android template', () => {
  it('derives package and class names safely', () => {
    expect(packageNameFor('My Cool App!')).toBe('app.mpf.mycoolapp')
    expect(packageNameFor('123')).toBe('app.mpf.ported')
    const taken = new Set<string>()
    expect(screenClassName('counter', taken)).toBe('Counter')
    expect(screenClassName('counter', taken)).toBe('Counter2')
    expect(screenClassName('2fa-setup', taken)).toBe('Screen2faSetup')
  })

  it('writes a complete Compose project with routes, deep links, tags, and the store', () => {
    const files = androidFiles({
      packageName: 'app.mpf.counter',
      appName: 'Counter',
      minSdk: 26,
      compileSdk: 36,
      screens: [
        { id: 'counter', name: 'Counter' },
        { id: 'settings', name: 'Settings' },
      ],
      rootScreen: 'counter',
    })
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'settings.gradle.kts',
        'app/build.gradle.kts',
        'app/src/main/AndroidManifest.xml',
        'app/src/main/kotlin/app/mpf/counter/ui/AppNav.kt',
        'app/src/main/kotlin/app/mpf/counter/data/AppStore.kt',
        'MPF.md',
      ]),
    )
    const nav = files['app/src/main/kotlin/app/mpf/counter/ui/AppNav.kt']!
    expect(nav).toContain('uriPattern = "mpf://app.mpf.counter/settings"')
    expect(nav).toContain('const val ROOT = COUNTER')
    expect(files['app/src/main/AndroidManifest.xml']).toContain(
      'android:scheme="mpf" android:host="app.mpf.counter"',
    )
    expect(files['app/src/main/kotlin/app/mpf/counter/ui/AppRoot.kt']).toContain(
      'testTagsAsResourceId = true',
    )
    expect(files['app/src/main/kotlin/app/mpf/counter/data/AppStore.kt']).toContain(
      'SEED_EXTRA = "mpf_seed"',
    )
    expect(files['app/build.gradle.kts']).toContain('compileSdk = 36')
    expect(files['MPF.md']).toContain('icon-only control')
    expect(files['MPF.md']).toContain('contentDescription')
    // Seeds are written before the first frame, because a flow may stop the app right after it.
    expect(files['MPF.md']).toContain('persisted before the first frame')
    const main = files['app/src/main/kotlin/app/mpf/counter/MainActivity.kt']!
    expect(main).toContain('seedBlocking')
    expect(main.indexOf('applySeed(intent)')).toBeLessThan(main.indexOf('setContent {'))
  })
})

describe('ios template conventions', () => {
  it('asks for an accessibilityLabel on every icon-only control', () => {
    const files = iosFiles({
      name: 'Counter',
      appName: 'Counter',
      bundleId: 'app.mpf.counter',
      screens: [{ id: 'counter', name: 'Counter' }],
      rootScreen: 'counter',
    })
    expect(files['MPF.md']).toContain('icon-only control')
    expect(files['MPF.md']).toContain('accessibilityLabel')
  })

  it('writes seeds through before the first frame', () => {
    const files = iosFiles({
      name: 'Counter',
      appName: 'Counter',
      bundleId: 'app.mpf.counter',
      screens: [{ id: 'counter', name: 'Counter' }],
      rootScreen: 'counter',
    })
    expect(files['App/Data/AppStore.swift']).toContain('defaults.synchronize()')
    expect(files['MPF.md']).toContain('persisted before the first frame')
  })
})

describe('compileMaestroFlow', () => {
  const opts = {
    appId: 'app.mpf.counter',
    deepLinkBase: 'mpf://app.mpf.counter',
    seedArgument: 'mpf_seed',
  }
  it('maps typed steps to Maestro commands keyed by testId', () => {
    const b: Behavior = {
      id: 'B-004',
      title: 'Save step',
      screen: 'settings',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: true,
      steps: [
        { op: 'type', element: 'step-input', text: '5' },
        { op: 'tap', element: 'save-step' },
        { op: 'navigate', screen: 'counter' },
        { op: 'tap', element: 'increment' },
        { op: 'expectText', element: 'count-value', text: '5', exact: true },
        { op: 'restart' },
        { op: 'expectText', element: 'count-value', text: '5', exact: false },
      ],
    }
    const { yaml, unverifiable } = compileMaestroFlow(spec, b, opts)
    expect(unverifiable).toBeUndefined()
    expect(yaml).toContain('appId: app.mpf.counter')
    expect(yaml).toContain('- openLink: mpf://app.mpf.counter/settings')
    expect(yaml).toContain('inputText: "5"')
    expect(yaml).toContain('id: "save-step"')
    expect(yaml).toContain('- hideKeyboard:\n    optional: true')
    expect(yaml).toContain('- openLink: mpf://app.mpf.counter/counter')
    expect(yaml).toContain('text: "5"')
    expect(yaml).toContain('text: ".*5.*"')
    expect(yaml).toContain('- stopApp')
  })
  it('checks a count on rows that share one id with the index selector', () => {
    const b: Behavior = {
      id: 'B-015',
      title: 'count',
      screen: 'counter',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [{ op: 'expectCount', element: 'count-value', count: 3 }],
    }
    const { yaml, unverifiable } = compileMaestroFlow(spec, b, opts)
    expect(unverifiable).toBeUndefined()
    expect(yaml).toContain('- assertVisible:\n    id: "count-value"\n    index: 2')
    expect(yaml).toContain('- assertNotVisible:\n    id: "count-value"\n    index: 3')
    const zero = compileMaestroFlow(
      spec,
      { ...b, steps: [{ op: 'expectCount', element: 'count-value', count: 0 }] },
      opts,
    )
    expect(zero.yaml).not.toContain('- assertVisible:\n    id: "count-value"')
    expect(zero.yaml).toContain('- assertNotVisible:\n    id: "count-value"\n    index: 0')
    // A source app whose rows carry no hook has nothing to select by.
    const source = compileMaestroFlow(spec, b, { ...opts, navigation: 'none', sourceHooks: [] })
    expect(source.unverifiable).toContain('rows carry no hook')
    // Ten rows do not fit a phone and a lazy list composes only what is on screen.
    const long = compileMaestroFlow(
      spec,
      { ...b, steps: [{ op: 'expectCount', element: 'count-value', count: 10 }] },
      opts,
    )
    expect(long.unverifiable).toMatch(/larger counts cannot be checked/)
    expect(long.yaml).not.toContain('index: 9')
  })
  it('replaces {{unique}} with the same fresh token across a flow', () => {
    const b: Behavior = {
      id: 'B-017',
      title: 'sign up',
      screen: 'settings',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [
        { op: 'type', element: 'step-input', text: 'user-{{unique}}@example.com' },
        {
          op: 'expectText',
          element: 'count-value',
          text: 'user-{{unique}}@example.com',
          exact: true,
        },
      ],
    }
    const { yaml } = compileMaestroFlow(spec, b, opts)
    expect(yaml).not.toContain('{{unique}}')
    const tokens = [...yaml.matchAll(/user-([a-z0-9]+)@example\.com/g)].map((m) => m[1])
    expect(tokens.length).toBeGreaterThanOrEqual(2)
    expect(new Set(tokens).size).toBe(1)
    // A second compile gets a different identity.
    expect(compileMaestroFlow(spec, b, opts).yaml).not.toContain(`user-${tokens[0]}@`)
  })

  it('waits for an element without touching the screen before it scrolls for it', () => {
    const b: Behavior = {
      id: 'B-018',
      title: 'snackbar',
      screen: 'counter',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [
        { op: 'expectVisible', element: 'count-value' },
        { op: 'expectText', element: 'count-value', text: 'Saved', exact: false },
      ],
    }
    const { yaml } = compileMaestroFlow(spec, b, opts)
    // A swipe dismisses a snackbar, so the no-touch wait comes first and the scroll only after.
    const wait = yaml.indexOf(
      '- extendedWaitUntil:\n    visible:\n      id: "count-value"\n    timeout',
    )
    const scroll = yaml.indexOf('- scrollUntilVisible:\n    element:\n      id: "count-value"')
    expect(wait).toBeGreaterThan(-1)
    expect(wait).toBeLessThan(scroll)
    const textWait = yaml.indexOf('text: ".*Saved.*"\n    timeout')
    const textScroll = yaml.indexOf('- scrollUntilVisible:', textWait)
    expect(textWait).toBeGreaterThan(-1)
    expect(textScroll).toBeGreaterThan(textWait)
  })

  it('dismisses the keyboard on Android only while an input method is on screen', () => {
    const b: Behavior = {
      id: 'B-016',
      title: 'type',
      screen: 'settings',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [{ op: 'type', element: 'step-input', text: 'Buy milk\n' }],
    }
    const android = compileMaestroFlow(spec, b, { ...opts, platform: 'android' }).yaml
    expect(android).toContain('- pressKey: Enter')
    // Maestro's Android hideKeyboard is a BACK key: never send it into an app whose keyboard is closed.
    expect(android).toContain(
      '- runFlow:\n    when:\n      visible:\n        id: ".*inputmethod.*"\n    commands:\n      - hideKeyboard',
    )
    expect(android).not.toContain('- hideKeyboard:\n    optional: true')
    const ios = compileMaestroFlow(spec, b, { ...opts, platform: 'ios' }).yaml
    expect(ios).toContain('- hideKeyboard:\n    optional: true')
  })
  it('maps doubleTap and longPress to the Maestro gestures, on a target and on a source app', () => {
    const b: Behavior = {
      id: 'B-014',
      title: 'gestures',
      screen: 'counter',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [
        { op: 'doubleTap', element: 'increment' },
        { op: 'longPress', element: 'count-value', text: '5' },
      ],
    }
    const { yaml } = compileMaestroFlow(spec, b, opts)
    expect(yaml).toContain('- doubleTapOn:\n    id: "increment"')
    expect(yaml).toContain('- longPressOn:\n          id: "count-value"\n          text: ".*5.*"')
    const source = compileMaestroFlow(spec, b, { ...opts, navigation: 'none', sourceHooks: [] })
    expect(source.unverifiable).toBeUndefined()
    expect(source.yaml).toContain('- doubleTapOn:\n    text: "(?i)')
    expect(source.yaml).toContain('- longPressOn:\n    text: "(?i).*5.*"')
  })
  it('accepts a label on the tagged node or on one of its descendants', () => {
    const b: Behavior = {
      id: 'B-005',
      title: 'x',
      screen: 'counter',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [{ op: 'expectText', element: 'increment', text: '+1', exact: true }],
    }
    const { yaml } = compileMaestroFlow(spec, b, opts)
    const direct = yaml.indexOf(
      '- extendedWaitUntil:\n    visible:\n      id: "increment"\n      text: "+1"\n    timeout: 4000\n    optional: true',
    )
    // Probe-then-assert: which shape is on screen is recorded first, and the one real assertion
    // runs only when neither was. Never `when: notVisible`, which waits for a transient element to
    // vanish and then fails on it.
    const probeText = yaml.indexOf(
      '- runFlow:\n    when:\n      true: "${output.mpfText == \'\'}"\n      visible:\n        id: "increment"\n        text: "+1"\n    commands:\n      - evalScript: ${output.mpfText = \'text\'}',
    )
    const probeDescendant = yaml.indexOf(
      '      visible:\n        id: "increment"\n        containsDescendants:\n          - text: "+1"\n    commands:\n      - evalScript: ${output.mpfText = \'descendant\'}',
    )
    const fallback = yaml.indexOf(
      '- runFlow:\n    when:\n      true: "${output.mpfText == \'\'}"\n    commands:\n      - assertVisible:\n          id: "increment"\n          containsDescendants:\n            - text: "+1"',
    )
    expect(direct).toBeGreaterThan(0)
    expect(probeText).toBeGreaterThan(direct)
    expect(probeDescendant).toBeGreaterThan(probeText)
    expect(fallback).toBeGreaterThan(probeDescendant)
    expect(yaml).not.toContain('notVisible')
  })
  it('collapses repeated opens of the same screen', () => {
    const b: Behavior = {
      id: 'B-003',
      title: 'x',
      screen: 'counter',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [
        { op: 'seed', state: {} },
        { op: 'restart' },
        { op: 'navigate', screen: 'counter' },
        { op: 'expectVisible', element: 'count-value' },
      ],
    }
    const { yaml } = compileMaestroFlow(spec, b, opts)
    expect(yaml.match(/openLink: mpf:\/\/app\.mpf\.counter\/counter/g)?.length).toBe(2)
  })

  it('seeds through launch arguments and flags what it cannot express', () => {
    const b: Behavior = {
      id: 'B-009',
      title: 'x',
      screen: 'counter',
      priority: 'should',
      category: 'logic',
      evidence: [],
      verifiedOnSource: false,
      steps: [
        { op: 'seed', state: { 'counter.state': { count: 3, step: 1 } } },
        { op: 'expectCount', element: 'increment', count: 1 },
        { op: 'custom', description: 'check colors' },
      ],
    }
    const { yaml, unverifiable } = compileMaestroFlow(spec, b, opts)
    expect(yaml).toContain('mpf_seed: "{\\"counter.state\\":{\\"count\\":3,\\"step\\":1}}"')
    // The count on a shared id compiles with the index selector; only the custom step is a hole.
    expect(unverifiable).not.toMatch(/expectCount/)
    expect(yaml).toContain('- assertVisible:\n    id: "increment"\n    index: 0')
    expect(unverifiable).toMatch(/custom step/)
  })
  it('navigates by relaunching with a route argument when asked (iOS)', () => {
    const b: Behavior = {
      id: 'B-002',
      title: 'x',
      screen: 'settings',
      priority: 'must',
      category: 'nav',
      evidence: [],
      verifiedOnSource: false,
      steps: [
        { op: 'tap', element: 'save-step' },
        { op: 'navigate', screen: 'counter' },
        { op: 'restart' },
        { op: 'expectVisible', element: 'count-value' },
      ],
    }
    const { yaml } = compileMaestroFlow(spec, b, {
      ...opts,
      navigation: 'launch-argument',
      routeArgument: 'mpf_route',
    })
    expect(yaml).not.toContain('openLink')
    expect(yaml).toContain('clearState: true')
    expect(yaml).toContain('mpf_route: "settings"')
    expect(yaml).toContain('mpf_route: "counter"')
    expect(yaml).toContain('- stopApp')
  })

  it('opens raw routes for fallback behaviors, by deep link or launch argument', () => {
    const b: Behavior = {
      id: 'B-019',
      title: 'x',
      screen: 'counter',
      priority: 'should',
      category: 'nav',
      evidence: [],
      verifiedOnSource: false,
      steps: [
        { op: 'openRoute', route: 'nope' },
        { op: 'expectVisible', element: 'count-value' },
      ],
    }
    expect(compileMaestroFlow(spec, b, opts).yaml).toContain(
      '- openLink: mpf://app.mpf.counter/nope',
    )
    expect(compileMaestroFlow(spec, b, { ...opts, navigation: 'launch-argument' }).yaml).toContain(
      'mpf_route: "nope"',
    )
  })

  it('turns templated ids for repeated rows into prefix matches', () => {
    const rowSpec: AppSpec = {
      ...spec,
      screens: [
        {
          ...spec.screens[0]!,
          elements: [
            ...spec.screens[0]!.elements,
            { id: 'line-total', kind: 'text', label: 'Line total', testId: 'line-total-<SKU>' },
          ],
        },
      ],
    }
    const b: Behavior = {
      id: 'B-030',
      title: 'x',
      screen: 'counter',
      priority: 'must',
      category: 'display',
      evidence: [],
      verifiedOnSource: false,
      steps: [{ op: 'expectText', element: 'line-total', text: '$14.00', exact: true }],
    }
    expect(compileMaestroFlow(rowSpec, b, opts).yaml).toContain('id: "line-total-.*"')
  })

  it('scrolls targets into view and chooses picker options by text', () => {
    const pickerSpec: AppSpec = {
      ...spec,
      screens: [
        {
          ...spec.screens[1]!,
          elements: [
            ...spec.screens[1]!.elements,
            { id: 'region', kind: 'picker', label: 'Region', testId: 'region-select' },
          ],
        },
        spec.screens[0]!,
      ],
    }
    const b: Behavior = {
      id: 'B-031',
      title: 'x',
      screen: 'settings',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [
        { op: 'type', element: 'region', text: 'EU' },
        { op: 'tap', element: 'save-step' },
      ],
    }
    const { yaml } = compileMaestroFlow(pickerSpec, b, opts)
    expect(yaml).toContain(
      '- scrollUntilVisible:\n    element:\n      id: "region-select"\n    direction: DOWN\n    timeout: 4000\n    optional: true',
    )
    expect(yaml).toContain('- tapOn:\n    id: "region-select"\n- tapOn:\n    text: "(?i).*EU.*"')
    expect(yaml).not.toContain('inputText: "EU"')
  })

  it('compiles source-app flows with a clean launch only, and refuses what a source cannot do', () => {
    const src = {
      appId: 'com.example.counter',
      deepLinkBase: '',
      seedArgument: '',
      navigation: 'none' as const,
      screenshotPath: 'B-001',
    }
    const ok: Behavior = {
      id: 'B-001',
      title: 'x',
      screen: 'counter',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [
        { op: 'tap', element: 'increment' },
        { op: 'restart' },
        { op: 'expectText', element: 'count-value', text: '1', exact: true },
      ],
    }
    const yaml = compileMaestroFlow(spec, ok, src).yaml
    expect(yaml).toContain('- launchApp:\n    clearState: true')
    expect(yaml).not.toContain('openLink')
    expect(yaml).toContain('- stopApp\n- launchApp:\n    clearState: false')
    expect(yaml).toContain('- takeScreenshot: "B-001"')
    const emptySeed: Behavior = {
      ...ok,
      id: 'B-002',
      steps: [
        { op: 'seed', state: {} },
        { op: 'tap', element: 'increment' },
      ],
    }
    expect(compileMaestroFlow(spec, emptySeed, src).unverifiable).toBeUndefined()
    const realSeed: Behavior = {
      ...ok,
      id: 'B-004',
      steps: [
        { op: 'seed', state: { 'counter.state': { count: 3 } } },
        { op: 'tap', element: 'increment' },
      ],
    }
    expect(compileMaestroFlow(spec, realSeed, src)).toMatchObject({
      yaml: '',
      unverifiable: expect.stringMatching(/seed/),
    })
    // Screens off the root are reached by tapping the navigation edges; unknown ones stay unverifiable.
    const edged: AppSpec = {
      ...spec,
      screens: [
        {
          ...spec.screens[0]!,
          elements: [
            ...spec.screens[0]!.elements,
            { id: 'nav-settings', kind: 'link', label: 'Settings', testId: 'nav-settings' },
          ],
        },
        spec.screens[1]!,
      ],
      navigation: {
        style: 'routes',
        root: 'counter',
        edges: [{ from: 'counter', to: 'settings', trigger: 'nav-settings' }],
      },
    }
    const elsewhere: Behavior = {
      ...ok,
      id: 'B-003',
      screen: 'settings',
      steps: [
        { op: 'tap', element: 'save-step' },
        { op: 'restart' },
        { op: 'expectVisible', element: 'step-input' },
      ],
    }
    const walked = compileMaestroFlow(edged, elsewhere, src).yaml
    expect(walked).toContain('- launchApp:\n    clearState: true')
    expect(walked.indexOf('id: "nav-settings"')).toBeLessThan(walked.indexOf('id: "save-step"'))
    expect(walked.split('id: "nav-settings"').length - 1).toBe(4) // reveal + tap, before and after the restart
    expect(compileMaestroFlow(spec, elsewhere, src).unverifiable).toMatch(/no navigation path/)
    expect(navigationPath(edged, 'counter', 'settings')).toEqual(['nav-settings'])
    expect(navigationPath(edged, 'settings', 'counter')).toBeUndefined()
  })

  it('compiles a select step as open-then-pick', () => {
    const pickerSpec: AppSpec = {
      ...spec,
      screens: [
        {
          ...spec.screens[1]!,
          elements: [
            ...spec.screens[1]!.elements,
            { id: 'region', kind: 'picker', label: 'Region', testId: 'region-select' },
          ],
        },
        spec.screens[0]!,
      ],
    }
    const b: Behavior = {
      id: 'B-032',
      title: 'x',
      screen: 'settings',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [{ op: 'select', element: 'region', option: 'European Union' }],
    }
    expect(compileMaestroFlow(pickerSpec, b, opts).yaml).toContain(
      '- tapOn:\n    id: "region-select"\n- tapOn:\n    text: "(?i).*European Union.*"',
    )
  })

  it('throws on unknown elements so the caller can mark the flow unverifiable', () => {
    const b: Behavior = {
      id: 'B-001',
      title: 'x',
      screen: 'counter',
      priority: 'must',
      category: 'nav',
      evidence: [],
      verifiedOnSource: false,
      steps: [{ op: 'tap', element: 'ghost' }],
    }
    expect(() => compileMaestroFlow(spec, b, opts)).toThrow(/unknown element ghost/)
  })
})

describe('parseGradleOutput', () => {
  it('extracts Kotlin, Java, and resource diagnostics plus the what-went-wrong block', () => {
    const out = `> Task :app:compileDebugKotlin FAILED
e: file:///work/ws/android/app/src/main/kotlin/app/mpf/x/Main.kt:12:5 Unresolved reference: foo
w: file:///work/ws/android/app/src/main/kotlin/app/mpf/x/Main.kt:3:1 Unused import
/work/ws/android/app/src/main/java/app/mpf/x/Legacy.java:7: error: cannot find symbol
ERROR: /work/ws/android/app/src/main/res/values/strings.xml:4:5-20: Attribute is missing
FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> Compilation error. See log for more details

* Try:
> Run with --stacktrace`
    const d = parseGradleOutput(out, '/work/ws/android')
    expect(d.find((x) => x.tool === 'kotlinc' && x.severity === 'error')).toMatchObject({
      file: 'app/src/main/kotlin/app/mpf/x/Main.kt',
      line: 12,
      column: 5,
      message: 'Unresolved reference: foo',
    })
    expect(d.find((x) => x.tool === 'javac')).toMatchObject({ line: 7 })
    expect(d.find((x) => x.tool === 'aapt')).toMatchObject({
      file: 'app/src/main/res/values/strings.xml',
      line: 4,
    })
    expect(d.some((x) => x.tool === 'gradle' && /Compilation error/.test(x.message))).toBe(true)
  })
})

describe('parseJUnitXml', () => {
  it('reads cases, failures, and skips', () => {
    const xml = `<testsuite name="s" tests="3"><testcase name="a" classname="C" time="0.01"/><testcase name="b" classname="C" time="0.5"><failure message="expected 1 but was 2">stack</failure></testcase><testcase name="c" classname="C"><skipped/></testcase></testsuite>`
    const r = parseJUnitXml([xml], 'unit')
    expect(r.status).toBe('fail')
    expect(r.summary).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1, flaky: 0 })
    expect(r.cases[1]).toMatchObject({
      id: 'C.b',
      status: 'fail',
      message: 'expected 1 but was 2',
      durationMs: 500,
    })
  })
  it('reports an empty report as skipped with a reason', () => {
    expect(parseJUnitXml([], 'e2e').skipReason).toMatch(/no report/)
  })
})

describe('source-app flows on an app with its own hooks', () => {
  const notes: AppSpec = {
    ...spec,
    screens: [
      {
        ...spec.screens[0]!,
        id: 'list',
        name: 'List',
        elements: [
          { id: 'list-title', kind: 'text', label: 'Notes', testId: 'list-title' },
          { id: 'add-note', kind: 'button', label: 'Add', testId: 'add-note' },
          { id: 'note-row-0', kind: 'link', label: 'Note row', testId: 'note-row-0' },
          { id: 'search', kind: 'input', label: 'Search', testId: 'search-notes' },
        ],
        navigatesTo: ['editor'],
      },
      {
        ...spec.screens[1]!,
        id: 'editor',
        name: 'Editor',
        elements: [
          { id: 'editor-title', kind: 'text', label: 'New note', testId: 'editor-title' },
          { id: 'note-title', kind: 'input', label: 'Title', testId: 'note-title' },
          { id: 'save-note', kind: 'button', label: 'Save', testId: 'save-note' },
        ],
        navigatesTo: ['list'],
      },
    ],
    navigation: {
      style: 'routes',
      root: 'list',
      edges: [
        {
          from: 'list',
          to: 'editor',
          trigger: 'Tap the `add-note` (+) bar button — pushes the editor',
        },
        { from: 'editor', to: 'list', trigger: 'Tap `save-note` — pops back' },
      ],
    },
  }
  const elements = new Map(notes.screens.flatMap((s) => s.elements.map((e) => [e.id, e] as const)))
  const src = {
    appId: 'dev.example.notes',
    deepLinkBase: '',
    seedArgument: '',
    navigation: 'none' as const,
    sourceHooks: [
      'add-note',
      'note-row-<indexPath.row>',
      'note-title',
      'save-note',
      'search-notes',
    ],
  }
  const base: Behavior = {
    id: 'B-001',
    title: 'x',
    screen: 'editor',
    priority: 'must',
    category: 'state',
    evidence: [],
    verifiedOnSource: false,
    steps: [],
  }

  it('resolves prose edge triggers to the element they name', () => {
    expect(triggerElement(notes, elements, 'list', 'Tap the `add-note` (+) bar button')).toBe(
      'add-note',
    )
    expect(triggerElement(notes, elements, 'list', 'add-note')).toBe('add-note')
    expect(triggerElement(notes, elements, 'list', 'swipe from the left edge')).toBeUndefined()
  })

  it('matches templated hooks and ignores ids the source never sets', () => {
    const hooked = hookMatcher(src.sourceHooks)
    expect(hooked('note-row-0')).toBe(true)
    expect(hooked('note-row-<index>')).toBe(true)
    expect(hooked('add-note')).toBe(true)
    expect(hooked('list-title')).toBe(false)
  })

  it('starts where a leading navigate says, taps by hook, and asserts un-hooked text by text alone', () => {
    const b: Behavior = {
      ...base,
      steps: [
        { op: 'navigate', screen: 'list' },
        { op: 'tap', element: 'add-note' },
        { op: 'expectText', element: 'editor-title', text: 'New note', exact: true },
        { op: 'expectVisible', element: 'note-title' },
        { op: 'tap', element: 'save-note' },
        { op: 'expectText', element: 'list-title', text: 'Notes', exact: true },
      ],
    }
    const { yaml, unverifiable } = compileMaestroFlow(notes, b, src)
    expect(unverifiable).toBeUndefined()
    expect(yaml.split('- tapOn:').length - 1).toBe(2)
    expect(yaml).toContain('- assertVisible:\n    text: "New note"')
    expect(yaml).not.toContain('id: "editor-title"')
    expect(yaml).toContain('- assertVisible:\n    id: "note-title"')
  })

  it('walks to the behavior screen through a prose edge when no navigate step leads', () => {
    const b: Behavior = { ...base, steps: [{ op: 'type', element: 'note-title', text: 'Milk' }] }
    const { yaml, unverifiable } = compileMaestroFlow(notes, b, src)
    expect(unverifiable).toBeUndefined()
    expect(yaml.indexOf('id: "add-note"')).toBeLessThan(yaml.indexOf('id: "note-title"'))
  })

  it('follows taps that trigger edges and returns through the back edge with the platform affordance', () => {
    const withBack: AppSpec = {
      ...notes,
      screens: [
        notes.screens[0]!,
        {
          ...notes.screens[1]!,
          elements: [
            ...notes.screens[1]!.elements,
            { id: 'editor-back', kind: 'button', label: 'Notes', testId: 'editor-back' },
          ],
        },
      ],
      navigation: {
        ...notes.navigation,
        edges: [
          ...notes.navigation.edges,
          {
            from: 'editor',
            to: 'list',
            trigger: 'Tap the navigation back button — discards edits',
          },
        ],
      },
    }
    const b: Behavior = {
      ...base,
      screen: 'list',
      steps: [
        { op: 'navigate', screen: 'list' },
        { op: 'tap', element: 'add-note' },
        { op: 'type', element: 'note-title', text: 'Draft' },
        { op: 'navigate', screen: 'list' },
        { op: 'expectVisible', element: 'add-note' },
      ],
    }
    const ios = compileMaestroFlow(withBack, b, { ...src, platform: 'ios' })
    expect(ios.unverifiable).toBeUndefined()
    expect(ios.yaml).toContain('- tapOn:\n    id: "BackButton"')
    expect(ios.yaml).not.toContain('id: "save-note"')
    const android = compileMaestroFlow(withBack, b, { ...src, platform: 'android' })
    expect(android.yaml).toContain('\n- back\n')
    // Without a back edge the walk takes the forward edge the spec offers (save), as before.
    const saving = compileMaestroFlow(notes, b, { ...src, platform: 'ios' })
    expect(saving.yaml).toContain('id: "save-note"')
  })

  it('follows a tap that opens a screen through a sibling of the edge trigger', () => {
    // The edge names the row's title; the behavior taps the row's excerpt, which opens the same
    // editor. The assertion on the editor moves the tracker, so the later navigate walks back.
    const rows: AppSpec = {
      ...notes,
      screens: [
        {
          ...notes.screens[0]!,
          elements: [
            ...notes.screens[0]!.elements,
            {
              id: 'note-row-excerpt-0',
              kind: 'text',
              label: 'Excerpt',
              testId: 'note-row-excerpt-0',
            },
          ],
        },
        notes.screens[1]!,
      ],
      navigation: {
        ...notes.navigation,
        edges: [
          ...notes.navigation.edges,
          { from: 'list', to: 'editor', trigger: 'Tap a note row (`note-row-0`) — opens it' },
          {
            from: 'editor',
            to: 'list',
            trigger: 'Tap the navigation back button — discards edits',
          },
        ],
      },
    }
    const hooks = {
      ...src,
      sourceHooks: [...src.sourceHooks, 'note-row-excerpt-<indexPath.row>', 'editor-title'],
    }
    const b: Behavior = {
      ...base,
      screen: 'list',
      steps: [
        { op: 'navigate', screen: 'list' },
        { op: 'tap', element: 'note-row-excerpt-0' },
        { op: 'expectVisible', element: 'editor-title' },
        { op: 'type', element: 'note-title', text: 'Changed' },
        { op: 'navigate', screen: 'list' },
        { op: 'expectVisible', element: 'add-note' },
      ],
    }
    const android = compileMaestroFlow(rows, b, { ...hooks, platform: 'android' })
    expect(android.unverifiable).toBeUndefined()
    const typed = android.yaml.indexOf('inputText: "Changed"')
    const back = android.yaml.indexOf('\n- back\n')
    expect(typed).toBeGreaterThan(-1)
    expect(back).toBeGreaterThan(typed)
    // An assertion on a screen no edge leads to from here does not move the tracker.
    const stray: Behavior = {
      ...base,
      screen: 'list',
      steps: [
        { op: 'navigate', screen: 'list' },
        { op: 'expectVisible', element: 'editor-title' },
        { op: 'navigate', screen: 'list' },
      ],
    }
    const noEdge: AppSpec = {
      ...rows,
      navigation: { ...rows.navigation, edges: [rows.navigation.edges[1]!] },
    }
    expect(compileMaestroFlow(noEdge, stray, { ...hooks, platform: 'android' }).yaml).not.toContain(
      '\n- back\n',
    )
  })

  it('opens where the first element step belongs when the behavior names another screen', () => {
    const target = {
      appId: 'dev.example.notes',
      deepLinkBase: 'mpf://dev.example.notes',
      seedArgument: 'mpf_seed',
      platform: 'android' as const,
    }
    const misnamed: Behavior = {
      ...base,
      screen: 'editor',
      steps: [
        { op: 'tap', element: 'add-note' },
        { op: 'type', element: 'note-title', text: 'Draft' },
      ],
    }
    const flow = compileMaestroFlow(notes, misnamed, target)
    expect(flow.yaml).toContain('openLink: mpf://dev.example.notes/list')
    expect(flow.yaml).not.toContain('openLink: mpf://dev.example.notes/editor')
    expect(flow.yaml).toContain('# opens on list: the behavior says editor')
    expect(startScreenOf(notes, misnamed)).toEqual({ screen: 'list', corrected: 'editor' })
    // A leading navigate keeps the behavior's word; so does an element shared by several screens.
    const led: Behavior = {
      ...misnamed,
      steps: [{ op: 'navigate', screen: 'editor' }, ...misnamed.steps],
    }
    expect(startScreenOf(notes, led)).toEqual({ screen: 'editor' })
    const seeded = compileMaestroFlow(
      notes,
      { ...misnamed, steps: [{ op: 'seed', state: { notes: [] } }, ...misnamed.steps] },
      target,
    )
    expect(seeded.yaml).toContain('openLink: mpf://dev.example.notes/list')
  })

  it('does not let a templated hook cover an invented lowercase suffix', () => {
    const hooked = hookMatcher(['note-row-<indexPath.row>', 'line-total-<SKU>'])
    expect(hooked('note-row-swipe-delete')).toBe(false)
    expect(hooked('line-total-MUG-01')).toBe(true)
    expect(hooked('note-row-12')).toBe(true)
  })

  it('refuses to type into or tap an element the source never labels', () => {
    const typing: Behavior = {
      ...base,
      screen: 'list',
      steps: [{ op: 'type', element: 'list-title', text: 'x' }],
    }
    expect(compileMaestroFlow(notes, typing, src).unverifiable).toMatch(
      /list-title has no test hook/,
    )
    const tapping: Behavior = {
      ...base,
      screen: 'list',
      steps: [{ op: 'tap', element: 'list-title' }],
    }
    expect(compileMaestroFlow(notes, tapping, src).yaml).toContain('text: "(?i)Notes"')
  })

  it('matches an unhooked element by its plain-text sourceSelector on the source, never on a target', () => {
    const labelled: AppSpec = {
      ...notes,
      screens: [
        {
          ...notes.screens[0]!,
          elements: [
            ...notes.screens[0]!.elements,
            // The label alone is prose a text matcher cannot use; the selector is the visible text.
            {
              id: 'clear-done',
              kind: 'button',
              label: 'Clear completed notes (footer)',
              testId: 'clear-done',
              sourceSelector: 'Clear completed',
            },
            // A CSS selector means nothing to Maestro: the label still decides.
            {
              id: 'count',
              kind: 'text',
              label: 'Items left',
              testId: 'todo-count',
              sourceSelector: 'span.todo-count',
            },
          ],
        },
        notes.screens[1]!,
      ],
    }
    const b: Behavior = {
      ...base,
      screen: 'list',
      steps: [
        { op: 'expectVisible', element: 'clear-done' },
        { op: 'tap', element: 'clear-done' },
        { op: 'expectHidden', element: 'clear-done' },
        { op: 'expectVisible', element: 'count' },
      ],
    }
    const { yaml, unverifiable } = compileMaestroFlow(labelled, b, src)
    expect(unverifiable).toBeUndefined()
    expect(yaml).toContain('- assertVisible:\n    text: "(?i)Clear completed"')
    expect(yaml).toContain('- tapOn:\n    text: "(?i)Clear completed"')
    expect(yaml).toContain('- assertNotVisible:\n    text: "(?i)Clear completed"')
    expect(yaml).toContain('- assertVisible:\n    text: "(?i)Items left"')
    expect(yaml).not.toContain('todo-count')
    expect(yaml).not.toContain('clear-done')
    const target = compileMaestroFlow(labelled, b, {
      appId: 'app.mpf.notes',
      deepLinkBase: 'mpf://app.mpf.notes',
      seedArgument: 'mpf_seed',
    })
    expect(target.yaml).toContain('- assertVisible:\n    id: "clear-done"')
    expect(target.yaml).toContain('- tapOn:\n    id: "clear-done"')
    expect(target.yaml).toContain('- assertVisible:\n    id: "todo-count"')
    expect(target.yaml).not.toContain('Clear completed')
  })
})

describe('inputLines', () => {
  it('types multi-line text line by line with Enter between lines, keeping empty lines as key presses', () => {
    expect(inputLines('one')).toEqual(['- inputText: "one"'])
    expect(inputLines('Buy milk\nthen bread')).toEqual([
      '- inputText: "Buy milk"',
      '- pressKey: Enter',
      '- inputText: "then bread"',
    ])
    expect(inputLines('\n   \nFirst\nsecond')).toEqual([
      '- pressKey: Enter',
      '- inputText: "   "',
      '- pressKey: Enter',
      '- inputText: "First"',
      '- pressKey: Enter',
      '- inputText: "second"',
    ])
  })
})

describe('swipe steps', () => {
  it('compile to a Maestro swipe from the element, by hook on the source and by id on a target', () => {
    const b: Behavior = {
      id: 'B-001',
      title: 'x',
      screen: 'counter',
      priority: 'must',
      category: 'state',
      evidence: [],
      verifiedOnSource: false,
      steps: [{ op: 'swipe', element: 'increment', direction: 'left' }],
    }
    const target = compileMaestroFlow(spec, b, {
      appId: 'app',
      deepLinkBase: 'mpf://app',
      seedArgument: 'mpf_seed',
    }).yaml
    expect(target).toContain('- swipe:\n    from:\n      id: "increment"\n    direction: LEFT')
    const source = compileMaestroFlow(spec, b, {
      appId: 'app',
      deepLinkBase: '',
      seedArgument: '',
      navigation: 'none',
      sourceHooks: ['increment'],
    })
    expect(source.unverifiable).toBeUndefined()
    expect(source.yaml).toContain('direction: LEFT')
  })
})

describe('qualified taps and restarts on a target app', () => {
  const notes: AppSpec = {
    ...spec,
    screens: [
      {
        id: 'list',
        name: 'List',
        route: '#/',
        purpose: 'p',
        elements: [
          { id: 'add-note', kind: 'button', label: 'Add', testId: 'add-note' },
          { id: 'note-row', kind: 'link', label: 'Note row', testId: 'note_row' },
          { id: 'note-title', kind: 'text', label: 'Note title', testId: 'note_title' },
        ],
        navigatesTo: ['editor'],
      },
      {
        id: 'editor',
        name: 'Editor',
        route: '#/editor',
        purpose: 'p',
        elements: [
          { id: 'editor-title', kind: 'text', label: 'Editor', testId: 'editor-title' },
          { id: 'title-input', kind: 'input', label: 'Title', testId: 'title-input' },
          { id: 'delete-note', kind: 'button', label: 'Delete', testId: 'delete-note' },
        ],
        navigatesTo: ['list'],
      },
    ],
    navigation: {
      style: 'routes',
      root: 'list',
      edges: [
        { from: 'list', to: 'editor', trigger: 'note-row' },
        { from: 'list', to: 'editor', trigger: 'add-note' },
        { from: 'editor', to: 'list', trigger: 'Tap `delete-note` — pops back to the list' },
      ],
    },
  }
  const opts = {
    appId: 'app.mpf.notes',
    deepLinkBase: 'mpf://app.mpf.notes',
    seedArgument: 'mpf_seed',
  }
  const src = {
    appId: 'dev.example.notes',
    deepLinkBase: '',
    seedArgument: '',
    navigation: 'none' as const,
  }
  const base: Behavior = {
    id: 'B-001',
    title: 'x',
    screen: 'list',
    priority: 'must',
    category: 'nav',
    evidence: [],
    verifiedOnSource: false,
    steps: [],
  }
  /** What every target restart starts with: the root view up, then the kill. */
  const rootWait =
    '- extendedWaitUntil:\n    visible:\n      id: "mpf-root"\n    timeout: 10000\n- stopApp\n'

  it('taps the row whose text matches, through containsDescendants on the shared id', () => {
    const b: Behavior = {
      ...base,
      steps: [
        { op: 'tap', element: 'note-row', text: 'First' },
        { op: 'expectVisible', element: 'editor-title' },
      ],
    }
    const { yaml, unverifiable } = compileMaestroFlow(notes, b, opts)
    expect(unverifiable).toBeUndefined()
    // The row's text is what the scroll looks for; the control is probed in every shape first.
    expect(yaml).toContain(
      '- scrollUntilVisible:\n    element:\n      text: ".*First.*"\n    direction: DOWN\n    timeout: 4000\n    optional: true\n- evalScript: ${output.mpfTap = \'\'}\n',
    )
    expect(yaml).toContain(
      '- runFlow:\n    when:\n      true: "${output.mpfTap == \'\'}"\n      visible:\n        id: "note_row"\n        text: ".*First.*"\n    commands:\n      - evalScript: ${output.mpfTap = \'text\'}\n',
    )
    // Then exactly one tap runs, chosen by the probe: direct, descendant, nearest left, nearest right.
    expect(yaml).toContain(
      '- runFlow:\n    when:\n      true: "${output.mpfTap == \'descendant\'}"\n    commands:\n      - tapOn:\n          id: "note_row"\n          containsDescendants:\n            - text: ".*First.*"\n',
    )
    expect(yaml).toContain(
      '      true: "${output.mpfTap == \'left\'}"\n    commands:\n      - tapOn:\n          id: "note_row"\n          leftOf:\n            text: ".*First.*"\n',
    )
    expect(yaml).toContain(
      '      true: "${output.mpfTap == \'\'}"\n    commands:\n      - tapOn:\n          id: "note_row"\n          rightOf:\n            text: ".*First.*"\n',
    )
    const dotted: Behavior = {
      ...base,
      steps: [{ op: 'tap', element: 'note-row', text: 'v1.0 (final)' }],
    }
    expect(compileMaestroFlow(notes, dotted, opts).yaml).toContain(
      '- text: ".*v1\\\\.0 \\\\(final\\\\).*"',
    )
    // A plain tap is unchanged.
    const plain: Behavior = { ...base, steps: [{ op: 'tap', element: 'note-row' }] }
    expect(compileMaestroFlow(notes, plain, opts).yaml).toContain('- tapOn:\n    id: "note_row"\n')
    expect(compileMaestroFlow(notes, plain, opts).yaml).not.toContain('containsDescendants')
  })

  it('on the source app, never turns a prose selector or label into a text matcher', () => {
    const prose: AppSpec = {
      ...notes,
      screens: notes.screens.map((sc) => ({
        ...sc,
        elements: sc.elements.map((e) =>
          e.id === 'note-row'
            ? {
                ...e,
                kind: 'list' as const,
                label: 'Task row',
                sourceSelector: 'clickable row LinearLayout inside tasks_list (task_item.xml root)',
              }
            : e,
        ),
      })),
    }
    // A text qualifier is a real matcher; an unqualified step on the element has nothing to go by.
    const b: Behavior = {
      ...base,
      screen: notes.navigation.root,
      steps: [{ op: 'expectVisible', element: 'note-row' }],
    }
    const out = compileMaestroFlow(prose, b, { ...src, sourceHooks: ['title-input'] })
    expect(out.unverifiable).toMatch(/no test hook/)
    expect(out.yaml).not.toMatch(/Task row|clickable row/)
    // A button's label is its caption and still works as the matcher.
    const captioned: AppSpec = {
      ...prose,
      screens: prose.screens.map((sc) => ({
        ...sc,
        elements: sc.elements.map((e) =>
          e.id === 'note-row'
            ? { ...e, kind: 'button' as const, label: 'Save', sourceSelector: undefined }
            : e,
        ),
      })),
    }
    expect(
      compileMaestroFlow(captioned, b, { ...src, sourceHooks: ['title-input'] }).yaml,
    ).toContain('text: "(?i)Save"')
  })

  it('on the source app, taps a hooked row by id and text and an unhooked one by text alone', () => {
    const b: Behavior = {
      ...base,
      steps: [
        { op: 'tap', element: 'note-row', text: 'First' },
        { op: 'expectVisible', element: 'title-input' },
      ],
    }
    const hooked = compileMaestroFlow(notes, b, {
      ...src,
      sourceHooks: ['note_row', 'title-input'],
    })
    expect(hooked.unverifiable).toBeUndefined()
    expect(hooked.yaml).toContain(
      '      - tapOn:\n          id: "note_row"\n          containsDescendants:\n            - text: ".*First.*"\n',
    )
    const unhooked = compileMaestroFlow(notes, b, { ...src, sourceHooks: ['title-input'] })
    expect(unhooked.unverifiable).toBeUndefined()
    expect(unhooked.yaml).toContain(
      '- scrollUntilVisible:\n    element:\n      text: "(?i).*First.*"',
    )
    expect(unhooked.yaml).toContain('- tapOn:\n    text: "(?i).*First.*"\n')
    expect(unhooked.yaml).not.toContain('note_row')
  })

  it('relaunches a target restart into the screen an edge tap led to, after waiting for the root', () => {
    const b: Behavior = {
      ...base,
      screen: 'editor',
      category: 'persistence',
      steps: [
        { op: 'tap', element: 'delete-note' },
        { op: 'restart' },
        { op: 'expectVisible', element: 'add-note' },
      ],
    }
    const deepLink = compileMaestroFlow(notes, b, opts).yaml
    expect(deepLink).toContain(
      `${rootWait}- launchApp:\n    clearState: false\n- openLink: mpf://app.mpf.notes/list\n`,
    )
    expect(deepLink.split('openLink: mpf://app.mpf.notes/editor').length - 1).toBe(1)
    const byArgument = compileMaestroFlow(notes, b, { ...opts, navigation: 'launch-argument' }).yaml
    expect(byArgument).toContain(
      `${rootWait}- launchApp:\n    clearState: false\n    arguments:\n      mpf_route: "list"\n`,
    )
  })

  it('relaunches into the behavior screen when nothing navigated', () => {
    const b: Behavior = {
      ...base,
      screen: 'editor',
      steps: [
        { op: 'type', element: 'title-input', text: 'Milk' },
        { op: 'restart' },
        { op: 'expectText', element: 'title-input', text: 'Milk', exact: false },
      ],
    }
    expect(compileMaestroFlow(notes, b, opts).yaml).toContain(
      `${rootWait}- launchApp:\n    clearState: false\n- openLink: mpf://app.mpf.notes/editor\n`,
    )
  })

  it('follows seeds and navigate steps, and never waits for the root on a source app', () => {
    const b: Behavior = {
      ...base,
      steps: [
        { op: 'seed', state: { notes: [] } },
        { op: 'navigate', screen: 'editor' },
        { op: 'restart' },
        { op: 'expectVisible', element: 'editor-title' },
      ],
    }
    expect(compileMaestroFlow(notes, b, opts).yaml).toContain(
      `${rootWait}- launchApp:\n    clearState: false\n- openLink: mpf://app.mpf.notes/editor\n`,
    )
    const source: Behavior = {
      ...base,
      steps: [
        { op: 'tap', element: 'add-note' },
        { op: 'restart' },
        { op: 'expectVisible', element: 'add-note' },
      ],
    }
    const yaml = compileMaestroFlow(notes, source, { ...src, sourceHooks: ['add-note'] }).yaml
    expect(yaml).not.toContain('mpf-root')
    expect(yaml).toContain('- stopApp\n- launchApp:\n    clearState: false\n')
  })
})

describe('counts and pauses', () => {
  const listSpec: AppSpec = {
    ...spec,
    screens: [
      {
        ...spec.screens[0]!,
        id: 'list',
        elements: [
          { id: 'notes-list', kind: 'list', label: 'Notes', testId: 'notes-list' },
          { id: 'note-row-0', kind: 'link', label: 'First row', testId: 'note-row-0' },
          { id: 'note-row-1', kind: 'link', label: 'Second row', testId: 'note-row-1' },
          { id: 'add-note', kind: 'button', label: 'Add', testId: 'add-note' },
        ],
        navigatesTo: [],
      },
    ],
    navigation: { style: 'routes', root: 'list', edges: [] },
  }
  const base: Behavior = {
    id: 'B-001',
    title: 'x',
    screen: 'list',
    priority: 'must',
    category: 'state',
    evidence: [],
    verifiedOnSource: false,
    steps: [],
  }

  it('finds the row prefix from numbered or templated row ids, and nothing without an index', () => {
    expect(rowPrefix(listSpec, 'list', 'notes-list')).toBe('note-row-')
    const templated: AppSpec = {
      ...listSpec,
      screens: [
        {
          ...listSpec.screens[0]!,
          elements: [
            listSpec.screens[0]!.elements[0]!,
            { id: 'row', kind: 'link', label: 'Row', testId: 'note-row-<index>' },
          ],
        },
      ],
    }
    expect(rowPrefix(templated, 'list', 'notes-list')).toBe('note-row-')
    expect(rowPrefix(spec, spec.navigation.root, 'nope')).toBeUndefined()
  })

  it('compiles expectCount on an indexed list to the last row visible and the next one absent', () => {
    const two: Behavior = {
      ...base,
      steps: [{ op: 'expectCount', element: 'notes-list', count: 2 }],
    }
    const yaml = compileMaestroFlow(listSpec, two, {
      appId: 'app',
      deepLinkBase: 'mpf://app',
      seedArgument: 'mpf_seed',
    }).yaml
    expect(yaml).toContain('- assertVisible:\n    id: "note-row-1"')
    expect(yaml).toContain('- assertNotVisible:\n    id: "note-row-2"')
    const none: Behavior = {
      ...base,
      steps: [{ op: 'expectCount', element: 'notes-list', count: 0 }],
    }
    const empty = compileMaestroFlow(listSpec, none, {
      appId: 'app',
      deepLinkBase: 'mpf://app',
      seedArgument: 'mpf_seed',
    })
    expect(empty.unverifiable).toBeUndefined()
    expect(empty.yaml).toContain('- assertNotVisible:\n    id: "note-row-0"')
    const unindexed: Behavior = {
      ...base,
      screen: spec.navigation.root,
      steps: [{ op: 'expectCount', element: 'count-value', count: 1 }],
    }
    const shared = compileMaestroFlow(spec, unindexed, {
      appId: 'app',
      deepLinkBase: 'mpf://app',
      seedArgument: 'mpf_seed',
    })
    // Rows without an index share one id: Maestro's index selector picks the N-th match.
    expect(shared.unverifiable).toBeUndefined()
    expect(shared.yaml).toContain('- assertVisible:\n    id: "count-value"\n    index: 0')
    expect(shared.yaml).toContain('- assertNotVisible:\n    id: "count-value"\n    index: 1')
  })

  it('compiles wait to a pause that works on a source app too', () => {
    const b: Behavior = { ...base, screen: spec.navigation.root, steps: [{ op: 'wait', ms: 500 }] }
    const source = compileMaestroFlow(spec, b, {
      appId: 'app',
      deepLinkBase: '',
      seedArgument: '',
      navigation: 'none',
    })
    expect(source.unverifiable).toBeUndefined()
    expect(source.yaml).toContain('id: "mpf-pause-500"\n    timeout: 500\n    optional: true')
    expect(source.yaml).not.toContain('id: "mpf-root"')
  })
})

describe('gradle project names', () => {
  it('drops the characters Gradle forbids and keeps the display name intact', () => {
    expect(gradleProjectName('TodoMVC: Vue')).toBe('TodoMVC Vue')
    expect(gradleProjectName('a/b\\c<d>e"f?g*h|i')).toBe('a b c d e f g h i')
    expect(gradleProjectName(':::')).toBe('app')
    const files = androidFiles({
      packageName: 'app.mpf.todomvcvue',
      appName: 'TodoMVC: Vue',
      minSdk: 26,
      compileSdk: 36,
      screens: [{ id: 'home', name: 'Home' }],
      rootScreen: 'home',
    })
    expect(files['settings.gradle.kts']).toContain('rootProject.name = "TodoMVC Vue"')
    expect(files['app/src/main/res/values/strings.xml']).toContain('TodoMVC: Vue')
  })
})
