import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'pathe'
import {
  CreateRunInput,
  Run,
  RunOptions,
  newId,
  nowIso,
  runDir as runDirFor,
  ensureDir,
  mpfHome,
  type Artifact,
  type EventPayload,
  type MpfConfig,
  type RunEventBus,
  type RunStore,
  type Stage,
} from '@mpf/core'
import {
  Lanes,
  acquireLaneLock,
  type StageContext,
  type StageOutcome,
  type StageRunnerRegistry,
} from '@mpf/harness'
import { buildStageGraph } from './graph.ts'
import {
  UNREACHABLE,
  deriveRunStatus,
  readyStages,
  transition,
  unreachableStages,
} from './machine.ts'

export interface OrchestratorOptions {
  store: RunStore
  bus: RunEventBus
  config: MpfConfig
  /** Stage runners, or a resolver so fake and real runs can use different registries. */
  registry: StageRunnerRegistry | ((run: Run) => StageRunnerRegistry)
  /** Max stages executing at once (LLM workers). Defaults to config.concurrency.agents. */
  concurrency?: number
  /** Override the data directory (tests). */
  dataDir?: string
}

interface Live {
  controllers: Map<string, AbortController>
  instructions: Map<string, string[]>
  humanChoice: Map<string, string>
  loop?: Promise<void>
  wake?: () => void
  /** Cost already charged to a running stage through ctx.chargeCost, by stage id. */
  charged: Map<string, number>
}

const SETTLED_RUN = new Set([
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'waiting_human',
  'paused',
])
const MIME_BY_EXT: Record<string, string> = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
}

/**
 * Deterministic scheduler. Picks ready stages, runs them through the registry,
 * records outcomes, and derives run status. LLMs never touch control flow.
 */
export class Orchestrator {
  private live = new Map<string, Live>()
  private lanes: Lanes

  constructor(private opts: OrchestratorOptions) {
    // The device lanes lock files under the data directory the runs live in, so another process
    // (a second CLI, a script next to the daemon) waits for the simulator instead of sharing it.
    this.lanes = new Lanes(opts.config.concurrency.lanes, { dataDir: opts.dataDir ?? mpfHome() })
  }

  get store(): RunStore {
    return this.opts.store
  }

  registryFor(run: Run): StageRunnerRegistry {
    return typeof this.opts.registry === 'function' ? this.opts.registry(run) : this.opts.registry
  }

  createRun(input: CreateRunInput): Run {
    const parsed = CreateRunInput.parse(input)
    const id = newId()
    const ts = nowIso()
    const options = RunOptions.parse({
      ...parsed.options,
      budgetUsd: parsed.options?.budgetUsd ?? this.opts.config.budget.defaultUsd,
      models: { ...this.opts.config.models, ...parsed.options?.models },
    })
    const dir = runDirFor(id, this.opts.dataDir)
    const run = Run.parse({
      id,
      createdAt: ts,
      updatedAt: ts,
      status: 'queued',
      source: parsed.source,
      targets: parsed.targets,
      options,
      runDir: dir,
      costUsd: 0,
    })
    ensureDir(dir)
    this.opts.store.createRun(run)
    for (const s of buildStageGraph(run)) this.opts.store.upsertStage(s)
    this.emitRun(run)
    for (const s of this.opts.store.listStages(id)) this.emitStage(s)
    return run
  }

  /** Starts (or resumes) the scheduling loop. Resolves when the run settles (terminal, paused, or waiting). */
  start(runId: string): Promise<void> {
    const live = this.ensureLive(runId)
    if (live.loop) {
      live.wake?.()
      return live.loop
    }
    // The loop promise is in place before anything is awaited, so a second start in this process
    // joins it instead of racing for the run's driver lock.
    live.loop = this.drive(runId, live).finally(() => {
      live.loop = undefined
    })
    return live.loop
  }

