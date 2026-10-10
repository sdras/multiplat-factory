import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'pathe'
import type { AppSpec, Diagnostic } from '@mpf/core'
import { findFreePort, runProcess, startDevServer, which } from '@mpf/harness'
import type {
  BuildResult,
  CompiledFlow,
  E2eResult,
  ShippedAppId,
  TargetAdapter,
  TargetContext,
  TestOutcome,
} from '../../types.ts'
import { writeCoreEmbed } from '../../core/embed.ts'
import { webCoreConventions, webCoreEmbed } from '../../core/web.ts'
import { localBin } from '../../source/pm.ts'
import { parseJUnitFile } from '../junit.ts'
import { executeBehavior, launchChromium, screenshotScreens } from './executor.ts'
import {
  WEB_SEED_PARAM,
  webFiles,
  webPackageNameFor,
  type WebFramework,
  type WebProject,
} from './template.ts'

/** The package name the workspace's `package.json` declares; undefined when it is missing or unnamed. */
export function shippedWebPackageName(workspace: string): ShippedAppId | undefined {
  try {
    const name = (JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as PackageLike)
      .name
    return typeof name === 'string' && name
      ? { label: 'Package name', value: name, file: 'package.json' }
      : undefined
  } catch {
    return undefined
  }
}

interface PackageLike {
  name?: unknown
}

export function webProjectFor(ctx: TargetContext): WebProject {
  const requested = ctx.run.options.webFramework ?? ctx.plan.uiFramework
  return {
    name: webPackageNameFor(ctx.spec.name),
    appName: ctx.spec.name,
    framework: supportedFramework(requested),
    screens: ctx.spec.screens.map((s) => ({ id: s.id, name: s.name })),
    rootScreen: ctx.spec.navigation.root,
    core: !!ctx.core,
  }
}

/** Scaffolds exist for vanilla, React, Vue, and Svelte; any other framework falls back to vanilla. */
export function supportedFramework(requested: string): WebFramework {
  if (/react/i.test(requested)) return 'react'
  if (/vue|nuxt/i.test(requested)) return 'vue'
  if (/svelte/i.test(requested)) return 'svelte'
  return 'vanilla'
}

/** tsc (`src/x.ts(12,5): error TS2304: msg`) and Vite/esbuild (`src/x.ts:12:5: ERROR: msg`) diagnostics. */
export function parseWebBuildOutput(output: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const seen = new Set<string>()
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '')
    let m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line)
    if (m) {
      const key = `${m[1]}:${m[2]}:${m[6]}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({
          severity: m[4] === 'error' ? 'error' : 'warning',
          file: m[1]!,
          line: Number(m[2]),
          column: Number(m[3]),
          code: m[5],
          message: m[6]!.trim(),
          tool: 'tsc',
        })
      }
      continue
    }
    m = /^(?:✘ \[ERROR\]|ERROR:|error:)\s*(.*)$/.exec(line.trim())
    if (m && !seen.has(m[1]!)) {
      seen.add(m[1]!)
      out.push({ severity: 'error', message: m[1]!.trim(), tool: 'vite' })
      continue
    }
    m = /^\s*(src\/[^\s:]+):(\d+):(\d+):?\s*(?:ERROR:)?\s*(.*)$/.exec(line)
    if (m && !seen.has(line)) {
      seen.add(line)
      out.push({
        severity: 'error',
        file: m[1]!,
        line: Number(m[2]),
        column: Number(m[3]),
        message: m[4]!.trim(),
        tool: 'vite',
      })
    }
  }
  if (!out.some((d) => d.severity === 'error') && /error|failed/i.test(output)) {
    out.push({
      severity: 'error',
      message: `build failed: ${output.trim().split('\n').slice(-8).join(' ').replace(/\s+/g, ' ').slice(0, 800)}`,
      tool: 'npm',
    })
  }
  return out
}

export const webTarget: TargetAdapter = {
  id: 'web-vite',
  target: 'web',

  bashAllow: [
    /^npm (run|test|install|ci|ls)\b/,
    /^npx (vite|vitest|tsc)\b/,
    /^node\b/,
    /^(ls|cat|head|tail|wc|find|tree|grep|rg|mkdir|touch|mv|cp|rm)\b/,
    /^git (status|diff|log|ls-files)\b/,
  ],

  async available(config, env) {
    if (!(await which('npm', env))) return { ok: false, reason: 'npm not found', env }
    return { ok: true, env }
  },

  async scaffold(ctx) {
    const project = webProjectFor(ctx)
    const files = webFiles(project)
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(ctx.workspace, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    const embedded = ctx.core ? writeCoreEmbed(ctx.workspace, ctx.core, webCoreEmbed(ctx.core)) : []
    if (embedded.length) ctx.log(`embedded the shared core (${embedded.length} files)`)
    ctx.log(
      `scaffolded ${Object.keys(files).length} files (${project.framework}); installing dependencies`,
    )
    const install = await runProcess({
      command: 'npm',
      args: ['install', '--no-audit', '--no-fund', '--loglevel=error'],
      cwd: ctx.workspace,
      env: ctx.env,
      timeoutMs: 10 * 60_000,
      signal: ctx.signal,
      onStdout: ctx.onOutput,
      onStderr: ctx.onOutput,
    })
    if (install.exitCode !== 0) throw new Error(`npm install failed: ${install.stderr.slice(-800)}`)
    return { files: [...Object.keys(files), ...embedded] }
  },

  workerPrompt(ctx) {
    const project = webProjectFor(ctx)
    const tags = ctx.spec.screens
      .map(
        (s) =>
          `- screen \`${s.id}\` (hash #/${s.id}): ${s.elements.map((e) => `\`${e.testId}\` (${e.kind}: ${e.label})`).join(', ') || 'no elements'}`,
      )
      .join('\n')
    return `${webFiles(project)['MPF.md']}
