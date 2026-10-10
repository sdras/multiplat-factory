import type { AnalysisHints } from '@mpf/core'
import { serveStaticDir, startDevServer, type DevServerHandle } from '@mpf/harness'
import {
  hasFile,
  type DetectContext,
  type ObserveOptions,
  type SourceAdapter,
  type SourceTestCommand,
  type TestOutcome,
} from '../types.ts'
import { ensureInstalled, localBin } from './pm.ts'

const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\/?/

function webFrameworkOf(deps: Record<string, string>): string {
  if (deps['@angular/core']) return 'angular'
  if (deps.svelte) return 'svelte'
  if (deps.vue) return 'vue'
  if (deps['solid-js']) return 'solid'
  if (deps.preact) return 'preact'
  if (deps.react) return 'react'
  if (deps.lit) return 'lit'
  return 'vanilla'
}

function languageOf(ctx: DetectContext): string {
  const ts = ctx.files.some((f) => /\.(ts|tsx)$/.test(f)) || ctx.exists('tsconfig.json')
  return ts ? 'typescript' : 'javascript'
}

function baseHints(framework: string, entryFiles: string[], notes: string[]): AnalysisHints {
  return {
    framework,
    entryFiles,
    routeHints: [],
    stateHints: [],
    persistenceHints: [],
    integrationHints: [],
    testHooks: [],
    notes,
  }
}

async function runLocalOrScript(
  ctx: DetectContext,
  opts: ObserveOptions,
  bin: string,
  binArgs: string[],
  script: string,
  scriptArgs: string[],
  timeoutMs = 120_000,
): Promise<DevServerHandle> {
  const pm = await ensureInstalled(ctx.dir, opts.log, opts.signal)
  const local = localBin(ctx.dir, bin)
  const cmd = local ? { command: local, args: binArgs } : pm.run(script, scriptArgs)
  opts.log(`starting dev server: ${cmd.command} ${cmd.args.join(' ')}`)
  return startDevServer({
    ...cmd,
    cwd: ctx.dir,
    port: opts.port,
    env: opts.env,
    signal: opts.signal,
    urlPattern: URL_PATTERN,
    timeoutMs,
    onOutput: (c) => opts.log(c.trimEnd()),
  })
}

export const webVite: SourceAdapter = {
  id: 'web-vite',
  platform: 'web',
  async detect(ctx) {
    const cfg = hasFile(ctx, /^vite\.config\.(js|ts|mjs|cjs|mts)$/)
    if (!cfg && !ctx.deps.vite) return undefined
    if (ctx.deps['@sveltejs/kit'] || ctx.deps.nuxt || ctx.deps.next || ctx.deps.astro)
      return undefined
    const webFramework = webFrameworkOf(ctx.deps)
    return {
      adapterId: 'web-vite',
      platform: 'web',
      framework: `vite+${webFramework}`,
      language: languageOf(ctx),
      entry: ctx.exists('index.html') ? 'index.html' : (cfg ?? 'package.json'),
      score: cfg ? 0.85 : 0.7,
      evidence: [cfg ?? 'vite in dependencies', `ui: ${webFramework}`],
      supported: true,
      webFramework,
    }
  },
  async hints(ctx, d) {
    const entry = [
      'index.html',
      'src/main.tsx',
      'src/main.ts',
      'src/main.jsx',
      'src/main.js',
      'src/App.tsx',
      'src/App.vue',
      'src/App.svelte',
    ].filter((f) => ctx.exists(f))
    return baseHints(d.framework, entry, [
      'Vite single-page app: screens are usually routes declared in code (react-router, vue-router, svelte routing) or a single screen with conditional views.',
    ])
  },
  observe: (ctx, _d, opts) =>
    runLocalOrScript(
      ctx,
      opts,
      'vite',
      ['--port', String(opts.port), '--strictPort', '--host', '127.0.0.1'],
      'dev',
      ['--port', String(opts.port), '--strictPort', '--host', '127.0.0.1'],
    ),
  existingTests: async (ctx) => testCommand(ctx),
}

