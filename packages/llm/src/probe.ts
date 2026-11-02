import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { z } from 'zod'
import { modelFitness, type Effort, type LlmSettings, type ModelConfig } from '@mpf/core'
import { runAgent, type AgentRunOptions, type AgentRunResult } from './agent.ts'
import {
  structuredCall,
  type StructuredCallOptions,
  type StructuredCallResult,
} from './messages.ts'

export interface ProbeThresholds {
  /** Below this many output tokens per second a model is refused: one generation stage would take hours. */
  slowTokensPerSecond: number
  /** Below this it is allowed with a warning. */
  sluggishTokensPerSecond: number
}

export const DEFAULT_PROBE_THRESHOLDS: ProbeThresholds = {
  slowTokensPerSecond: 10,
  sluggishTokensPerSecond: 25,
}

export interface ModelProbe {
  model: string
  role: keyof ModelConfig
  level: 'ok' | 'warn' | 'error'
  reasons: string[]
  /** The worker read a file, wrote one, ran a command, and left the right file behind. */
  toolUse: boolean
  /** The worker submitted a result in the requested shape and a plain structured call did too. */
  structured: boolean
  outputTokensPerSecond?: number
  turns: number
  durationMs: number
  costUsd: number
  probedAt: string
}

export interface ProbeOptions {
  llm: Partial<LlmSettings>
  model: string
  role?: keyof ModelConfig
  effort?: Effort
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  maxBudgetUsd?: number
  thresholds?: ProbeThresholds
  /** The runners (tests pass fakes). */
  agent?: (opts: AgentRunOptions) => Promise<AgentRunResult>
  structured?: <T extends z.ZodType>(
    opts: StructuredCallOptions<T>,
  ) => Promise<StructuredCallResult<z.infer<T>>>
}

const FIRST_LINE = 'the quick brown fox'

const Result = z.object({
  firstLine: z.string().describe('The first line of notes.txt, exactly as written'),
  files: z.array(z.string()).describe('Every file in the workspace after your changes'),
})

const Answer = z.object({ answer: z.number(), reasoning: z.string() })

/**
 * Measure whether a model can drive the factory: one short worker that must read a file, write
 * another, run a shell command, and submit a structured result, then one structured call, timed.
 * The verdict combines what happened with what the model's name says (`modelFitness`).
 */
export async function probeModel(opts: ProbeOptions): Promise<ModelProbe> {
  const role = opts.role ?? 'generate'
  const thresholds = opts.thresholds ?? DEFAULT_PROBE_THRESHOLDS
  const agent = opts.agent ?? runAgent
  const structured = opts.structured ?? structuredCall
  const workspace = mkdtempSync(join(tmpdir(), 'mpf-model-probe-'))
  writeFileSync(join(workspace, 'notes.txt'), `${FIRST_LINE}\njumps over the lazy dog\n`)
  const started = performance.now()
  let costUsd = 0
  const reasons: string[] = []
  let toolUse = false
  let structuredOk = false
  let turns = 0
  let outputTokensPerSecond: number | undefined
  try {
    const result = await agent({
      cwd: workspace,
      model: opts.model,
      effort: opts.effort ?? 'medium',
      maxTurns: 12,
      maxBudgetUsd: opts.maxBudgetUsd ?? 0.5,
      bashAllow: [/^ls\b/, /^cat\b/, /^wc\b/, /^echo\b/],
      outputSchema: Result,
      llm: opts.llm,
      env: opts.env,
      signal: opts.signal,
      systemPrompt:
        'You are a careful software engineering agent working in the given workspace. Use the tools; do not guess file contents.',
      prompt:
        'Read notes.txt. Create summary.md whose only content is the first line of notes.txt in upper case. Then run `ls` to list the workspace. Finally submit your result with submit_result: firstLine is the first line of notes.txt exactly as written, and files is the list of files ls printed.',
    })
    costUsd += result.costUsd
    turns = result.numTurns
    const summaryPath = join(workspace, 'summary.md')
    const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8').trim() : undefined
    toolUse = summary === FIRST_LINE.toUpperCase()
    const submitted = Result.safeParse(result.structured)
    const workerStructured =
      result.ok &&
      submitted.success &&
      submitted.data.firstLine === FIRST_LINE &&
      submitted.data.files.includes('summary.md')
    // A floor of one millisecond keeps a fake or cached answer from dividing by zero.
    const seconds = Math.max(performance.now() - started, 1) / 1000
    if (result.usage && result.usage.output_tokens > 0)
      outputTokensPerSecond = Math.round((result.usage.output_tokens / seconds) * 10) / 10
    if (!toolUse)
      reasons.push(
        `${opts.model} could not complete a four-step task with tools (read a file, write one, run a command, submit a result)${result.error ? `: ${result.error}` : ''}`,
      )
    const call = await structured({
      model: opts.model,
      system: 'Answer arithmetic questions. Submit the number and one sentence of reasoning.',
      user: 'What is 6 times 7?',
      schema: Answer,
      effort: 'low',
      maxTokens: 400,
      llm: opts.llm,
    })
    costUsd += call.costUsd
    structuredOk = workerStructured && call.ok && call.data?.answer === 42
    if (!structuredOk)
      reasons.push(
        `${opts.model} could not return results in the requested shape${!workerStructured && result.error ? ` (${result.error})` : !call.ok && call.error ? ` (${call.error})` : ''}`,
      )
  } catch (err) {
    reasons.push(`${opts.model} could not be probed: ${(err as Error).message ?? String(err)}`)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
  const durationMs = Math.round(performance.now() - started)
  let level: ModelProbe['level'] = toolUse && structuredOk ? 'ok' : 'error'
  if (outputTokensPerSecond !== undefined) {
    if (outputTokensPerSecond < thresholds.slowTokensPerSecond) {
      level = 'error'
      reasons.push(
        `${opts.model} produced ${outputTokensPerSecond} output tokens per second; under ${thresholds.slowTokensPerSecond} a single generation stage takes hours`,
      )
    } else if (outputTokensPerSecond < thresholds.sluggishTokensPerSecond) {
      if (level === 'ok') level = 'warn'
      reasons.push(
        `${opts.model} produced ${outputTokensPerSecond} output tokens per second; expect long stages`,
      )
    }
  }
  const fitness = modelFitness(opts.model, role)
  if (fitness.level === 'error' || (fitness.level === 'warn' && level === 'ok'))
    level = fitness.level
  reasons.push(...fitness.reasons)
  return {
    model: opts.model,
    role,
    level,
    reasons,
    toolUse,
    structured: structuredOk,
    outputTokensPerSecond,
    turns,
    durationMs,
    costUsd,
    probedAt: new Date().toISOString(),
  }
}

/** One line for a log or the terminal. */
export function describeProbe(p: ModelProbe): string {
  const speed = p.outputTokensPerSecond === undefined ? '' : `, ${p.outputTokensPerSecond} tok/s`
  const head = `${p.model} (${p.role}): ${p.level}; tool use ${p.toolUse ? 'yes' : 'no'}, structured output ${p.structured ? 'yes' : 'no'}${speed}, ${p.turns} turns, ${(p.durationMs / 1000).toFixed(1)} s, $${p.costUsd.toFixed(3)}`
  return p.reasons.length ? `${head}. ${p.reasons.join('. ')}` : head
}