  /** Hold the run's driver lock, requeue stages a dead process left behind, and run the loop. */
  private async drive(runId: string, live: Live): Promise<void> {
    // One driver per run across processes: the daemon and a CLI driver share the store, and two
    // schedulers on one run would requeue each other's stages and run them twice.
    let releaseDriver: () => void
    try {
      releaseDriver = await acquireLaneLock(`run-${runId}`, {
        dir: join(this.opts.dataDir ?? mpfHome(), 'locks'),
        maxWaitMs: 1,
        pollMs: 1,
        log: () => {},
      })
    } catch (err) {
      const holder = /: (.*)$/.exec((err as Error).message)?.[1] ?? 'another process'
      throw new Error(
        `run ${runId} is already being driven by another process (${holder}); stop it before resuming or re-running the run here`,
        { cause: err },
      )
    }
    try {
      const run = this.mustRun(runId)
      if (run.status === 'queued') this.setRunStatus(runId, 'running')
      // A stage left `running` by a process that stopped (a crash, a kill, a restart) belongs to nobody
      // now: put it back in the queue with its attempt count intact so the loop can run it again.
      const at = nowIso()
      for (const s of this.opts.store.listStages(runId)) {
        if (s.status === 'running' && !live.controllers.has(s.id)) {
          const next = transition(s, { type: 'requeue', at })
          this.opts.store.upsertStage(next)
          this.emitStage(next)
          this.emit(runId, s.id, {
            type: 'log',
            level: 'warn',
            message: `${s.id} was interrupted by a stopped process; requeued (attempt ${s.attempt} stays counted)`,
          })
        }
      }
      await this.loop(runId, live)
    } finally {
      releaseDriver()
    }
  }

  /** Parks running and queued stages, aborts their workers, and marks the run paused. */
  pause(runId: string, reason = 'paused by user'): void {
    const live = this.ensureLive(runId)
    const at = nowIso()
    for (const s of this.opts.store.listStages(runId)) {
      if (s.status === 'running' || s.status === 'queued') {
        const next = transition(s, { type: 'pause', at })
        this.opts.store.upsertStage(next)
        this.emitStage(next)
      }
    }
    this.setRunStatus(runId, 'paused')
    for (const c of live.controllers.values()) c.abort('paused')
    this.emit(runId, undefined, { type: 'control', action: 'pause', payload: { reason } })
    live.wake?.()
  }

  resume(runId: string): Promise<void> {
    const run = this.mustRun(runId)
    if (run.status !== 'paused') return this.start(runId)
    const at = nowIso()
    for (const s of this.opts.store.listStages(runId)) {
      if (s.status === 'paused') {
        const next = transition(s, { type: 'requeue', at })
        this.opts.store.upsertStage(next)
        this.emitStage(next)
      }
    }
    const stoppedThere =
      run.options.until &&
      this.opts.store
        .listStages(runId)
        .some((s) => s.kind === run.options.until && s.status === 'succeeded')
    if (stoppedThere) {
      // resuming past a `--until` stop clears the stop so the run can finish; a newly requested later stop stays
      this.opts.store.updateRun({
        ...run,
        options: { ...run.options, until: undefined },
        updatedAt: at,
      })
    }
    this.setRunStatus(runId, 'running')
    this.emit(runId, undefined, { type: 'control', action: 'resume', payload: {} })
    return this.start(runId)
  }

  cancel(runId: string): void {
    const live = this.ensureLive(runId)
    const at = nowIso()
    for (const s of this.opts.store.listStages(runId)) {
      if (!['succeeded', 'skipped', 'cancelled', 'blocked'].includes(s.status)) {
        const next = transition(s, { type: 'cancel', at })
        this.opts.store.upsertStage(next)
        this.emitStage(next)
      }
    }
    for (const c of live.controllers.values()) c.abort('cancelled')
    this.setRunStatus(runId, 'cancelled')
    this.emit(runId, undefined, { type: 'control', action: 'cancel', payload: {} })
    live.wake?.()
  }

  /** Answer a waiting_human stage. `choice` is one of the ids the stage offered; 'reject' cancels the run. */
  answer(runId: string, stageId: string, choice: string, note?: string): Promise<void> {
    const live = this.ensureLive(runId)
    const stage = this.opts.store.getStage(runId, stageId)
    if (!stage || stage.status !== 'waiting_human')
      throw new Error(`stage ${stageId} is not waiting`)
    if (note) this.instruct(runId, stageId, note)
    this.emit(runId, stageId, {
      type: 'control',
      action: choice === 'reject' ? 'reject' : 'approve',
      payload: { choice, note },
    })
    if (choice === 'reject') {
      this.cancel(runId)
      return Promise.resolve()
    }
    live.humanChoice.set(stageId, choice)
    const queued = transition(stage, { type: 'requeue', at: nowIso() })
    this.opts.store.upsertStage(queued)
    this.emitStage(queued)
    this.setRunStatus(runId, 'running')
    return this.start(runId)
  }

  instruct(runId: string, stageId: string, text: string): void {
    const live = this.ensureLive(runId)
    const list = live.instructions.get(stageId) ?? []
    list.push(text)
    live.instructions.set(stageId, list)
    this.emit(runId, stageId, { type: 'control', action: 'instruct', payload: { text } })
  }

