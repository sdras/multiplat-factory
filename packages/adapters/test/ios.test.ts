import { describe, expect, it } from 'vitest'
import {
  bundleIdFor,
  iosFiles,
  iosProjectNameFor,
  swiftTypeName,
} from '../src/target/ios/template.ts'
import { parseXcodebuildOutput, parseXcodebuildTests } from '../src/target/xcodebuild.ts'

describe('ios template', () => {
  it('derives safe names', () => {
    expect(iosProjectNameFor('Counter (web-vanilla-counter)')).toBe('Counterwebvanillacounter')
    expect(iosProjectNameFor('123 app')).toBe('App123app')
    expect(bundleIdFor('My Cool App!')).toBe('app.mpf.mycoolapp')
    const taken = new Set<string>()
    expect(swiftTypeName('settings', taken)).toBe('Settings')
    expect(swiftTypeName('settings', taken)).toBe('Settings2')
  })

  it('writes an XcodeGen project with routes, deep links, identifiers, and the store', () => {
    const files = iosFiles({
      name: 'Counter',
      appName: 'Counter',
      bundleId: 'app.mpf.counter',
      screens: [
        { id: 'counter', name: 'Counter' },
        { id: 'settings', name: 'Settings' },
      ],
      rootScreen: 'counter',
    })
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'project.yml',
        'App/CounterApp.swift',
        'App/Router.swift',
        'App/AppRoot.swift',
        'App/Screens/SettingsScreen.swift',
        'App/Data/AppStore.swift',
        'AppTests/ScaffoldTests.swift',
        'MPF.md',
      ]),
    )
    expect(files['project.yml']).toContain('CFBundleURLSchemes: [mpf]')
    expect(files['project.yml']).toContain('PRODUCT_BUNDLE_IDENTIFIER: app.mpf.counter')
    expect(files['App/Router.swift']).toContain('static let root = counter')
    expect(files['App/AppRoot.swift']).toContain('case Routes.settings: SettingsScreen()')
    expect(files['App/Screens/SettingsScreen.swift']).toContain(
      '.accessibilityIdentifier("screen-settings")',
    )
    expect(files['App/Data/AppStore.swift']).toContain('static let seedKey = "mpf_seed"')
  })
})

describe('parseXcodebuildOutput', () => {
  it('extracts swift diagnostics and generic errors', () => {
    const out = `/w/ios/App/Screens/CounterScreen.swift:12:9: error: cannot find 'foo' in scope
/w/ios/App/Router.swift:3:1: warning: unused variable
xcodebuild: error: Unable to find a destination matching the provided destination specifier
** BUILD FAILED **`
    const d = parseXcodebuildOutput(out, '/w/ios')
    expect(d[0]).toMatchObject({
      severity: 'error',
      file: 'App/Screens/CounterScreen.swift',
      line: 12,
      column: 9,
      message: "cannot find 'foo' in scope",
    })
    expect(d[1]).toMatchObject({ severity: 'warning' })
    expect(d[2]).toMatchObject({ severity: 'error', tool: 'xcodebuild' })
  })
  it('synthesizes an error when the build failed without diagnostics', () => {
    const d = parseXcodebuildOutput(
      '** BUILD FAILED **\nThe following build commands failed:',
      '/w',
    )
    expect(d).toHaveLength(1)
    expect(d[0]?.severity).toBe('error')
  })
})

describe('parseXcodebuildTests', () => {
  it('reads passed, failed, and skipped cases with failure messages', () => {
    const out = `Test Case '-[CounterTests.ScaffoldTests testA]' passed (0.002 seconds).
/w/ios/AppTests/LogicTests.swift:10: error: -[CounterTests.LogicTests testB] : XCTAssertEqual failed: ("1") is not equal to ("2")
Test Case '-[CounterTests.LogicTests testB]' failed (0.010 seconds).
Test Case '-[CounterTests.LogicTests testC]' skipped (0.000 seconds).`
    const r = parseXcodebuildTests(out)
    expect(r.summary).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1, flaky: 0 })
    expect(r.cases[1]).toMatchObject({ id: 'CounterTests.LogicTests.testB', status: 'fail' })
    expect(r.cases[1]?.message).toMatch(/not equal/)
    expect(parseXcodebuildTests('** BUILD FAILED **').skipReason).toMatch(/did not compile/)
  })
})