## Screens and required data-testid values
${tags}
${ctx.core ? `\n## Shared core\n${webCoreConventions(ctx.core)}\n` : ''}`
  },

  async build(ctx): Promise<BuildResult> {
    const r = await runProcess({
      command: 'npm',
      args: ['run', 'build', '--silent'],
      cwd: ctx.workspace,
      env: ctx.env,
      timeoutMs: 10 * 60_000,
      signal: ctx.signal,
      onStdout: ctx.onOutput,
      onStderr: ctx.onOutput,
    })
    const output = `${r.stdout}\n${r.stderr}`
    const ok = r.exitCode === 0 && existsSync(join(ctx.workspace, 'dist', 'index.html'))
    return {
      ok,
      diagnostics: ok ? [] : parseWebBuildOutput(output),
      product: ok ? 'dist' : undefined,
      durationMs: r.durationMs,
      logTail: output.slice(-4000),
    }
  },

  async unitTest(ctx): Promise<TestOutcome> {
    const report = join(ctx.workspace, 'test-results', 'junit.xml')
    mkdirSync(dirname(report), { recursive: true })
    const vitest = localBin(ctx.workspace, 'vitest') ?? 'npx'
    const args =
      vitest === 'npx'
        ? ['vitest', 'run', '--reporter=junit', `--outputFile=${report}`]
        : ['run', '--reporter=junit', `--outputFile=${report}`]
    const r = await runProcess({
      command: vitest,
      args,
      cwd: ctx.workspace,
      env: ctx.env,
      timeoutMs: 10 * 60_000,
      signal: ctx.signal,
      onStdout: ctx.onOutput,
      onStderr: ctx.onOutput,
    })
    const parsed = parseJUnitFile(report, 'unit')
    if (r.exitCode !== 0 && parsed.summary.total === 0) {
      return {
        kind: 'unit',
        status: 'error',
        cases: [
          {
            id: 'run',
            name: 'vitest',
            status: 'fail',
            durationMs: r.durationMs,
            message: (r.stderr || r.stdout).slice(-2000),
            artifacts: [],
          },
        ],
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, flaky: 0 },
      }
    }
    return parsed
  },

  async compileFlows(ctx): Promise<CompiledFlow[]> {
    const dir = join(ctx.workspace, 'flows')
    mkdirSync(dir, { recursive: true })
    return ctx.behaviors.behaviors.map((b) => {
      const rel = `flows/${b.id}.json`
      writeFileSync(join(ctx.workspace, rel), JSON.stringify(b, null, 2))
      const custom = b.steps.filter((s) => s.op === 'custom')
      return {
        behaviorId: b.id,
        path: rel,
        unverifiable: custom.length
          ? custom.map((s) => (s.op === 'custom' ? s.description : '')).join('; ')
          : undefined,
      }
    })
  },

  docs(ctx) {
    const project = webProjectFor(ctx)
    const appId = shippedWebPackageName(ctx.workspace) ?? {
      label: 'Package name',
      value: project.name,
    }
    return {
      build: 'npm install && npm run build   # type check + vite build into dist/',
      unitTest: 'npm test',
      e2e: 'npm run preview   # then drive the flows in flows/ against the printed URL',
      product: 'dist',
      notes: [
        `Vite + TypeScript${project.framework === 'react' ? ' + React' : project.framework === 'vue' ? ' + Vue 3' : project.framework === 'svelte' ? ' + Svelte 5' : ' (framework-free DOM code)'}; package \`${appId.value}\`${appId.file ? ` (from \`${appId.file}\`)` : ''}.`,
        'Every screen is a hash route named by its AppSpec id (`#/<screenId>`).',
        `Appending \`?${WEB_SEED_PARAM}=<json>\` seeds persisted state before the app starts; the end-to-end flows rely on it.`,
        '`data-testid` attributes equal the AppSpec test ids, which is what the flows match on.',
      ],
      shipped: {
        appId,
        groups: [
          {
            // src/ and public/ except test directories and *.test.* / *.spec.* files, which the next group takes
            title: 'App sources',
            pattern:
              /^(src|public)\/(?!(.*\/)?(tests?|__tests__)\/)(?!.*\.(test|spec)\.[cm]?[jt]sx?$)|^index\.html$/,
          },
          {
            title: 'Unit tests',
            pattern: /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/,
          },
          { title: 'End-to-end flows', pattern: /^flows\// },
        ],
        exclude: [
          /(^|\/)(node_modules|dist|\.vite|coverage|test-results|playwright-report|screenshots)(\/|$)/,
        ],
      },
    }
  },

  async e2e(ctx, flows): Promise<E2eResult> {
    const port = await findFreePort()
    const vite = localBin(ctx.workspace, 'vite') ?? 'npx'
    const args =
      vite === 'npx'
        ? ['vite', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1']
        : ['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1']
    // The scaffold routes every screen at `#/<screenId>` whatever the source app used.
    const targetSpec: AppSpec = {
      ...ctx.spec,
      screens: ctx.spec.screens.map((s) => ({ ...s, route: `#/${s.id}` })),
    }
    const server = await startDevServer({
      command: vite,
      args,
      cwd: ctx.workspace,
      env: ctx.env,
      port,
      signal: ctx.signal,
      timeoutMs: 60_000,
      onOutput: ctx.onOutput,
    })
    const shotsDir = join(ctx.workspace, 'screenshots')
    const screenshots: E2eResult['screenshots'] = []
    let browser
    try {
      browser = await launchChromium()
    } catch (err) {
      await server.stop()
      const reason = (err as Error).message
      return {
        launch: {
          kind: 'launch',
          status: 'skip',
          skipReason: reason,
          cases: [],
          summary: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
        },
        flows: {
          kind: 'e2e',
          status: 'skip',
          skipReason: reason,
          cases: [],
          summary: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
        },
        screenshots,
      }
    }
    try {
      // launch check: the root screen renders without page errors or console errors
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text()}`)
      })
      let launched = true
      try {
        await page.goto(server.url, { waitUntil: 'load', timeout: 30_000 })
        await page.waitForSelector('[data-testid="mpf-root"]', { timeout: 10_000 })
        await page.waitForTimeout(1000)
      } catch (err) {
        launched = false
        errors.push((err as Error).message.split('\n')[0] ?? 'launch failed')
      }
      await context.close()
      const launchOk = launched && errors.length === 0
      const launch: TestOutcome = {
        kind: 'launch',
        status: launchOk ? 'pass' : 'fail',
        cases: [
          {
            id: 'launch',
            name: 'root screen renders without errors',
            status: launchOk ? 'pass' : 'fail',
            durationMs: 1000,
            message: errors.slice(0, 5).join('\n') || undefined,
            artifacts: [],
          },
        ],
        summary: {
          total: 1,
          passed: launchOk ? 1 : 0,
          failed: launchOk ? 0 : 1,
          skipped: 0,
          flaky: 0,
        },
      }
      if (launched) {
        for (const s of await screenshotScreens(browser, server.url, targetSpec, shotsDir, ctx.log))
          screenshots.push({ screenId: s.screenId, file: `screenshots/${s.screenId}.png` })
      }
      const cases: TestOutcome['cases'] = []
      if (launched) {
        for (const f of flows) {
          const b = ctx.behaviors.behaviors.find((x) => x.id === f.behaviorId)
          if (!b) continue
          if (f.unverifiable && !f.path) {
            cases.push({
              id: b.id,
              name: b.title,
              behaviorId: b.id,
              status: 'skip',
              durationMs: 0,
              message: f.unverifiable,
              artifacts: [],
            })
            continue
          }
          const t0 = Date.now()
          const r = await executeBehavior(
            browser,
            server.url,
            targetSpec,
            b,
            join(shotsDir, 'behaviors', `${b.id}.png`),
            ctx.log,
          )
          cases.push({
            id: b.id,
            name: b.title,
            behaviorId: b.id,
            status: r.ok ? 'pass' : r.unverifiable ? 'skip' : 'fail',
            durationMs: Date.now() - t0,
            message: [r.error, ...(r.notes ?? [])].filter(Boolean).join('\n') || undefined,
            artifacts: [],
          })
          screenshots.push({ behaviorId: b.id, file: `screenshots/behaviors/${b.id}.png` })
        }
      }
      const passed = cases.filter((c) => c.status === 'pass').length
      const failed = cases.filter((c) => c.status === 'fail').length
      const skipped = cases.filter((c) => c.status === 'skip').length
      const e2e: TestOutcome = {
        kind: 'e2e',
        status: !launched ? 'skip' : failed ? 'fail' : passed ? 'pass' : 'skip',
        skipReason: launched ? undefined : 'app did not launch',
        cases,
        summary: { total: cases.length, passed, failed, skipped, flaky: 0 },
      }
      return { launch, flows: e2e, screenshots }
    } finally {
      await browser.close().catch(() => {})
      await server.stop()
    }
  },
}

export { WEB_SEED_PARAM }
