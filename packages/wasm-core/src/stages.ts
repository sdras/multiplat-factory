import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { z } from 'zod'
import {
  GoldenVectorsOutput,
  type AppSpec,
  type MpfConfig,
  type PortPlan,
  type TestResult,
} from '@mpf/core'
import {
  rustTools,
  hasWasmTarget,
  type RustTools,
  type StageContext,
  type StageOutcome,
  type StageRunner,
} from '@mpf/harness'
import { logicRunnerAllow } from '@mpf/adapters'
import { READ_ONLY_BASH, runWorker, workerFailure, type AgentFn, WRITE_BASH } from '@mpf/analyzer'
import { runAgent } from '@mpf/llm'
import { buildCoreWasm, testCore } from './cargo.ts'
import { loadCore } from './host.ts'
import {
  CORE_EXTRACT_SYSTEM,
  VECTORS_SYSTEM,
  coreExtractPrompt,
  coreFixPrompt,
  vectorsPrompt,
} from './prompts.ts'
import { coreFiles, manifestFor } from './template.ts'
import { sourceToolEnv } from './source-tools.ts'
import { readVectorSets, runVectors, writeVectorSets } from './vectors.ts'

export const CoreExtractResult = z.object({
  functions: z.array(z.string()).default([]),
  filesWritten: z.array(z.string()).default([]),
  vectorsAdded: z.number().int().nonnegative().default(0),
  notes: z.string().default(''),
})
export type CoreExtractResult = z.infer<typeof CoreExtractResult>

export interface CoreDeps {
  agent?: AgentFn
  /** Max fix rounds for a failing wasm build or failing vectors (default 3 and 2). */
  buildFixRounds?: number
  vectorFixRounds?: number
}

const CARGO_BASH: RegExp[] = [
  /^cargo\b/,
  /^rustup (show|target list)\b/,
  // `rustc --version` and `--print <thing>` (target lists, sysroot, cfg) are how a worker learns what it may build for.
  /^rustc --(version|print)\b/,
  /^rustfmt\b/,
]

function coreDir(ctx: StageContext): string {
  return join(ctx.run.runDir, 'core')
}

interface Gathered {
  spec: AppSpec
  plan: PortPlan
  dir: string
  sourceDir: string
}

function gather(ctx: StageContext): Gathered | StageOutcome {
  const spec = ctx.readJsonArtifact<AppSpec>('appspec')
  const plan = ctx.readJsonArtifact<PortPlan>('portplan')
  if (!spec || !plan)
    return {
      status: 'failed',
      retryable: false,
      error: { class: 'internal', message: 'appspec or portplan missing', diagnostics: [] },
    }
  if (!plan.core.enabled)
    return { status: 'skipped', reason: `no shared core for this run (${plan.core.rationale})` }
  if (!plan.core.functions.length)
    return { status: 'skipped', reason: 'the plan enabled a shared core but listed no functions' }
  return { spec, plan, dir: coreDir(ctx), sourceDir: join(ctx.run.runDir, 'source') }
}

/**
 * Glue every core worker may run regardless of the source platform: `node` (always present, the
 * factory runs on it) for reading and writing vector JSON. It never makes a vector `executed`;
 * only the source's own interpreter or a harness built from the source's files does.
 */
const GLUE_BASH = logicRunnerAllow('web')

/** The source platform's toolchain for a worker, layered over the env the stage already built. */
async function sourceEnv(g: Gathered, config: MpfConfig, base: NodeJS.ProcessEnv) {
  return sourceToolEnv(g.spec.source.platform, config, g.sourceDir, base)
}

/** A prompt section naming the tools the worker can run the source with, when there are any. */
const toolchainSection = (note: string): string => (note ? `\n\n# Toolchain\n${note}` : '')

function isOutcome(x: Gathered | StageOutcome): x is StageOutcome {
  return 'status' in x
}

