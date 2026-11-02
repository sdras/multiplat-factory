import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import type { StageContext } from '@mpf/harness'
import { modelFitness, resolveLlm } from '@mpf/core'
import {
  defaultPolicy,
  describeProbe,
  probeModel,
  runAgent,
  type AgentRunOptions,
  type AgentRunResult,
  type ModelProbe,
  type ProbeOptions,
} from '@mpf/llm'

export type AgentFn = (opts: AgentRunOptions) => Promise<AgentRunResult>

export const READ_ONLY_BASH: RegExp[] = [
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^find\b/,
  /^tree\b/,
  /^grep\b/,
  /^rg\b/,
  // Text tools workers reach for on logs and reports; `sed` only in print mode.
  /^sed -n\b/,
  /^awk\b/,
  /^sort\b/,
  /^uniq\b/,
  /^cut\b/,
  /^diff\b/,
  /^stat\b/,
  /^pwd\b/,
  /^which\b/,
  /^env$/,
  /^env \|/,
  /^printenv\b/,
  /^command -v\b/,
  /^echo\b/,
  /^printf\b/,
  // JSON helpers: jq reads only; plutil only in its lint and print modes (it can also rewrite files).
  /^jq\b/,
  /^plutil -(?:lint|p)\b/,
  /^git (log|status|ls-files|show|diff)\b/,
]

/**
 * File operations a worker that may write its workspace is allowed to do from the shell: only
 * relative paths (the sandbox keeps the cwd inside the workspace), never an absolute one, so
 * `rm -rf /` or `cp secret /tmp` fail the allowlist before the path scan even looks.
 */
export const WRITE_BASH: RegExp[] = [
  // In-place sed on a relative path is the Edit tool by another name; absolute paths still go
  // through the sandbox's path scan, and `..` or `~` fail before it.
  /^sed -i(?:\s|$)/,
  /^mkdir(?: -\w+)*(?: [^\s/-]\S*)+$/,
  /^touch(?: [^\s/-]\S*)+$/,
  /^(?:mv|cp)(?: -\w+)*(?: [^\s/-]\S*){2,}$/,
  /^rm(?: -\w+)*(?: [^\s/-]\S*)+$/,
  /^rmdir(?: -\w+)*(?: [^\s/-]\S*)+$/,
]

/**
 * Stages whose workers analyze or judge and must never change a file. Their sandbox denies the
 * write tools on every backend: a 7B model asked for an AppSpec spent seven turns editing the
 * source copy under `runs/<id>/source` before this, which the observe stage then runs.
 */
export const READ_ONLY_STAGES: ReadonlySet<string> = new Set([
  'spec',
  'behaviors',
  'plan',
  'critique',
])
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash']
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

/** Map a failed worker result to a stage failure; budget exhaustion is never retried with the same cap. */
export function workerFailure(
  result: AgentRunResult,
  fallback: string,
): {
  status: 'failed'
  costUsd: number
  retryable: boolean
  error: {
    class: 'budget-exhausted' | 'llm-error' | 'model-unsuitable'
    message: string
    diagnostics: []
  }
} {
  const message = result.error ?? fallback
  const budget = /maximum budget|budget/i.test(message)
  const unsuitable = message.startsWith(UNSUITABLE_PREFIX)
  return {
    status: 'failed',
    costUsd: result.costUsd,
    retryable: !budget && !unsuitable,
    error: {
      class: budget ? 'budget-exhausted' : unsuitable ? 'model-unsuitable' : 'llm-error',
      message,
      diagnostics: [],
    },
  }
}

export const UNSUITABLE_PREFIX = 'model unsuitable: '
const PROBE_FILE = 'model-probe.json'

export type ProbeFn = (opts: ProbeOptions) => Promise<ModelProbe>

/**
 * Decide once per run whether a model can drive the factory. Frontier tiers (Claude, full-size
 * GPT-5, Gemini Pro) pass on their name. Anything else on a non-Claude provider is probed with a
 * short tool task the first time a worker needs it; the verdict is kept in `model-probe.json` in
 * the run directory, its cost charged to the run. `llm.probe: false` skips the live probe and
 * turns the size rule into a warning. Returns the reasons to refuse the model, or nothing.
 */
export async function checkModel(
  ctx: StageContext,
  model: string,
  role: WorkerOptions['role'],
  probe: ProbeFn,
): Promise<string[] | undefined> {
  const run = ctx.run
  const fitness = modelFitness(model, role)
  if (fitness.trusted) return undefined
  const llm = resolveLlm(run.options.llm)
  const live = llm.backend === 'openai-compatible' && run.options.llm.probe !== false
  if (!live) {
    if (fitness.reasons.length)
      ctx.log(
        run.options.llm.probe === false ? 'warn' : fitness.level === 'error' ? 'error' : 'warn',
        fitness.reasons.join('. '),
      )
    return fitness.level === 'error' && run.options.llm.probe !== false
      ? fitness.reasons
      : undefined
  }
  const file = join(run.runDir, PROBE_FILE)
  const probes: Record<string, ModelProbe> = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, ModelProbe>)
    : {}
  let result = probes[model]
  if (!result) {
    ctx.log('info', `probing ${model} with a short tool task before the first worker uses it`)
    result = await probe({ llm: run.options.llm, model, role, signal: ctx.signal })
    probes[model] = result
    writeFileSync(file, `${JSON.stringify(probes, null, 2)}\n`)
    ctx.chargeCost(result.costUsd)
  }
  ctx.log(
    result.level === 'ok' ? 'info' : result.level === 'warn' ? 'warn' : 'error',
    `model probe: ${describeProbe(result)}`,
  )
  return result.level === 'error' ? result.reasons : undefined
}