  /** Re-run one stage and everything downstream of it. */
  rerun(runId: string, stageId: string): Promise<void> {
    const stages = this.opts.store.listStages(runId)
    const downstream = new Set<string>([stageId])
    let grew = true
    while (grew) {
      grew = false
      for (const s of stages) {
        if (!downstream.has(s.id) && s.dependsOn.some((d) => downstream.has(d))) {
          downstream.add(s.id)
          grew = true
        }
      }
    }
    for (const s of stages) {
      if (!downstream.has(s.id)) continue
      const reset: Stage = {
        ...s,
        status: 'pending',
        endedAt: undefined,
        error: undefined,
        skipReason: undefined,
      }
      this.opts.store.upsertStage(reset)
      this.emitStage(reset)
    }
    this.emit(runId, stageId, { type: 'control', action: 'rerun', payload: {} })
    this.setRunStatus(runId, 'running')
    return this.start(runId)
  }

  // ---- internals ----

  private ensureLive(runId: string): Live {
    let live = this.live.get(runId)
    if (!live) {
      live = {
        controllers: new Map(),
        instructions: new Map(),
        humanChoice: new Map(),
        charged: new Map(),
      }
      this.live.set(runId, live)
    }
    return live
  }

  private async loop(runId: string, live: Live): Promise<void> {
    const concurrency = this.opts.concurrency ?? this.opts.config.concurrency.agents
    const inFlight = new Map<string, Promise<void>>()
    for (;;) {
      const run = this.mustRun(runId)
      if (run.status === 'cancelled' || run.status === 'paused') {
        await Promise.allSettled(inFlight.values())
        this.refreshRunStatus(runId)
        return
      }
      // Propagate unreachability to a fixpoint: a skipped-unreachable stage makes its dependents unreachable too.
      for (;;) {
        const unreachable = unreachableStages(this.opts.store.listStages(runId))
        if (!unreachable.length) break
        for (const s of unreachable) {
          const next = transition(s, {
            type: 'skip',
            at: nowIso(),
            reason: `${UNREACHABLE} ${s.dependsOn.join(', ')} did not complete`,
          })
          this.opts.store.upsertStage(next)
          this.emitStage(next)
        }
      }
      const ready = readyStages(this.opts.store.listStages(runId)).filter(
        (s) => !inFlight.has(s.id),
      )
      while (ready.length && inFlight.size < concurrency) {
        const stage = ready.shift()!
        const p = this.execute(runId, stage, live).finally(() => {
          inFlight.delete(stage.id)
          live.wake?.()
        })
        inFlight.set(stage.id, p)
      }
      const status = this.refreshRunStatus(runId)
      if (inFlight.size === 0) {
        if (SETTLED_RUN.has(status)) return
        this.log(
          runId,
          undefined,
          'error',
          'no runnable stages and the run is not settled; stopping',
        )
        return
      }
      await new Promise<void>((resolve) => {
        live.wake = resolve
      })
      live.wake = undefined
    }
  }