export const webNext: SourceAdapter = {
  id: 'web-next',
  platform: 'web',
  async detect(ctx) {
    if (!ctx.deps.next) return undefined
    const appRouter = ctx.exists('app') || ctx.exists('src/app')
    const pages = ctx.exists('pages') || ctx.exists('src/pages')
    return {
      adapterId: 'web-next',
      platform: 'web',
      framework: `next+${appRouter ? 'app-router' : 'pages-router'}`,
      language: languageOf(ctx),
      entry: appRouter
        ? ctx.exists('src/app')
          ? 'src/app'
          : 'app'
        : ctx.exists('src/pages')
          ? 'src/pages'
          : 'pages',
      score: 0.95,
      evidence: [
        'next in dependencies',
        appRouter ? 'app/ directory' : pages ? 'pages/ directory' : 'no router dir',
      ],
      supported: true,
      webFramework: 'react',
    }
  },
  async hints(ctx, d) {
    const notes = d.framework.includes('app-router')
      ? [
          'Next.js app router: every `page.tsx`/`page.jsx` under app/ is a screen; `layout.tsx` wraps screens; route segments in brackets are dynamic.',
        ]
      : [
          'Next.js pages router: every file under pages/ (except _app, _document, api/) is a screen.',
        ]
    notes.push(
      'Server components, route handlers, and data fetching are integrations of kind http-api for the port plan.',
    )
    return baseHints(d.framework, [d.entry], notes)
  },
  observe: (ctx, _d, opts) =>
    runLocalOrScript(
      ctx,
      opts,
      'next',
      ['dev', '-p', String(opts.port), '-H', '127.0.0.1'],
      'dev',
      ['-p', String(opts.port)],
      180_000,
    ),
  existingTests: async (ctx) => testCommand(ctx),
}

export const webNuxt: SourceAdapter = {
  id: 'web-nuxt',
  platform: 'web',
  async detect(ctx) {
    if (!ctx.deps.nuxt) return undefined
    return {
      adapterId: 'web-nuxt',
      platform: 'web',
      framework: 'nuxt',
      language: languageOf(ctx),
      entry: ctx.exists('app/app.vue')
        ? 'app/app.vue'
        : ctx.exists('app.vue')
          ? 'app.vue'
          : 'nuxt.config',
      score: 0.95,
      evidence: ['nuxt in dependencies'],
      supported: true,
      webFramework: 'vue',
    }
  },
  async hints(_ctx, d) {
    return baseHints(
      d.framework,
      [d.entry],
      [
        'Nuxt: files under pages/ (or app/pages/) are screens; layouts/ wrap them; composables/ and stores/ hold state; server/ holds API routes (integration kind http-api).',
      ],
    )
  },
  observe: (ctx, _d, opts) =>
    runLocalOrScript(
      ctx,
      opts,
      'nuxt',
      ['dev', '--port', String(opts.port), '--host', '127.0.0.1'],
      'dev',
      ['--port', String(opts.port)],
      180_000,
    ),
  existingTests: async (ctx) => testCommand(ctx),
}

export const webSvelteKit: SourceAdapter = {
  id: 'web-sveltekit',
  platform: 'web',
  async detect(ctx) {
    if (!ctx.deps['@sveltejs/kit']) return undefined
    return {
      adapterId: 'web-sveltekit',
      platform: 'web',
      framework: 'sveltekit',
      language: languageOf(ctx),
      entry: 'src/routes',
      score: 0.95,
      evidence: ['@sveltejs/kit in dependencies'],
      supported: true,
      webFramework: 'svelte',
    }
  },
  async hints(_ctx, d) {
    return baseHints(
      d.framework,
      ['src/routes'],
      [
        'SvelteKit: every +page.svelte under src/routes is a screen; +layout.svelte wraps; +page.server.ts and +server.ts are integrations of kind http-api.',
      ],
    )
  },
  observe: (ctx, _d, opts) =>
    runLocalOrScript(
      ctx,
      opts,
      'vite',
      ['dev', '--port', String(opts.port), '--strictPort', '--host', '127.0.0.1'],
      'dev',
      ['--port', String(opts.port), '--strictPort'],
    ),
  existingTests: async (ctx) => testCommand(ctx),
}

