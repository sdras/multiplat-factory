import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import type { StageContext } from '@mpf/harness'
import { runAgent, type AgentRunOptions, type AgentRunResult } from '@mpf/llm'

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

/** Map a failed worker result to a stage failure; budget exhaustion is never retried with the same cap. */
export function workerFailure(
  result: AgentRunResult,
  fallback: string,
): {
  status: 'failed'
  costUsd: number
  retryable: boolean
  error: { class: 'budget-exhausted' | 'llm-error'; message: string; diagnostics: [] }
} {
  const message = result.error ?? fallback
  const budget = /maximum budget|budget/i.test(message)
  return {
    status: 'failed',
    costUsd: result.costUsd,
    retryable: !budget,
    error: { class: budget ? 'budget-exhausted' : 'llm-error', message, diagnostics: [] },
  }
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
}

/**
 * Runs an Agent SDK worker on behalf of a stage: model and effort from the run,
 * budget from the run budget, events mirrored to the run log, cancellation wired.
 */
export async function runWorker(
  ctx: StageContext,
  opts: WorkerOptions,
  agent: AgentFn = runAgent,
): Promise<AgentRunResult> {
  const run = ctx.run
  const model = run.options.models[opts.role]
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
  ctx.log('info', `worker: ${model} (effort ${effort}, budget cap $${maxBudgetUsd.toFixed(2)})`)
  const result = await agent({
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    cwd: opts.cwd,
    readDirs: opts.readDirs,
    model,
    effort,
    maxTurns: opts.maxTurns ?? 80,
    maxBudgetUsd,
    bashAllow: opts.bashAllow ?? READ_ONLY_BASH,
    outputSchema: opts.outputSchema,
    resume: opts.resume,
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
