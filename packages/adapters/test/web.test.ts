import { describe, expect, it } from 'vitest'
import { parseWebBuildOutput } from '../src/target/web/index.ts'
import { screenIdent, webFiles, webPackageNameFor } from '../src/target/web/template.ts'

describe('web template', () => {
  it('derives names', () => {
    expect(webPackageNameFor('Counter (web-vanilla-counter)')).toBe('counter-web-vanilla-counter')
    expect(webPackageNameFor('!!!')).toBe('ported-app')
    expect(screenIdent('2fa-setup')).toBe('Screen2faSetup')
  })

  it('writes vanilla and react scaffolds with routes, test ids, store, and tests', () => {
    const base = {
      name: 'counter',
      appName: 'Counter',
      screens: [
        { id: 'counter', name: 'Counter' },
        { id: 'settings', name: 'Settings' },
      ],
      rootScreen: 'counter',
    }
    const vanilla = webFiles({ ...base, framework: 'vanilla' })
    expect(Object.keys(vanilla)).toEqual(
      expect.arrayContaining([
        'package.json',
        'index.html',
        'src/main.ts',
        'src/routes.ts',
        'src/store.ts',
        'src/screens/SettingsScreen.ts',
        'src/routes.test.ts',
        'MPF.md',
      ]),
    )
    expect(vanilla['src/routes.ts']).toContain("root: 'counter'")
    expect(vanilla['index.html']).toContain('data-testid="mpf-root"')
    expect(vanilla['src/screens/SettingsScreen.ts']).toContain("dataset.testid = 'screen-settings'")
    expect(JSON.parse(vanilla['package.json']!).dependencies).toEqual({})
    expect(vanilla['MPF.md']).toContain('persisted before the first frame')
    expect(vanilla['src/main.ts']!.indexOf('applySeedIfPresent()')).toBeLessThan(
      vanilla['src/main.ts']!.indexOf('render()'),
    )
    const react = webFiles({ ...base, framework: 'react' })
    expect(Object.keys(react)).toEqual(
      expect.arrayContaining([
        'src/main.tsx',
        'src/App.tsx',
        'src/screens/CounterScreen.tsx',
        'src/App.test.tsx',
      ]),
    )
    expect(JSON.parse(react['package.json']!).dependencies.react).toBeDefined()
    expect(react['src/App.tsx']).toContain('case Routes.settings:')
  })
})

describe('parseWebBuildOutput', () => {
  it('reads tsc and vite diagnostics', () => {
    const out = `src/screens/CounterScreen.ts(12,5): error TS2304: Cannot find name 'foo'.
✘ [ERROR] Could not resolve "./missing"
src/main.ts:3:8: ERROR: something
error during build:`
    const d = parseWebBuildOutput(out)
    expect(d[0]).toMatchObject({
      tool: 'tsc',
      file: 'src/screens/CounterScreen.ts',
      line: 12,
      column: 5,
      code: 'TS2304',
    })
    expect(d.some((x) => x.tool === 'vite' && /resolve/.test(x.message))).toBe(true)
    expect(d.some((x) => x.file === 'src/main.ts' && x.line === 3)).toBe(true)
  })
})