export interface WorkerOptions {
  role: 'generate' | 'critic' | 'cheap'
  effort?: AgentRunOptions['effort']
  /** Fraction of the run budget this worker may spend. */
  budgetShare: number
  cwd: string
  readDirs?: string[]
  systemPrompt: string
  prompt: string
  outputSchema?: AgentRunOptions['outputSchema']
  bashAllow?: RegExp[]
  maxTurns?: number
  resume?: string
  /** Extra environment for the worker's tools (resolved toolchain variables such as JAVA_HOME). */
  env?: NodeJS.ProcessEnv
  /** Deny the write tools; defaults to true for the stages in `READ_ONLY_STAGES`. */
  readOnly?: boolean
}

/**
 * Runs an agent worker on behalf of a stage: provider, model, and effort from the run,
 * budget from the run budget, events mirrored to the run log, cancellation wired.
 */
export async function runWorker(
  ctx: StageContext,
  opts: WorkerOptions,
  agent: AgentFn = runAgent,
  probe?: ProbeFn,
): Promise<AgentRunResult> {
  const run = ctx.run
  const model = run.options.models[opts.role]
  // The live probe runs only for the real agent (tests pass fakes) unless a probe is injected.
  if ((probe || agent === runAgent) && !run.options.fake) {
    const refused = await checkModel(ctx, model, opts.role, probe ?? probeModel)
    if (refused)
      return {
        ok: false,
        text: '',
        costUsd: 0,
        numTurns: 0,
        denials: 0,
        error: `${UNSUITABLE_PREFIX}${refused.join('. ')}`,
      }
  }
  const effort =
    opts.effort ??
    (opts.role === 'critic'
      ? run.options.effort.critic
      : opts.role === 'cheap'
        ? 'low'
        : run.options.effort.generate)
  // A worker turn on a large prompt costs real money; never cap below a few dollars unless the run itself is nearly spent.
  // A resumed session carries a long transcript, so each turn re-reads far more context: give it a higher floor.
  const remaining = Math.max(0, run.options.budgetUsd - run.costUsd)
  const floor = opts.resume ? 5 : 3
  const maxBudgetUsd = Math.max(
    Math.min(floor, remaining),
    Math.min(remaining, run.options.budgetUsd * opts.budgetShare),
  )
  const readOnly = opts.readOnly ?? READ_ONLY_STAGES.has(ctx.stage.kind)
  const bashAllow = opts.bashAllow ?? READ_ONLY_BASH
  const base = defaultPolicy(opts.cwd, opts.readDirs)
  ctx.log(
    'info',
    `worker: ${model} (effort ${effort}, budget cap ${maxBudgetUsd.toFixed(2)}${readOnly ? ', read-only' : ''})`,
  )
  const result = await agent({
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    cwd: opts.cwd,
    readDirs: opts.readDirs,
    model,
    effort,
    maxTurns: opts.maxTurns ?? 80,
    maxBudgetUsd,
    bashAllow,
    ...(readOnly
      ? {
          tools: READ_ONLY_TOOLS,
          policy: { ...base, bashAllow, denyTools: [...base.denyTools, ...WRITE_TOOLS] },
        }
      : {}),
    outputSchema: opts.outputSchema,
    resume: opts.resume,
    llm: run.options.llm,
    signal: ctx.signal,
    env: { ...opts.env, MPF_RUN_ID: run.id, MPF_STAGE_ID: ctx.stage.id },
    onEvent: (e) => {
      switch (e.type) {
        case 'message':
          ctx.emit({ type: 'agent.message', role: e.role, text: e.text, partial: false })
          break
        case 'tool_use':
          ctx.emit({ type: 'agent.tool_use', toolUseId: e.toolUseId, tool: e.tool, input: e.input })
          break
        case 'tool_result':
          ctx.emit({
            type: 'agent.tool_result',
            toolUseId: e.toolUseId,
            tool: e.tool,
            ok: e.ok,
            summary: e.summary,
          })
          break
        case 'denied':
          ctx.log('warn', `denied ${e.tool}: ${e.reason}`)
          break
        case 'session':
          break
      }
    },
  })
  // A resumed session reports the whole session's spend, not just this call's (Claude Code
  // 2.1.277+ restores totals from the transcript). Charge the run only for what is new.
  const sessionTotal = result.costUsd
  const known = opts.resume ? (readSessionLedger(run.runDir)[opts.resume] ?? 0) : 0
  const incremental = opts.resume && sessionTotal >= known ? sessionTotal - known : sessionTotal
  if (result.sessionId) writeSessionLedger(run.runDir, result.sessionId, sessionTotal)
  ctx.chargeCost(incremental)
  ctx.log(
    'info',
    `worker finished: ${result.ok ? 'ok' : `failed (${result.error})`}, ${result.numTurns} turns, $${incremental.toFixed(3)}${opts.resume ? ` (session total $${sessionTotal.toFixed(3)})` : ''}`,
  )
  return { ...result, costUsd: incremental, sessionCostUsd: sessionTotal }
}

const SESSION_LEDGER = 'sessions.json'

/** Latest reported total per Agent SDK session id, kept in the run directory. */
export function readSessionLedger(runDir: string): Record<string, number> {
  const file = join(runDir, SESSION_LEDGER)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>
  } catch {
    return {}
  }
}

function writeSessionLedger(runDir: string, sessionId: string, totalUsd: number): void {
  const ledger = readSessionLedger(runDir)
  ledger[sessionId] = totalUsd
  writeFileSync(join(runDir, SESSION_LEDGER), `${JSON.stringify(ledger, null, 2)}\n`)
}
