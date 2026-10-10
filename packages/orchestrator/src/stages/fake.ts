import { STAGE_CATALOG, newId, type StageKind } from '@mpf/core'
import type { StageContext, StageOutcome, StageRunner, StageRunnerRegistry } from '@mpf/harness'

/**
 * A pipeline that touches no LLM and no toolchain. It emits realistic events so the
 * dashboard, SSE stream, controls, and reducer can be exercised end to end.
 * Timing is scaled by `speed` (1 = ~0.5 s per stage).
 */
export function fakeRegistry(speed = 1): StageRunnerRegistry {
  const kinds = Object.keys(STAGE_CATALOG) as StageKind[]
  const reg: StageRunnerRegistry = {}
  for (const kind of kinds) reg[kind] = new FakeStage(kind, speed)
  return reg
}

class FakeStage implements StageRunner {
  constructor(
    private kind: StageKind,
    private speed: number,
  ) {}

  async run(ctx: StageContext): Promise<StageOutcome> {
    const info = STAGE_CATALOG[this.kind]
    ctx.log('info', `${info.title}: ${info.description}`)
    const wait = (ms: number) => sleep(ms * this.speed, ctx.signal)

    if (this.kind === 'core.extract' && ctx.run.options.coreMode === 'auto') {
      await wait(150)
      return { status: 'skipped', reason: 'fake analyzer found under 150 lines of pure logic' }
    }
    if (this.kind === 'core.vectors' || this.kind === 'core.build') {
      if (ctx.store.getStage(ctx.run.id, 'core.extract')?.status === 'skipped') {
        return { status: 'skipped', reason: 'no shared core for this run' }
      }
    }

    if (this.kind === 'plan' && ctx.run.options.checkpoints.planApproval) {
      const choice = choiceFor(ctx)
      if (!choice) {
        await wait(200)
        return {
          status: 'waiting_human',
          reason: 'Review the port plan before generation starts.',
          choices: [
            { id: 'approve', label: 'Approve plan' },
            { id: 'reject', label: 'Reject and cancel' },
          ],
        }
      }
      if (choice === 'reject') {
        return {
          status: 'failed',
          error: { class: 'human-needed', message: 'plan rejected', diagnostics: [] },
        }
      }
    }

    if (info.llm) {
      ctx.emit({
        type: 'agent.message',
        role: 'assistant',
        text: `Starting ${info.title.toLowerCase()}…`,
        partial: false,
      })
      await wait(120)
      const toolUseId = newId()
      ctx.emit({
        type: 'agent.tool_use',
        toolUseId,
        tool: 'Read',
        input: { file_path: 'src/App.tsx' },
      })
      await wait(80)
      ctx.emit({
        type: 'agent.tool_result',
        toolUseId,
        tool: 'Read',
        ok: true,
        summary: '142 lines',
      })
      for (const note of ctx.takeInstructions()) {
        ctx.emit({
          type: 'agent.message',
          role: 'user',
          text: `[instruction] ${note}`,
          partial: false,
        })
      }
      await wait(150)
      ctx.emit({
        type: 'agent.message',
        role: 'assistant',
        text: `${info.title} complete.`,
        partial: false,
      })
    } else {
      const procId = newId()
      ctx.emit({ type: 'proc.started', procId, command: `fake-${this.kind}`, cwd: ctx.run.runDir })
      await wait(100)
      ctx.emit({ type: 'proc.stdout', procId, chunk: `working on ${ctx.stage.id}\n` })
      await wait(100)
      ctx.emit({ type: 'proc.exited', procId, exitCode: 0, durationMs: 200 * this.speed })
    }

    if (this.kind === 'test' && ctx.stage.target) {
      ctx.emit({
        type: 'test.result',
        result: {
          stageId: ctx.stage.id,
          target: ctx.stage.target,
          kind: 'unit',
          status: 'pass',
          cases: [
            { id: 't1', name: 'renders home', status: 'pass', durationMs: 12, artifacts: [] },
          ],
          summary: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
        },
      })
    }

    if (this.kind === 'critique' && ctx.stage.target) {
      ctx.emit({
        type: 'critic.verdict',
        verdict: {
          stageId: ctx.stage.id,
          target: ctx.stage.target,
          round: 1,
          scores: { fidelity: 4, idiomatic: 4, testAdequacy: 3, parityDocs: 4, buildHealth: 5 },
          findings: [],
          decision: 'pass',
          confidence: 0.9,
          acceptedDeviationsSeen: [],
          summary: 'Fake critic: nothing blocking.',
        },
      })
    }

    if (this.kind === 'fix') {
      return { status: 'skipped', reason: 'critic passed; nothing to fix' }
    }

    if (this.kind === 'report') {
      ctx.addArtifact({ kind: 'port-readme', relPath: 'PORT.md', mime: 'text/markdown' })
    }

    return { status: 'succeeded', costUsd: info.llm ? 0.02 : 0 }
  }
}

function choiceFor(ctx: StageContext): string | undefined {
  return ctx.humanChoice
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}