export const webAngular: SourceAdapter = {
  id: 'web-angular',
  platform: 'web',
  async detect(ctx) {
    if (!ctx.deps['@angular/core']) return undefined
    return {
      adapterId: 'web-angular',
      platform: 'web',
      framework: 'angular',
      language: 'typescript',
      entry: ctx.exists('src/main.ts') ? 'src/main.ts' : 'angular.json',
      score: ctx.exists('angular.json') ? 0.95 : 0.8,
      evidence: [
        '@angular/core in dependencies',
        ctx.exists('angular.json') ? 'angular.json' : 'no angular.json',
      ],
      supported: true,
      webFramework: 'angular',
    }
  },
  async hints(_ctx, d) {
    return baseHints(
      d.framework,
      [d.entry],
      [
        'Angular: screens are routed components (see app.routes.ts or RouterModule); services with providedIn root hold state; HttpClient calls are http-api integrations.',
      ],
    )
  },
  observe: (ctx, _d, opts) =>
    runLocalOrScript(
      ctx,
      opts,
      'ng',
      ['serve', '--port', String(opts.port), '--host', '127.0.0.1'],
      'start',
      ['--port', String(opts.port)],
      240_000,
    ),
  existingTests: async (ctx) => testCommand(ctx),
}

/** Any package.json with a dev or start script that no specific adapter claimed. */
export const webGeneric: SourceAdapter = {
  id: 'web-generic',
  platform: 'web',
  async detect(ctx) {
    const scripts = ctx.packageJson?.scripts ?? {}
    if (!ctx.packageJson || !(scripts.dev || scripts.start)) return undefined
    const webFramework = webFrameworkOf(ctx.deps)
    return {
      adapterId: 'web-generic',
      platform: 'web',
      framework: `node+${webFramework}`,
      language: languageOf(ctx),
      entry: 'package.json',
      score: 0.5,
      evidence: [`scripts: ${Object.keys(scripts).join(', ')}`, `ui: ${webFramework}`],
      supported: true,
      webFramework,
    }
  },
  async hints(_ctx, d) {
    return baseHints(
      d.framework,
      ['package.json'],
      [
        'Unknown web toolchain: locate the entry from package.json scripts and the HTML that mounts the app.',
      ],
    )
  },
  async observe(ctx, _d, opts) {
    const pm = await ensureInstalled(ctx.dir, opts.log, opts.signal)
    const script = ctx.packageJson?.scripts?.dev ? 'dev' : 'start'
    const cmd = pm.run(script)
    opts.log(`starting: ${cmd.command} ${cmd.args.join(' ')} (PORT=${opts.port})`)
    return startDevServer({
      ...cmd,
      cwd: ctx.dir,
      port: opts.port,
      env: opts.env,
      signal: opts.signal,
      urlPattern: URL_PATTERN,
      timeoutMs: 120_000,
      onOutput: (c) => opts.log(c.trimEnd()),
    })
  },
  existingTests: async (ctx) => testCommand(ctx),
}

/** A build-less site: index.html plus scripts and styles, no package.json scripts. */
export const webStatic: SourceAdapter = {
  id: 'web-static',
  platform: 'web',
  async detect(ctx) {
    const index = ctx.exists('index.html')
      ? 'index.html'
      : ctx.exists('public/index.html')
        ? 'public/index.html'
        : undefined
    if (!index) return undefined
    const scripts = ctx.packageJson?.scripts ?? {}
    if (scripts.dev || scripts.start || scripts.build) return undefined
    return {
      adapterId: 'web-static',
      platform: 'web',
      framework: 'static-html',
      language: languageOf(ctx),
      entry: index,
      score: 0.6,
      evidence: [index, 'no build scripts'],
      supported: true,
      webFramework: 'vanilla',
    }
  },
  async hints(_ctx, d) {
    return baseHints(
      d.framework,
      [d.entry],
      [
        'Static HTML app: screens are sections or hash routes toggled by script; state lives in module scope and browser storage.',
      ],
    )
  },
  async observe(ctx, d, opts) {
    const root = d.entry === 'public/index.html' ? `${ctx.dir}/public` : ctx.dir
    opts.log(`serving static files from ${root}`)
    return serveStaticDir(root, opts.port)
  },
}