async function tools(ctx: StageContext, config: MpfConfig): Promise<RustTools | StageOutcome> {
  const t = await rustTools(config, process.env)
  if (!t) return { status: 'skipped', reason: 'Rust toolchain not found (cargo); run `mpf doctor`' }
  if (!(await hasWasmTarget(t)))
    return {
      status: 'skipped',
      reason:
        'wasm32-unknown-unknown target not installed (rustup target add wasm32-unknown-unknown)',
    }
  ctx.log('debug', `cargo: ${t.cargo}`)
  return t
}

function isTools(x: RustTools | StageOutcome): x is RustTools {
  return 'cargo' in x
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

function coreSession(ctx: StageContext): string | undefined {
  return (
    ctx.store.getStage(ctx.run.id, 'core.extract')?.result as { sessionId?: string } | undefined
  )?.sessionId
}

/**
 * Scaffold the crate (green, ABI in place, one stub per planned function), then let a
 * worker port the logic into it. The build stage verifies; this stage only writes.
 */
export function coreExtractStage(config: MpfConfig, deps: CoreDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  return {
    async run(ctx): Promise<StageOutcome> {
      const g = gather(ctx)
      if (isOutcome(g)) return g
      const t = await tools(ctx, config)
      if (!isTools(t)) return t
      const files = coreFiles({ appName: g.spec.name, functions: g.plan.core.functions })
      // A rerun after a failed or out-of-budget attempt keeps the crate: the work in src/api and
      // vectors is worth more than a clean slate.
      const resuming = existsSync(join(g.dir, 'src', 'api', 'mod.rs'))
      if (resuming) {
        ctx.log('info', 'continuing from the crate a previous attempt left behind')
      } else {
        rmSync(g.dir, { recursive: true, force: true })
        mkdirSync(g.dir, { recursive: true })
        writeFiles(g.dir, files)
        ctx.log(
          'info',
          `scaffolded the core crate (${Object.keys(files).length} files, ${g.plan.core.functions.length} functions)`,
        )
      }
      // Prove the scaffold before spending on a worker (a partial port may not build yet; that is the worker's job).
      const first = await buildCoreWasm({ cwd: g.dir, tools: t, signal: ctx.signal })
      if (!first.ok && !resuming) {
        return {
          status: 'failed',
          retryable: false,
          error: {
            class: 'build-error',
            message: 'the core scaffold does not build; this is a factory bug, not the app',
            diagnostics: first.diagnostics,
          },
        }
      }
      ctx.log(
        'info',
        first.ok
          ? `crate builds (${(first.durationMs / 1000).toFixed(1)}s)`
          : `crate does not build yet (${first.diagnostics.length} diagnostics); the worker starts from there`,
      )
      const st = await sourceEnv(g, config, t.env)
      if (st.note) ctx.log('info', `source toolchain: ${st.note.split('. ')[0]}`)
      const worker = {
        role: 'generate' as const,
        effort: 'xhigh' as const,
        cwd: g.dir,
        readDirs: [g.sourceDir, ...st.readDirs],
        bashAllow: [
          ...CARGO_BASH,
          ...logicRunnerAllow(g.spec.source.platform),
          ...GLUE_BASH,
          ...WRITE_BASH,
          ...READ_ONLY_BASH,
        ],
        systemPrompt: `${CORE_EXTRACT_SYSTEM}${toolchainSection(st.note)}\n\n# Crate conventions\n${files['MPF.md']}`,
        outputSchema: CoreExtractResult,
        maxTurns: 150,
        env: st.env,
      }
      let result = await runWorker(
        ctx,
        {
          ...worker,
          budgetShare: 0.2,
          prompt: coreExtractPrompt({
            spec: g.spec,
            plan: g.plan,
            sourceDir: g.sourceDir,
            instructions: ctx.takeInstructions(),
            resuming,
          }),
        },
        agent,
      )
      let cost = result.costUsd
      // Extraction is the most expensive stage; one continuation with its own allowance beats losing the partial port.
      if (!result.ok && /budget/i.test(result.error ?? '') && result.sessionId) {
        ctx.log(
          'warn',
          'extraction ran out of its allowance; continuing the session once with a fresh one',
        )
        result = await runWorker(
          ctx,
          {
            ...worker,
            budgetShare: 0.15,
            resume: result.sessionId,
            prompt:
              'Continue where you left off: finish every manifest function, run `cargo build --release --target wasm32-unknown-unknown` and `cargo test` until both are green, then return the structured output.',
          },
          agent,
        )
        cost += result.costUsd
      }
      if (!result.ok)
        return { ...workerFailure(result, 'core extraction worker failed'), costUsd: cost }
      const summary = CoreExtractResult.parse(result.structured ?? {})
      writeFileSync(
        join(ctx.run.runDir, 'core-extract.json'),
        JSON.stringify({ ...summary, sessionId: result.sessionId }, null, 2),
      )
      ctx.addArtifact({
        kind: 'other',
        relPath: 'core-extract.json',
        meta: { kind: 'core-extract-summary' },
      })
      ctx.log(
        'info',
        `worker implemented ${summary.functions.length} functions, wrote ${summary.filesWritten.length} files, added ${summary.vectorsAdded} vectors`,
      )
      return {
        status: 'succeeded',
        costUsd: cost,
        result: { sessionId: result.sessionId, functions: summary.functions, notes: summary.notes },
      }
    },
  }
}

/**
 * Golden vectors. v1 derives them by reading the source with a worker (labeled `derived`);
 * vectors the extraction worker already wrote are kept and merged by id.
 */
export function coreVectorsStage(config: MpfConfig, deps: CoreDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  return {
    async run(ctx): Promise<StageOutcome> {
      const g = gather(ctx)
      if (isOutcome(g)) return g
      if (!existsSync(g.dir))
        return {
          status: 'failed',
          retryable: false,
          error: {
            class: 'internal',
            message: 'core crate missing; core.extract did not run',
            diagnostics: [],
          },
        }
      void config
      // The extraction worker records vectors by running the source when it can; when every
      // planned function already has executed vectors, another worker would only add cost.
      const already = readVectorSets(g.dir)
      const sized = g.plan.core.functions.every((f) => {
        const set = already.find((x) => x.function === f.name)
        return set && set.vectors.length >= 3
      })
      const allVectors = already.reduce((n, x) => n + x.vectors.length, 0)
      const executedShare =
        allVectors === 0
          ? 0
          : already.reduce(
              (n, x) => n + x.vectors.filter((v) => v.provenance === 'executed').length,
              0,
            ) / allVectors
      const derivedOnly = already
        .filter((x) => !x.vectors.some((v) => v.provenance === 'executed'))
        .map((x) => x.function)
      // Every function has a usable set, and either each one was executed or the set as a whole mostly was:
      // a top-up worker rarely adds more than it costs then (one burned $3 twice over a single function).
      const covered = sized && (derivedOnly.length === 0 || executedShare >= 0.5)
      if (covered) {
        if (derivedOnly.length)
          ctx.log('info', `derived-only functions kept as they are: ${derivedOnly.join(', ')}`)
        const total = already.reduce((n, x) => n + x.vectors.length, 0)
        const executed = already.reduce(
          (n, x) => n + x.vectors.filter((v) => v.provenance === 'executed').length,
          0,
        )
        for (const set of already)
          ctx.addArtifact({
            kind: 'golden-vectors',
            relPath: `core/vectors/${set.function.replace(/[^A-Za-z0-9_-]+/g, '_')}.json`,
            meta: { function: set.function },
          })
        ctx.log(
          'info',
          `extraction already recorded ${total} vectors for ${already.length} functions (${executed} executed${derivedOnly.length ? `, ${derivedOnly.length} function(s) derived-only` : ''}); nothing to derive`,
        )
        return {
          status: 'succeeded',
          result: {
            functions: already.length,
            vectors: total,
            notes: 'executed vectors from the extraction worker',
          },
        }
      }
      const st = await sourceEnv(g, config, process.env)
      const result = await runWorker(
        ctx,
        {
          role: 'generate',
          budgetShare: 0.05,
          cwd: g.sourceDir,
          readDirs: [g.dir, ...st.readDirs],
          bashAllow: [
            ...logicRunnerAllow(g.spec.source.platform),
            ...GLUE_BASH,
            ...WRITE_BASH,
            ...READ_ONLY_BASH,
          ],
          systemPrompt: `${VECTORS_SYSTEM}${toolchainSection(st.note)}`,
          env: st.env,
          prompt: vectorsPrompt({
            functions: g.plan.core.functions,
            spec: g.spec,
            sourceDir: g.sourceDir,
            instructions: ctx.takeInstructions(),
          }),
          outputSchema: GoldenVectorsOutput,
          maxTurns: 60,
        },
        agent,
      )
      if (!result.ok) {
        // A top-up worker that ran out (budget, turns) must not throw away vectors extraction already
        // recorded: when every planned function has at least one vector, the sets stand as they are.
        const have = new Map(readVectorSets(g.dir).map((s) => [s.function, s.vectors.length]))
        const missing = g.plan.core.functions.map((f) => f.name).filter((n) => !have.get(n))
        if (missing.length === 0) {
          const total = [...have.values()].reduce((n, c) => n + c, 0)
          ctx.log(
            'warn',
            `vectors worker failed (${result.error ?? 'unknown'}); keeping the ${total} vectors extraction recorded for all ${have.size} functions`,
          )
          return {
            status: 'succeeded',
            costUsd: result.costUsd,
            result: {
              functions: have.size,
              vectors: total,
              notes: 'worker failed; extraction vectors kept',
            },
          }
        }
        return workerFailure(result, 'vectors worker failed')
      }
      const out = GoldenVectorsOutput.parse(result.structured ?? { sets: [] })
      const existing = new Map(readVectorSets(g.dir).map((s) => [s.function, s]))
      const merged = out.sets.map((set) => {
        const prior = existing.get(set.function)
        if (!prior)
          return {
            ...set,
            vectors: set.vectors.map((v) => ({ ...v, provenance: 'derived' as const })),
          }
        const ids = new Set(prior.vectors.map((v) => v.id))
        return {
          function: set.function,
          vectors: [
            ...prior.vectors,
            ...set.vectors
              .filter((v) => !ids.has(v.id))
              .map((v) => ({ ...v, provenance: 'derived' as const })),
          ],
        }
      })
      for (const [name, set] of existing)
        if (!merged.some((m) => m.function === name)) merged.push(set)
      const files = writeVectorSets(g.dir, merged)
      const total = merged.reduce((n, s) => n + s.vectors.length, 0)
      for (const f of files)
        ctx.addArtifact({
          kind: 'golden-vectors',
          relPath: `core/${f}`,
          meta: { function: merged.find((m) => f.endsWith(`${m.function}.json`))?.function },
        })
      ctx.log('info', `${total} vectors across ${merged.length} functions (${files.join(', ')})`)
      return {
        status: 'succeeded',
        costUsd: result.costUsd,
        result: { functions: merged.length, vectors: total, notes: out.notes },
      }
    },
  }
}

/**
 * Build the module, run the vectors natively and through the Node host, and publish the
 * artifacts every target consumes. Failures go back to the extraction worker's session.
 */
export function coreBuildStage(config: MpfConfig, deps: CoreDeps = {}): StageRunner {
  const agent = deps.agent ?? runAgent
  const buildRounds = deps.buildFixRounds ?? 3
  const vectorRounds = deps.vectorFixRounds ?? 2
  return {
    async run(ctx): Promise<StageOutcome> {
      const g = gather(ctx)
      if (isOutcome(g)) return g
      const t = await tools(ctx, config)
      if (!isTools(t)) return t
      if (!existsSync(g.dir))
        return {
          status: 'failed',
          retryable: false,
          error: {
            class: 'internal',
            message: 'core crate missing; core.extract did not run',
            diagnostics: [],
          },
        }
      const procId = `${ctx.stage.id}-proc`
      const onOutput = (chunk: string) => ctx.emit({ type: 'proc.stdout', procId, chunk })
      let cost = 0
      let session = coreSession(ctx)
      const fix = async (
        kind: 'build' | 'vectors',
        detail: string[],
        round: number,
        max: number,
      ): Promise<StageOutcome | undefined> => {
        const st = await sourceEnv(g, config, t.env)
        const r = await runWorker(
          ctx,
          {
            role: 'generate',
            budgetShare: 0.1,
            cwd: g.dir,
            readDirs: [g.sourceDir, ...st.readDirs],
            bashAllow: [
              ...CARGO_BASH,
              ...logicRunnerAllow(g.spec.source.platform),
              ...GLUE_BASH,
              ...READ_ONLY_BASH,
            ],
            systemPrompt: `${CORE_EXTRACT_SYSTEM}${toolchainSection(st.note)}`,
            prompt: coreFixPrompt(kind, detail, round, max),
            outputSchema: CoreExtractResult,
            maxTurns: 100,
            resume: session,
            env: st.env,
          },
          agent,
        )
        cost += r.costUsd
        if (!r.ok) return { ...workerFailure(r, 'core fix worker failed'), costUsd: cost }
        session = r.sessionId ?? session
        return undefined
      }

      let build = await buildCoreWasm({ cwd: g.dir, tools: t, signal: ctx.signal, onOutput })
      for (let round = 1; !build.ok && round <= buildRounds; round++) {
        ctx.log(
          'warn',
          `wasm build failed with ${build.diagnostics.length} diagnostics; fix round ${round}/${buildRounds}`,
        )
        const failed = await fix(
          'build',
          build.diagnostics.map(
            (d) => `${d.severity} ${d.file ?? ''}${d.line ? `:${d.line}` : ''} ${d.message}`,
          ),
          round,
          buildRounds,
        )
        if (failed) return failed
        build = await buildCoreWasm({ cwd: g.dir, tools: t, signal: ctx.signal, onOutput })
      }
      if (!build.ok)
        return {
          status: 'failed',
          retryable: false,
          costUsd: cost,
          error: {
            class: 'build-error',
            message: 'the core does not build for wasm32',
            diagnostics: build.diagnostics,
          },
        }
      ctx.emit({ type: 'build.result', ok: true, errors: 0, warnings: 0 })

      let test = await testCore({ cwd: g.dir, tools: t, signal: ctx.signal, onOutput })
      for (let round = 1; !test.ok && round <= vectorRounds; round++) {
        ctx.log(
          'warn',
          `${test.failures.length || 'some'} vectors failed; fix round ${round}/${vectorRounds}`,
        )
        const failed = await fix(
          'vectors',
          test.failures.length ? test.failures : test.diagnostics.map((d) => d.message),
          round,
          vectorRounds,
        )
        if (failed) return failed
        build = await buildCoreWasm({ cwd: g.dir, tools: t, signal: ctx.signal, onOutput })
        if (!build.ok)
          return {
            status: 'failed',
            retryable: false,
            costUsd: cost,
            error: {
              class: 'build-error',
              message: 'the core stopped building after a vector fix',
              diagnostics: build.diagnostics,
            },
          }
        test = await testCore({ cwd: g.dir, tools: t, signal: ctx.signal, onOutput })
      }

      const sets = readVectorSets(g.dir)
      const total = sets.reduce((n, s) => n + s.vectors.length, 0)
      const rustResult: TestResult = {
        stageId: ctx.stage.id,
        kind: 'parity',
        target: 'core',
        status: test.ok ? 'pass' : 'fail',
        cases: test.ok
          ? sets.flatMap((s) =>
              s.vectors.map((v) => ({
                id: `${s.function}/${v.id}`,
                name: `${s.function} ${v.id}`,
                vectorId: v.id,
                status: 'pass' as const,
                durationMs: 0,
                artifacts: [],
              })),
            )
          : test.failures.map((f) => ({
              id: f.split(':')[0]!,
              name: f.split(':')[0]!,
              vectorId: f.split(':')[0]!.split('/')[1],
              status: 'fail' as const,
              durationMs: test.durationMs,
              message: f,
              artifacts: [],
            })),
        summary: {
          total: test.ok ? total : test.failures.length,
          passed: test.ok ? total : 0,
          failed: test.ok ? 0 : test.failures.length,
          skipped: 0,
          flaky: 0,
        },
      }
      ctx.emit({ type: 'test.result', result: rustResult })

      // Node host over the real module: proves the ABI and gives the web target its parity baseline.
      const wasmRel = `core/${build.wasm}`
      const bytes = readFileSync(join(ctx.run.runDir, wasmRel))
      const core = await loadCore(bytes)
      const nodeReport = runVectors(core, sets, 'node')
      writeFileSync(join(g.dir, 'manifest.json'), `${JSON.stringify(core.manifest, null, 2)}\n`)
      writeFileSync(join(g.dir, 'parity-node.json'), `${JSON.stringify(nodeReport, null, 2)}\n`)
      ctx.addArtifact({
        kind: 'wasm-module',
        relPath: wasmRel,
        mime: 'application/wasm',
        meta: { bytes: bytes.length, functions: core.manifest.functions.map((f) => f.name) },
      })
      ctx.addArtifact({ kind: 'core-manifest', relPath: 'core/manifest.json' })
      ctx.addArtifact({
        kind: 'parity-report',
        relPath: 'core/parity-node.json',
        meta: { host: 'node' },
      })
      ctx.emit({
        type: 'test.result',
        result: {
          stageId: ctx.stage.id,
          kind: 'parity',
          target: 'web',
          status: nodeReport.summary.failed ? 'fail' : 'pass',
          cases: nodeReport.cases.map((c) => ({
            id: `${c.function}/${c.vectorId}`,
            name: `${c.function} ${c.vectorId}`,
            vectorId: c.vectorId,
            status: c.status === 'pass' ? 'pass' : 'fail',
            durationMs: 0,
            message: c.message,
            artifacts: [],
          })),
          summary: {
            total: nodeReport.summary.total,
            passed: nodeReport.summary.passed,
            failed: nodeReport.summary.failed,
            skipped: 0,
            flaky: 0,
          },
        },
      })
      ctx.log(
        'info',
        `core built: ${(bytes.length / 1024).toFixed(1)} KiB, ${core.manifest.functions.length} functions; vectors rust ${rustResult.summary.passed}/${rustResult.summary.total}, node ${nodeReport.summary.passed}/${nodeReport.summary.total}`,
      )
      if (!test.ok)
        return {
          status: 'failed',
          retryable: false,
          costUsd: cost,
          error: {
            class: 'test-failure',
            message: `${test.failures.length} golden vectors still fail after ${vectorRounds} fix rounds`,
            diagnostics: [],
          },
        }
      if (nodeReport.summary.failed)
        return {
          status: 'failed',
          retryable: false,
          costUsd: cost,
          error: {
            class: 'test-failure',
            message: `${nodeReport.summary.failed} vectors fail through the WebAssembly host although cargo test passes (ABI or serialization difference)`,
            diagnostics: [],
          },
        }
      return {
        status: 'succeeded',
        costUsd: cost,
        result: {
          wasm: wasmRel,
          bytes: bytes.length,
          functions: core.manifest.functions.length,
          vectors: total,
          manifest: manifestFor({ appName: g.spec.name, functions: g.plan.core.functions })
            .functions.length,
        },
      }
    },
  }
}
