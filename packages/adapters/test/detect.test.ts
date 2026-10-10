import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectSource } from '../src/registry.ts'
import { detectPackageManager } from '../src/source/pm.ts'

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mpf-detect-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { dev: 'x' }) =>
  JSON.stringify({ name: 'x', scripts, dependencies: deps })

describe('detectSource', () => {
  it('recognizes Vite apps and their UI framework', async () => {
    const r = await detectSource(
      project({
        'package.json': pkg({ vite: '5', react: '18' }),
        'vite.config.ts': '',
        'index.html': '',
      }),
    )
    expect(r.best?.adapterId).toBe('web-vite')
    expect(r.best?.webFramework).toBe('react')
    expect(r.ambiguous).toBe(false)
  })

  it('prefers Next, Nuxt, SvelteKit, and Angular over the generic Vite and script adapters', async () => {
    expect(
      (
        await detectSource(
          project({ 'package.json': pkg({ next: '15', react: '19' }), 'app/page.tsx': '' }),
        )
      ).best?.adapterId,
    ).toBe('web-next')
    expect(
      (await detectSource(project({ 'package.json': pkg({ nuxt: '4', vue: '3' }) }))).best
        ?.adapterId,
    ).toBe('web-nuxt')
    expect(
      (
        await detectSource(
          project({
            'package.json': pkg({ '@sveltejs/kit': '2', vite: '6' }),
            'vite.config.ts': '',
          }),
        )
      ).best?.adapterId,
    ).toBe('web-sveltekit')
    expect(
      (
        await detectSource(
          project({ 'package.json': pkg({ '@angular/core': '19' }), 'angular.json': '{}' }),
        )
      ).best?.adapterId,
    ).toBe('web-angular')
  })

  it('falls back to generic scripts, then to static html', async () => {
    const generic = await detectSource(
      project({ 'package.json': pkg({ express: '4' }, { start: 'node server.js' }) }),
    )
    expect(generic.best?.adapterId).toBe('web-generic')
    const html = await detectSource(project({ 'index.html': '<html></html>', 'main.js': '' }))
    expect(html.best?.adapterId).toBe('web-static')
    expect(html.best?.webFramework).toBe('vanilla')
  })

  it('recognizes iOS and Android projects', async () => {
    const ios = await detectSource(
      project({ 'App.xcodeproj/project.pbxproj': '', 'App/ContentView.swift': 'import SwiftUI' }),
    )
    expect(ios.best?.adapterId).toBe('ios-xcode')
    expect(ios.best?.platform).toBe('ios')
    expect(ios.best?.framework).toBe('swiftui')
    const android = await detectSource(
      project({
        'settings.gradle.kts': '',
        'app/build.gradle.kts':
          'plugins { id("com.android.application") }\ndependencies { implementation(platform("androidx.compose:compose-bom:2025.06.00")) }',
        'app/src/main/java/x/Main.kt': '',
      }),
    )
    expect(android.best?.adapterId).toBe('android-gradle')
    expect(android.best?.framework).toBe('compose')
    expect(android.best?.language).toBe('kotlin')
  })

  it('flags cross-platform sources as recognized but unsupported', async () => {
    const rn = await detectSource(
      project({ 'package.json': pkg({ 'react-native': '0.76', react: '18' }), 'App.tsx': '' }),
    )
    expect(rn.best?.adapterId).toBe('cross-react-native')
    expect(rn.best?.supported).toBe(false)
    const fl = await detectSource(
      project({ 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n' }),
    )
    expect(fl.best?.supported).toBe(false)
  })

  it('detects the in-house counter fixture as a static web app', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const fixture = join(here, '..', '..', '..', 'fixtures', 'inhouse', 'web-vanilla-counter')
    const r = await detectSource(fixture)
    expect(r.best?.adapterId).toBe('web-static')
  })

  it('returns nothing for an empty directory', async () => {
    const r = await detectSource(project({}))
    expect(r.best).toBeUndefined()
  })
})

describe('detectPackageManager', () => {
  it('reads the lockfile', () => {
    expect(detectPackageManager(project({ 'pnpm-lock.yaml': '' })).name).toBe('pnpm')
    expect(detectPackageManager(project({ 'yarn.lock': '' })).name).toBe('yarn')
    expect(detectPackageManager(project({ 'bun.lock': '' })).name).toBe('bun')
    expect(detectPackageManager(project({})).name).toBe('npm')
  })
})

describe('in-house fixtures', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const manifest = JSON.parse(readFileSync(join(root, 'fixtures', 'manifest.json'), 'utf8')) as {
    inhouse: { id: string; path: string; expect: Record<string, string> }[]
  }
  for (const fixture of manifest.inhouse) {
    it(`${fixture.id} is detected as ${fixture.expect.adapterId}`, async () => {
      const r = await detectSource(join(root, fixture.path))
      expect(r.ambiguous).toBe(false)
      for (const [key, value] of Object.entries(fixture.expect)) {
        expect((r.best as Record<string, unknown> | undefined)?.[key], key).toBe(value)
      }
    })
  }
})