  private async execute(runId: string, stage: Stage, live: Live): Promise<void> {
    const run = this.mustRun(runId)
    const runner = this.registryFor(run)[stage.kind]
    const at = nowIso()
    if (!runner) {
      const blocked: Stage = {
        ...stage,
        status: 'blocked',
        endedAt: at,
        error: {
          class: 'internal',
          message: `no runner for stage kind "${stage.kind}" in this build`,
          diagnostics: [],
        },
      }
      this.opts.store.upsertStage(blocked)
      this.emitStage(blocked)
      return
    }
    const controller = new AbortController()
    live.controllers.set(stage.id, controller)
    const started = transition(stage, { type: 'start', at })
    this.opts.store.upsertStage(started)
    this.emitStage(started)

    const humanChoice = live.humanChoice.get(stage.id)
    live.humanChoice.delete(stage.id)
    const ctx = this.contextFor(run, started, live, controller.signal, humanChoice)

    let outcome: StageOutcome
    try {
      outcome = await runner.run(ctx)
    } catch (err) {
      outcome = {
        status: 'failed',
        error: {
          class: 'internal',
          message: (err as Error).message ?? String(err),
          diagnostics: [],
        },
      }
    } finally {
      live.controllers.delete(stage.id)
    }

    const current = this.opts.store.getStage(runId, stage.id) ?? started
    const charged = live.charged.get(stage.id) ?? 0
    live.charged.delete(stage.id)
    if (current.status !== 'running') return // paused or cancelled while running
    const end = nowIso()
    // Whatever the stage charged as it went is already on the stage and the run.
    const extra =
      outcome.status === 'skipped' ? 0 : Math.max(0, round((outcome.costUsd ?? 0) - charged))
    let next: Stage
    switch (outcome.status) {
      case 'succeeded':
        next = transition(current, {
          type: 'succeed',
          at: end,
          result: outcome.result,
          costUsd: extra,
        })
        break
      case 'skipped':
        next = { ...current, status: 'skipped', endedAt: end, skipReason: outcome.reason }
        break
      case 'waiting_human':
        next = transition(current, { type: 'wait_human', at: end })
        this.emit(runId, stage.id, {
          type: 'human.required',
          reason: outcome.reason,
          choices: outcome.choices,
        })
        break
      case 'failed':
        if (outcome.retryable === false) {
          next = {
            ...current,
            status: 'blocked',
            endedAt: end,
            error: outcome.error,
            costUsd: round(current.costUsd + extra),
          }
          this.log(runId, stage.id, 'error', `blocked: ${outcome.error.message}`)
          break
        }
        next = transition(current, { type: 'fail', at: end, error: outcome.error, costUsd: extra })
        if (next.status === 'failed') {
          this.log(
            runId,
            stage.id,
            'warn',
            `attempt ${next.attempt}/${next.maxAttempts} failed: ${outcome.error.message}`,
          )
          next = transition(next, { type: 'requeue', at: end })
        } else {
          this.log(
            runId,
            stage.id,
            'error',
            `blocked after ${next.attempt} attempts: ${outcome.error.message}`,
          )
        }
        break
    }
    this.opts.store.upsertStage(next)
    this.emitStage(next)

    if (extra > 0 && this.addRunCost(runId, stage.id, extra, end)) return
    if (
      next.status === 'succeeded' &&
      stage.kind === 'fix' &&
      stage.target &&
      (next.result as { rerun?: boolean } | undefined)?.rerun
    ) {
      // a fix loop iteration: build, test, critique, and fix run again for this target (attempt counters carry on)
      for (const id of [
        ...(['build', 'test', 'critique', 'fix'] as const).map((k) => `${k}:${stage.target}`),
        'report',
      ]) {
        const s = this.opts.store.getStage(runId, id)
        if (!s) continue
        const reset: Stage = {
          ...s,
          status: 'pending',
          endedAt: undefined,
          error: undefined,
          skipReason: undefined,
        }
        this.opts.store.upsertStage(reset)
        this.emitStage(reset)
      }
      this.log(
        runId,
        stage.id,
        'info',
        `fix round ${(next.result as { round?: number }).round ?? '?'} applied; rebuilding ${stage.target}`,
      )
    }
    if (next.status === 'succeeded' && run.options.until && stage.kind === run.options.until) {
      // A stop after the last stage is no stop at all: let the run settle to its real outcome.
      const remaining = this.opts.store
        .listStages(runId)
        .some((s) => !['succeeded', 'skipped', 'cancelled', 'blocked'].includes(s.status))
      if (remaining) {
        this.log(
          runId,
          stage.id,
          'info',
          `stopped after "${stage.kind}" as requested; resume to continue`,
        )
        this.pause(runId, `stopped after ${stage.kind}`)
      }
    }
  }

  /** Add to the run's total, announce it, and pause when the budget is reached. Returns true when paused. */
  private addRunCost(runId: string, stageId: string, usd: number, at = nowIso()): boolean {
    const fresh = this.mustRun(runId)
    const updated = { ...fresh, costUsd: round(fresh.costUsd + usd), updatedAt: at }
    this.opts.store.updateRun(updated)
    this.emit(runId, stageId, {
      type: 'cost.update',
      stageCostUsd: usd,
      runCostUsd: updated.costUsd,
    })
    if (updated.costUsd >= fresh.options.budgetUsd) {
      this.log(runId, stageId, 'warn', `budget of $${fresh.options.budgetUsd} reached; pausing`)
      this.pause(runId, 'budget exhausted')
      return true
    }
    return false
  }