function testCommand(ctx: DetectContext): SourceTestCommand | undefined {
  const script = ctx.packageJson?.scripts?.test
  if (!script || /no test specified/.test(script)) return undefined
  const pm = ctx.exists('pnpm-lock.yaml') ? 'pnpm' : ctx.exists('yarn.lock') ? 'yarn' : 'npm'
  // vitest watches outside CI unless told to run once; every common runner honors CI=1 for the rest.
  const args =
    /\bvitest\b/.test(script) && !/\s(run|--run)\b/.test(script)
      ? ['test', '--', '--run']
      : ['test']
  return {
    command: pm,
    args,
    env: { CI: '1' },
    timeoutMs: 20 * 60_000,
    summarize: (r) => summarizeWebTests(`${r.stdout}\n${r.stderr}`, r.exitCode),
  }
}

const EMPTY = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 }
const ANSI = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, 'g')

/** Counts from vitest, jest, mocha, and node:test summaries; anything else is one case judged by the exit code. */
export function summarizeWebTests(output: string, exitCode: number): TestOutcome {
  const text = output.replace(ANSI, '')
  const count = (re: RegExp, from = text) => {
    const m = re.exec(from)
    return m ? Number(m[1]) : 0
  }
  let counts: { total: number; passed: number; failed: number; skipped: number } | undefined
  // vitest: "Tests  1 failed | 12 passed | 2 skipped (15)"; jest: "Tests:  1 failed, 12 passed, 15 total"
  const summaryLine = /^\s*Tests:?[ \t]+(\S.*)$/m.exec(text)?.[1]
  if (summaryLine && /\b(?:passed|failed|skipped|total|todo|pending)\b/.test(summaryLine)) {
    const passed = count(/(\d+) passed/, summaryLine)
    const failed = count(/(\d+) failed/, summaryLine)
    const skipped = count(/(\d+) (?:skipped|todo|pending)/, summaryLine)
    counts = {
      total:
        count(/\((\d+)\)/, summaryLine) ||
        count(/(\d+) total/, summaryLine) ||
        passed + failed + skipped,
      passed,
      failed,
      skipped,
    }
  } else if (/^\s*\d+ passing\b/m.test(text)) {
    const passed = count(/(\d+) passing/)
    const failed = count(/(\d+) failing/)
    const skipped = count(/(\d+) pending/)
    counts = { total: passed + failed + skipped, passed, failed, skipped }
  } else if (/^# tests \d+/m.test(text)) {
    counts = {
      total: count(/^# tests (\d+)/m),
      passed: count(/^# pass (\d+)/m),
      failed: count(/^# fail (\d+)/m),
      skipped: count(/^# skipped (\d+)/m),
    }
  }
  if (!counts) {
    const ok = exitCode === 0
    const message = ok ? undefined : text.trim().split('\n').slice(-15).join('\n')
    return {
      kind: 'unit',
      status: ok ? 'pass' : 'fail',
      cases: [
        {
          id: 'test-script',
          name: 'package.json test script',
          status: ok ? 'pass' : 'fail',
          durationMs: 0,
          message,
          artifacts: [],
        },
      ],
      summary: { ...EMPTY, total: 1, passed: ok ? 1 : 0, failed: ok ? 0 : 1 },
    }
  }
  const status = counts.failed ? 'fail' : exitCode !== 0 ? 'error' : counts.passed ? 'pass' : 'skip'
  return {
    kind: 'unit',
    status,
    skipReason:
      counts.total === 0
        ? 'no test cases ran'
        : exitCode !== 0 && !counts.failed
          ? `exited ${exitCode}`
          : undefined,
    cases: [],
    summary: { ...EMPTY, ...counts },
  }
}

export const WEB_SOURCE_ADAPTERS: SourceAdapter[] = [
  webNext,
  webNuxt,
  webSvelteKit,
  webAngular,
  webVite,
  webGeneric,
  webStatic,
]
