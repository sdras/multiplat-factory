import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { androidGradle, xcodeContainer, xcodegenSpec } from '../src/source/mobile.ts'
import { summarizeWebTests } from '../src/source/web.ts'
import { detectSource } from '../src/registry.ts'
import { makeDetectContext } from '../src/types.ts'

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpf-source-tests-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

const UIKIT = 'import UIKit\nfinal class ListViewController: UIViewController {}\n'
const SPEC = 'name: Notes\ntargets:\n  Notes:\n    type: application\n    platform: iOS\n'

describe('summarizeWebTests', () => {
  it('reads vitest, jest, mocha, and node:test summaries', () => {
    const vitest = summarizeWebTests(
      '\u001B[32m ✓ a.test.ts\u001B[0m\n Test Files  2 passed (2)\n      Tests  1 failed | 12 passed | 2 skipped (15)\n',
      1,
    )
    expect(vitest.summary).toEqual({ total: 15, passed: 12, failed: 1, skipped: 2, flaky: 0 })
    expect(vitest.status).toBe('fail')
    const jest = summarizeWebTests('Tests:       12 passed, 12 total\nSnapshots:   0 total\n', 0)
    expect(jest.summary).toMatchObject({ total: 12, passed: 12, failed: 0 })
    expect(jest.status).toBe('pass')
    const mocha = summarizeWebTests('  4 passing (20ms)\n  1 pending\n', 0)
    expect(mocha.summary).toMatchObject({ total: 5, passed: 4, skipped: 1 })
    const node = summarizeWebTests('# tests 3\n# pass 2\n# fail 1\n# skipped 0\n', 1)
    expect(node.summary).toMatchObject({ total: 3, passed: 2, failed: 1 })
    expect(node.status).toBe('fail')
  })

  it('treats an unrecognized runner as one case judged by the exit code', () => {
    expect(summarizeWebTests('all good\n', 0)).toMatchObject({
      status: 'pass',
      summary: { total: 1, passed: 1 },
    })
    const failed = summarizeWebTests('boom\nassertion failed\n', 2)
    expect(failed.status).toBe('fail')
    expect(failed.cases[0]?.message).toContain('assertion failed')
  })

  it('reports a runner that exited non-zero without failing cases as an error', () => {
    expect(summarizeWebTests('Tests  3 passed (3)\n', 1)).toMatchObject({
      status: 'error',
      skipReason: 'exited 1',
    })
    expect(summarizeWebTests('Tests  0 passed (0)\n', 0)).toMatchObject({
      status: 'skip',
      skipReason: 'no test cases ran',
    })
  })
})

describe('iOS containers', () => {
  it('detects an XcodeGen spec as an Xcode source when no project is checked in', async () => {
    const dir = project({
      'project.yml': SPEC,
      'Sources/ListViewController.swift': UIKIT,
      'Sources/AppDelegate.swift': 'import UIKit\n',
    })
    expect(xcodegenSpec(makeDetectContext(dir))).toBe('project.yml')
    const r = await detectSource(dir)
    expect(r.best).toMatchObject({
      adapterId: 'ios-xcode',
      framework: 'uikit',
      language: 'swift',
      entry: 'project.yml',
    })
    expect(r.best?.evidence[0]).toContain('XcodeGen')
  })

  it('prefers a top-level workspace over the project and ignores the workspace inside .xcodeproj', () => {
    const both = project({
      'App.xcodeproj/project.pbxproj': '',
      'App.xcodeproj/project.xcworkspace/contents.xcworkspacedata': '',
      'App.xcworkspace/contents.xcworkspacedata': '',
    })
    expect(xcodeContainer(makeDetectContext(both))).toBe('App.xcworkspace')
    const only = project({
      'App.xcodeproj/project.pbxproj': '',
      'App.xcodeproj/project.xcworkspace/contents.xcworkspacedata': '',
    })
    expect(xcodeContainer(makeDetectContext(only))).toBe('App.xcodeproj')
  })

  it('does not mistake a YAML file without targets for a spec, and Package.swift alone stays SwiftPM', async () => {
    const dir = project({
      'project.yml': 'name: x\n',
      'Package.swift': '// swift-tools-version:5.9\n',
      'Sources/A.swift': 'import SwiftUI\n',
    })
    expect((await detectSource(dir)).best?.adapterId).toBe('ios-swiftpm')
  })
})

describe('android existing tests', () => {
  it('is absent when the project has no unit test sources', async () => {
    const dir = project({
      'settings.gradle': "include ':app'",
      'app/build.gradle': "plugins { id 'com.android.application' }",
      'app/src/main/AndroidManifest.xml': '<manifest/>',
    })
    const cmd = await androidGradle.existingTests!(makeDetectContext(dir), {
      config: {} as never,
      env: {},
      outDir: dir,
      log: () => {},
    })
    expect(cmd).toBeUndefined()
  })
})
