import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'pathe'
import type { AnalysisHints, Detection } from '@mpf/core'
import { runProcess, type StageContext, type StageOutcome, type StageRunner } from '@mpf/harness'
import { detectSource, getSourceAdapter } from '@mpf/adapters'

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  'DerivedData',
  '.gradle',
  'target',
  'coverage',
  '.turbo',
  '.cache',
  'Pods',
  '.dart_tool',
  '.idea',
])

export interface DetectionArtifact {
  best: Detection
  all: Detection[]
  hints: AnalysisHints
  commit?: string
}

/**
 * Copies or clones the source into the run directory, detects its platform and
 * framework through the adapter registry, and records the result.
 */
export function ingestStage(): StageRunner {
  return {
    async run(ctx: StageContext): Promise<StageOutcome> {
      const dest = join(ctx.run.runDir, 'source')
      const locator = ctx.run.source.locator
      let commit: string | undefined
      try {
        if (/^(https?:\/\/|git@)/.test(locator)) {
          commit = await clone(ctx, locator, dest, ctx.run.source.commit)
        } else {
          if (!existsSync(locator) || !statSync(locator).isDirectory()) {
            return fail(`source path does not exist or is not a directory: ${locator}`)
          }
          ctx.log('info', `copying ${locator} -> source/ (build folders excluded)`)
          mkdirSync(dest, { recursive: true })
          cpSync(locator, dest, { recursive: true, filter: (src) => !SKIP.has(basename(src)) })
          commit = await headCommit(locator)
        }
      } catch (err) {
        return fail(`could not obtain the source: ${(err as Error).message}`)
      }

      const result = await detectSource(dest)
      if (!result.best) {
        return fail(
          'no adapter recognizes this project; supported sources are web apps (package.json or index.html), Xcode/SwiftPM projects, and Gradle Android projects',
        )
      }
      if (!result.best.supported) {
        return fail(
          result.best.unsupportedReason ?? `${result.best.framework} sources are not supported yet`,
        )
      }
      if (result.ambiguous) {
        ctx.log(
          'warn',
          `detection is ambiguous: ${result.all
            .slice(0, 3)
            .map((d) => `${d.adapterId} (${d.score})`)
            .join(', ')}; using ${result.best.adapterId}`,
        )
      }
      const adapter = getSourceAdapter(result.best.adapterId)
      const hints: AnalysisHints = (await adapter?.hints?.(result.ctx, result.best)) ?? {
        framework: result.best.framework,
        entryFiles: [result.best.entry],
        routeHints: [],
        stateHints: [],
        testHooks: [],
        persistenceHints: [],
        integrationHints: [],
        notes: [],
      }
      const artifact: DetectionArtifact = { best: result.best, all: result.all, hints, commit }
      writeFileSync(join(ctx.run.runDir, 'detection.json'), JSON.stringify(artifact, null, 2))
      ctx.addArtifact({ kind: 'detection', relPath: 'detection.json' })
      ctx.updateRun({
        source: {
          ...ctx.run.source,
          commit: commit ?? ctx.run.source.commit,
          platform: result.best.platform,
          framework: result.best.framework,
          language: result.best.language,
          adapterId: result.best.adapterId,
        },
      })
      ctx.log(
        'info',
        `detected ${result.best.platform} / ${result.best.framework} (${result.best.language}) via ${result.best.adapterId}`,
      )
      return {
        status: 'succeeded',
        result: {
          adapterId: result.best.adapterId,
          platform: result.best.platform,
          framework: result.best.framework,
          files: result.ctx.files.length,
        },
      }
    },
  }
}

function fail(message: string): StageOutcome {
  return {
    status: 'failed',
    retryable: false,
    error: { class: 'unsupported-source', message, diagnostics: [] },
  }
}

async function clone(
  ctx: StageContext,
  url: string,
  dest: string,
  commit?: string,
): Promise<string | undefined> {
  ctx.log('info', `cloning ${url}`)
  const args = commit
    ? ['clone', '--quiet', url, dest]
    : ['clone', '--quiet', '--depth', '1', url, dest]
  const r = await runProcess({ command: 'git', args, timeoutMs: 10 * 60_000, signal: ctx.signal })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git clone exited ${r.exitCode}`)
  if (commit) {
    const co = await runProcess({
      command: 'git',
      args: ['checkout', '--quiet', commit],
      cwd: dest,
      timeoutMs: 60_000,
    })
    if (co.exitCode !== 0) throw new Error(`git checkout ${commit}: ${co.stderr.trim()}`)
  }
  return headCommit(dest)
}

async function headCommit(dir: string): Promise<string | undefined> {
  const r = await runProcess({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: dir,
    timeoutMs: 10_000,
  })
  return r.exitCode === 0 ? r.stdout.trim() : undefined
}
