import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'pathe'
import { type CheckFn, missing, ok, warn } from '../types.ts'

/**
 * Directory names Playwright gives the Chromium builds `chromium.launch` can use: the full
 * browser and, since Playwright 1.49, the headless shell it prefers for headless runs.
 */
const CHROMIUM_PREFIXES = ['chromium-', 'chromium_headless_shell-']

/** Playwright writes this marker into a browser directory once the download is fully unpacked. */
const INSTALL_MARKER = 'INSTALLATION_COMPLETE'

const INSTALL = 'npx playwright install chromium'
const REPO_INSTALL = 'pnpm --filter @mpf/analyzer exec playwright install chromium'
const DEGRADED =
  'web sources are observed as "unverified" and the web target cannot run its end-to-end flows'

export interface BrowsersPathOptions {
  /** Start of the upward search for a `playwright-core` package when PLAYWRIGHT_BROWSERS_PATH=0. */
  cwd?: string
  /** Home directory for the per-OS default cache (tests point it at a temp dir). */
  home?: string
}

/**
 * Where Playwright keeps its browsers, mirroring its registry without importing it:
 * PLAYWRIGHT_BROWSERS_PATH wins (`0` means `.local-browsers` inside the playwright-core package;
 * a relative path is resolved from INIT_CWD or the cwd, as Playwright does), otherwise the
 * per-OS cache (`~/Library/Caches/ms-playwright`, `$XDG_CACHE_HOME` or `~/.cache/ms-playwright`,
 * `%LOCALAPPDATA%\ms-playwright`). Undefined when `0` is set but no playwright-core package is
 * on disk, or on a platform Playwright does not support.
 */
export function resolvePlaywrightBrowsersPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  opts: BrowsersPathOptions = {},
): string | undefined {
  const cwd = opts.cwd ?? process.cwd()
  const configured = env.PLAYWRIGHT_BROWSERS_PATH
  if (configured === '0') {
    const pkg = findPlaywrightCore(cwd)
    return pkg ? join(pkg, '.local-browsers') : undefined
  }
  if (configured)
    return isAbsolute(configured) ? configured : resolve(env.INIT_CWD ?? cwd, configured)
  const home = opts.home ?? homedir()
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright')
  if (platform === 'linux') return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'ms-playwright')
  if (platform === 'win32')
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ms-playwright')
  return undefined
}

export interface ChromiumInstall {
  /** Directory name, e.g. `chromium-1243` or `chromium_headless_shell-1243`. */
  name: string
  /** Playwright's build revision, taken from the directory name. */
  revision: string
  /** Whether the download finished (a partial one has no INSTALLATION_COMPLETE marker). */
  complete: boolean
}

/** Chromium builds in a browsers directory, newest revision first and the full browser before the
 * headless shell at the same revision. Looks at names only. */
export function findChromiumInstalls(dir: string): ChromiumInstall[] {
  return listDirents(dir)
    .filter(
      (d) =>
        (d.isDirectory() || d.isSymbolicLink()) &&
        CHROMIUM_PREFIXES.some((prefix) => d.name.startsWith(prefix)),
    )
    .map((d) => ({
      name: d.name,
      revision: d.name.slice(d.name.lastIndexOf('-') + 1),
      complete: existsSync(join(dir, d.name, INSTALL_MARKER)),
    }))
    .sort((a, b) => Number(b.revision) - Number(a.revision) || rank(a.name) - rank(b.name))
}

/**
 * Chromium for Playwright. It does not gate the web target (the build and unit tests run
 * without it); without it the observe stage records every web behavior as unverified and the
 * web target's end-to-end flows cannot run. Detection is by directory only: harness never
 * imports playwright and never touches the network.
 */
export const playwrightCheck: CheckFn = async ({ env, platform }) => {
  const label = 'Playwright Chromium'
  const affects = ['web-observe', 'web-e2e']
  const fix = { manual: `${INSTALL}   # in this repo: ${REPO_INSTALL}` }
  const dir = resolvePlaywrightBrowsersPath(env, platform)
  if (!dir) {
    const why =
      env.PLAYWRIGHT_BROWSERS_PATH === '0'
        ? 'PLAYWRIGHT_BROWSERS_PATH=0 but no playwright-core package was found above the working directory'
        : `Playwright has no Chromium build for ${platform}`
    return missing('playwright', label, `${why}; ${DEGRADED}`, { affects, fix })
  }
  const installs = findChromiumInstalls(dir)
  const names = (list: ChromiumInstall[]) => list.map((i) => i.name).join(', ')
  const complete = installs.filter((i) => i.complete)
  const [best] = complete
  if (best) {
    return ok('playwright', label, `${names(complete)} in ${dir}`, {
      version: best.revision,
      affects,
    })
  }
  const [partial] = installs
  if (partial) {
    return warn(
      'playwright',
      label,
      `${names(installs)} in ${dir} never finished downloading (no ${INSTALL_MARKER}); ${DEGRADED}`,
      { version: partial.revision, affects, fix },
    )
  }
  return missing('playwright', label, `No chromium build in ${dir}; ${DEGRADED}`, { affects, fix })
}

/**
 * The playwright-core package nearest to `start`, then nearest to this file (the published CLI
 * keeps its node_modules next to harness): a hoisted `node_modules/playwright-core` or pnpm's
 * `node_modules/.pnpm/playwright-core@<v>/node_modules/playwright-core`.
 */
function findPlaywrightCore(start: string): string | undefined {
  for (const from of [start, import.meta.dirname]) {
    for (let dir = resolve(from), prev = ''; dir !== prev; prev = dir, dir = dirname(dir)) {
      const direct = join(dir, 'node_modules', 'playwright-core')
      if (existsSync(join(direct, 'package.json'))) return direct
      const store = join(dir, 'node_modules', '.pnpm')
      const versions = listDirents(store)
        .map((d) => d.name)
        .filter((n) => n.startsWith('playwright-core@'))
        .sort()
      for (const v of versions) {
        const nested = join(store, v, 'node_modules', 'playwright-core')
        if (existsSync(join(nested, 'package.json'))) return nested
      }
    }
  }
  return undefined
}

const rank = (name: string) => CHROMIUM_PREFIXES.findIndex((prefix) => name.startsWith(prefix))

function listDirents(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