  private contextFor(
    run: Run,
    stage: Stage,
    live: Live,
    signal: AbortSignal,
    humanChoice?: string,
  ): StageContext {
    const runId = run.id
    return {
      run,
      stage,
      store: this.opts.store,
      bus: this.opts.bus,
      config: this.opts.config,
      lanes: this.lanes.withLog((message) => this.log(runId, stage.id, 'info', message)),
      signal,
      humanChoice,
      emit: (payload) => this.emit(runId, stage.id, payload),
      log: (level, message) => this.log(runId, stage.id, level, message),
      takeInstructions: () => {
        const list = live.instructions.get(stage.id) ?? []
        live.instructions.set(stage.id, [])
        return [
          ...run.options.revisionInstructions
            .filter((i) => i.stageId === stage.id || i.stageId === '*')
            .map((i) => i.text),
          ...list,
        ]
      },
      addArtifact: (input) => {
        const abs = join(run.runDir, input.relPath)
        const stat = existsSync(abs) ? statSync(abs) : undefined
        const isFile = stat?.isFile() ?? false
        const ext = input.relPath.slice(input.relPath.lastIndexOf('.'))
        const artifact: Artifact = {
          id: newId(),
          runId,
          stageId: stage.id,
          kind: input.kind,
          relPath: input.relPath,
          // A bundle such as an iOS .app is a directory: registered as-is, no hash.
          mime:
            input.mime ??
            (stat?.isDirectory()
              ? 'inode/directory'
              : (MIME_BY_EXT[ext] ?? 'application/octet-stream')),
          sha256: isFile ? createHash('sha256').update(readFileSync(abs)).digest('hex') : undefined,
          bytes: isFile ? stat!.size : stat?.isDirectory() ? directorySize(abs) : undefined,
          createdAt: nowIso(),
          meta: input.meta ?? {},
        }
        this.opts.store.addArtifact(artifact)
        this.emit(runId, stage.id, { type: 'artifact.added', artifact })
        return artifact
      },
      readJsonArtifact: <T>(kind: Artifact['kind'], meta?: Record<string, unknown>) => {
        const all = this.opts.store
          .listArtifacts(runId)
          .filter(
            (a) =>
              a.kind === kind && (!meta || Object.entries(meta).every(([k, v]) => a.meta[k] === v)),
          )
        const latest = all.at(-1)
        if (!latest) return undefined
        const abs = join(run.runDir, latest.relPath)
        if (!existsSync(abs)) return undefined
        return JSON.parse(readFileSync(abs, 'utf8')) as T
      },
      updateRun: (patch) => {
        const fresh = this.mustRun(runId)
        const updated = { ...fresh, ...patch, updatedAt: nowIso() }
        this.opts.store.updateRun(updated)
        this.emitRun(updated)
        return updated
      },
      chargeCost: (usd) => {
        if (!(usd > 0)) return
        const current = this.opts.store.getStage(runId, stage.id)
        if (!current || current.status !== 'running') return
        const charged = round(current.costUsd + usd)
        this.opts.store.upsertStage({ ...current, costUsd: charged })
        live.charged.set(stage.id, round((live.charged.get(stage.id) ?? 0) + usd))
        this.addRunCost(runId, stage.id, usd)
      },
    }
  }

  private mustRun(runId: string): Run {
    const run = this.opts.store.getRun(runId)
    if (!run) throw new Error(`unknown run ${runId}`)
    return run
  }

  private setRunStatus(runId: string, status: Run['status']): Run {
    const run = this.mustRun(runId)
    if (run.status === status) return run
    const updated = { ...run, status, updatedAt: nowIso() }
    this.opts.store.updateRun(updated)
    this.emitRun(updated)
    return updated
  }

  private refreshRunStatus(runId: string): Run['status'] {
    const run = this.mustRun(runId)
    const derived = deriveRunStatus(run, this.opts.store.listStages(runId))
    return this.setRunStatus(runId, derived).status
  }

  private emit(runId: string, stageId: string | undefined, payload: EventPayload) {
    this.opts.bus.emit(runId, stageId, payload)
  }

  private emitRun(run: Run) {
    this.emit(run.id, undefined, { type: 'run.status', run })
  }

  private emitStage(stage: Stage) {
    this.emit(stage.runId, stage.id, { type: 'stage.status', stage })
  }

  private log(
    runId: string,
    stageId: string | undefined,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
  ) {
    this.emit(runId, stageId, { type: 'log', level, message })
  }
}

/** Total bytes under a directory (bundles), capped by walking at most a few thousand entries. */
function directorySize(dir: string, budget = { entries: 5000 }): number {
  let total = 0
  for (const name of readdirSync(dir)) {
    if (budget.entries-- <= 0) break
    const p = join(dir, name)
    const st = statSync(p)
    total += st.isDirectory() ? directorySize(p, budget) : st.size
  }
  return total
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}
