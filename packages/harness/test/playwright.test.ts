import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MpfConfig } from '@mpf/core'
import {
  findChromiumInstalls,
  playwrightCheck,
  resolvePlaywrightBrowsersPath,
} from '../src/toolchain/checks/playwright.ts'
import type { CheckContext } from '../src/toolchain/types.ts'

const { toolchain, llm, models } = MpfConfig.parse({})
const ctx = (env: NodeJS.ProcessEnv): CheckContext => ({
  env,
  platform: process.platform,
  toolchain,
  llm,
  models,
})

/** A browser directory the way `playwright install` leaves it: a folder plus the completion marker. */
function installBrowser(root: string, name: string, complete = true) {
  mkdirSync(join(root, name), { recursive: true })
  if (complete) writeFileSync(join(root, name, 'INSTALLATION_COMPLETE'), '')
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mpf-playwright-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('playwrightCheck', () => {
  it('is missing when the browsers directory has no chromium build', async () => {
    installBrowser(dir, 'ffmpeg-1011')
    installBrowser(dir, 'webkit-2191')
    const r = await playwrightCheck(ctx({ PLAYWRIGHT_BROWSERS_PATH: dir }))
    expect(r.id).toBe('playwright')
    expect(r.status).toBe('missing')
    expect(r.detail).toContain(dir)
    expect(r.detail).toContain('unverified')
    expect(r.affects).toEqual(['web-observe', 'web-e2e'])
    expect(r.fix?.manual).toContain('npx playwright install chromium')
    expect(r.fix?.manual).toContain('pnpm --filter @mpf/analyzer exec playwright install chromium')
  })

  it('is missing when PLAYWRIGHT_BROWSERS_PATH points at a directory that does not exist', async () => {
    const r = await playwrightCheck(ctx({ PLAYWRIGHT_BROWSERS_PATH: join(dir, 'nope') }))
    expect(r.status).toBe('missing')
    expect(r.detail).toContain(join(dir, 'nope'))
  })

  it('is ok with the folder name and build when chromium-<rev> is installed', async () => {
    installBrowser(dir, 'chromium-1234')
    const r = await playwrightCheck(ctx({ PLAYWRIGHT_BROWSERS_PATH: dir }))
    expect(r.status).toBe('ok')
    expect(r.version).toBe('1234')
    expect(r.detail).toBe(`chromium-1234 in ${dir}`)
    expect(r.affects).toEqual(['web-observe', 'web-e2e'])
    expect(r.fix).toBeUndefined()
  })

  it('accepts the headless shell on its own and lists every complete build, newest first', async () => {
    installBrowser(dir, 'chromium_headless_shell-1234')
    const alone = await playwrightCheck(ctx({ PLAYWRIGHT_BROWSERS_PATH: dir }))
    expect(alone.status).toBe('ok')
    expect(alone.detail).toBe(`chromium_headless_shell-1234 in ${dir}`)

    installBrowser(dir, 'chromium-1234')
    installBrowser(dir, 'chromium-1300')
    installBrowser(dir, 'chromium-1250', false)
    const several = await playwrightCheck(ctx({ PLAYWRIGHT_BROWSERS_PATH: dir }))
    expect(several.status).toBe('ok')
    expect(several.version).toBe('1300')
    expect(several.detail).toBe(
      `chromium-1300, chromium-1234, chromium_headless_shell-1234 in ${dir}`,
    )
  })

  it('warns when the only chromium build never finished downloading', async () => {
    installBrowser(dir, 'chromium-1234', false)
    const r = await playwrightCheck(ctx({ PLAYWRIGHT_BROWSERS_PATH: dir }))
    expect(r.status).toBe('warn')
    expect(r.version).toBe('1234')
    expect(r.detail).toContain('INSTALLATION_COMPLETE')
    expect(r.fix?.manual).toContain('npx playwright install chromium')
  })

  it('never runs a process or opens the network: a check completes on a bare environment', async () => {
    const r = await playwrightCheck(ctx({ PLAYWRIGHT_BROWSERS_PATH: dir }))
    expect(['ok', 'warn', 'missing']).toContain(r.status)
  })
})

describe('resolvePlaywrightBrowsersPath', () => {
  it('honors an absolute PLAYWRIGHT_BROWSERS_PATH on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(resolvePlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: dir }, platform)).toBe(dir)
    }
  })

  it('resolves a relative PLAYWRIGHT_BROWSERS_PATH from INIT_CWD, then from the cwd', () => {
    const env = { PLAYWRIGHT_BROWSERS_PATH: 'browsers', INIT_CWD: join(dir, 'init') }
    expect(resolvePlaywrightBrowsersPath(env, 'linux', { cwd: join(dir, 'cwd') })).toBe(
      join(dir, 'init', 'browsers'),
    )
    expect(
      resolvePlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: 'browsers' }, 'linux', {
        cwd: join(dir, 'cwd'),
      }),
    ).toBe(join(dir, 'cwd', 'browsers'))
  })

  it('maps 0 to .local-browsers inside the nearest hoisted playwright-core package', () => {
    const pkg = join(dir, 'node_modules', 'playwright-core')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"playwright-core"}')
    const found = resolvePlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: '0' }, 'darwin', {
      cwd: join(dir, 'apps', 'deep'),
    })
    expect(found).toBe(join(pkg, '.local-browsers'))
  })

  it('maps 0 to the playwright-core package inside a pnpm store', () => {
    const pkg = join(
      dir,
      'node_modules',
      '.pnpm',
      'playwright-core@1.63.0',
      'node_modules',
      'playwright-core',
    )
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"playwright-core"}')
    const found = resolvePlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: '0' }, 'linux', {
      cwd: dir,
    })
    expect(found).toBe(join(pkg, '.local-browsers'))
  })

  it('makes the check report a chromium build kept under PLAYWRIGHT_BROWSERS_PATH=0', async () => {
    const pkg = join(dir, 'node_modules', 'playwright-core')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"playwright-core"}')
    installBrowser(join(pkg, '.local-browsers'), 'chromium-1234')
    const browsers = resolvePlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: '0' }, 'darwin', {
      cwd: dir,
    })
    expect(browsers).toBe(join(pkg, '.local-browsers'))
    expect(findChromiumInstalls(browsers!)).toEqual([
      { name: 'chromium-1234', revision: '1234', complete: true },
    ])
  })

  it('falls back to the per-OS cache, honoring XDG_CACHE_HOME and LOCALAPPDATA', () => {
    expect(resolvePlaywrightBrowsersPath({}, 'darwin', { home: '/h' })).toBe(
      '/h/Library/Caches/ms-playwright',
    )
    expect(resolvePlaywrightBrowsersPath({}, 'linux', { home: '/h' })).toBe(
      '/h/.cache/ms-playwright',
    )
    expect(resolvePlaywrightBrowsersPath({ XDG_CACHE_HOME: '/xdg' }, 'linux', { home: '/h' })).toBe(
      '/xdg/ms-playwright',
    )
    expect(resolvePlaywrightBrowsersPath({}, 'win32', { home: '/h' })).toBe(
      '/h/AppData/Local/ms-playwright',
    )
    expect(
      resolvePlaywrightBrowsersPath({ LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'win32', {
        home: '/h',
      }),
    ).toBe('C:/Users/u/AppData/Local/ms-playwright')
    expect(resolvePlaywrightBrowsersPath({}, 'freebsd', { home: '/h' })).toBeUndefined()
  })
})

describe('findChromiumInstalls', () => {
  it('returns nothing for a missing directory and ignores files and other browsers', () => {
    expect(findChromiumInstalls(join(dir, 'absent'))).toEqual([])
    writeFileSync(join(dir, 'chromium-9999'), 'a file, not a build')
    installBrowser(dir, 'firefox-1500')
    expect(findChromiumInstalls(dir)).toEqual([])
  })
})
