import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { toJsonSchema, type Effort } from '@mpf/core'
import type { z } from 'zod'
import { decide, defaultPolicy, type PermissionPolicy } from './permissions.ts'

export type AgentEvent =
  | { type: 'message'; role: 'assistant' | 'user'; text: string }
  | { type: 'tool_use'; toolUseId: string; tool: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; tool: string; ok: boolean; summary: string }
  | { type: 'session'; sessionId: string }
  | { type: 'denied'; tool: string; reason: string }

export interface AgentRunOptions {
  prompt: string
  /** Restrict the available tool surface (chat uses Read only). */
  tools?: string[]
  /** A custom system prompt, or the Claude Code preset with an appended instruction. */
  systemPrompt?: string | { preset: 'claude_code'; append?: string }
  cwd: string
  /** Extra directories the worker may read (source app, shared core). */
  readDirs?: string[]
  model: string
  effort?: Effort
  maxTurns?: number
  maxBudgetUsd?: number
  /** Regexes a Bash command must match to run. No entries means Bash is denied. */
  bashAllow?: RegExp[]
  /** Parse the final structured output with this schema (Agent SDK `outputFormat`). */
  outputSchema?: z.ZodType
  resume?: string
  signal?: AbortSignal
  env?: Record<string, string | undefined>
  onEvent?: (event: AgentEvent) => void
  policy?: PermissionPolicy
}

export interface AgentRunResult {
  ok: boolean
  text: string
  structured?: unknown
  costUsd: number
  numTurns: number
  sessionId?: string
  /** Whole-session total as the SDK reported it (equals costUsd unless the session was resumed). */
  sessionCostUsd?: number
  stopReason?: string | null
  error?: string
  denials: number
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

/**
 * Runs one Claude Agent SDK session as a factory worker: sandboxed to its workspace,
 * budget-capped, with every tool call mirrored to `onEvent` for the dashboard.
 * Auth comes from ANTHROPIC_API_KEY or the user's Claude Code login.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const policy = opts.policy ?? {
    ...defaultPolicy(opts.cwd, opts.readDirs),
    bashAllow: opts.bashAllow ?? [],
  }
  let denials = 0
  const emit = (e: AgentEvent) => opts.onEvent?.(e)

  const options: Options = {
    cwd: opts.cwd,
    tools: opts.tools,
    additionalDirectories: opts.readDirs,
    model: opts.model,
    effort: opts.effort,
    maxTurns: opts.maxTurns ?? 100,
    maxBudgetUsd: opts.maxBudgetUsd,
    // No `allowedTools`: bare entries auto-approve a tool before canUseTool runs.
    // Every gated call must reach the policy below.
    disallowedTools: policy.denyTools,
    permissionMode: 'default',
    settingSources: [],
    persistSession: true,
    enableFileCheckpointing: true,
    resume: opts.resume,
    abortController: abortControllerFrom(opts.signal),
    env: { ...process.env, ...opts.env },
    systemPrompt:
      typeof opts.systemPrompt === 'string'
        ? { type: 'custom', prompt: opts.systemPrompt }
        : opts.systemPrompt
          ? { type: 'preset', preset: 'claude_code', append: opts.systemPrompt.append }
          : undefined,
    outputFormat: opts.outputSchema
      ? { type: 'json_schema', schema: toJsonSchema(opts.outputSchema) }
      : undefined,
    canUseTool: async (tool, input) => {
      const d = decide(policy, tool, input)
      if (d.allow) return { behavior: 'allow', updatedInput: input }
      denials++
      emit({ type: 'denied', tool, reason: d.reason })
      return { behavior: 'deny', message: d.reason }
    },
  }

  let result: AgentRunResult = { ok: false, text: '', costUsd: 0, numTurns: 0, denials: 0 }
  const toolNames = new Map<string, string>()
  try {
    for await (const msg of query({ prompt: opts.prompt, options })) {
      handle(msg)
    }
  } catch (err) {
    result = { ...result, ok: false, error: (err as Error).message ?? String(err) }
  }
  result.denials = denials
  return result

  function handle(msg: SDKMessage) {
    switch (msg.type) {
      case 'system':
        if ('subtype' in msg && msg.subtype === 'init' && 'session_id' in msg) {
          result.sessionId = msg.session_id
          emit({ type: 'session', sessionId: msg.session_id })
        }
        break
      case 'assistant': {
        const blocks = contentBlocks(msg)
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            emit({ type: 'message', role: 'assistant', text: b.text })
          } else if (
            b.type === 'tool_use' &&
            typeof b.id === 'string' &&
            typeof b.name === 'string'
          ) {
            toolNames.set(b.id, b.name)
            emit({ type: 'tool_use', toolUseId: b.id, tool: b.name, input: b.input })
          }
        }
        break
      }
      case 'user': {
        for (const b of contentBlocks(msg)) {
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            emit({
              type: 'tool_result',
              toolUseId: b.tool_use_id,
              tool: toolNames.get(b.tool_use_id) ?? 'tool',
              ok: !b.is_error,
              summary: summarize(b.content),
            })
          }
        }
        break
      }
      case 'result': {
        const r = msg
        result.costUsd = r.total_cost_usd ?? 0
        result.numTurns = r.num_turns ?? 0
        result.sessionId = r.session_id ?? result.sessionId
        if (r.subtype === 'success') {
          result.ok = !r.is_error
          result.text = r.result
          result.stopReason = r.stop_reason
          result.usage = r.usage
          if (opts.outputSchema && r.structured_output !== undefined) {
            const parsed = opts.outputSchema.safeParse(r.structured_output)
            if (parsed.success) result.structured = parsed.data
            else {
              result.ok = false
              result.error = `structured output failed validation: ${parsed.error.message}`
            }
          } else if (opts.outputSchema) {
            result.ok = false
            result.error = 'worker finished without structured output'
          }
        } else {
          result.ok = false
          result.error = `${r.subtype}${'errors' in r && Array.isArray(r.errors) ? ': ' + r.errors.join('; ') : ''}`
        }
        break
      }
      default:
        break
    }
  }
}

type Block = { type?: string; [k: string]: unknown }

function contentBlocks(msg: SDKMessage): Block[] {
  const m = (msg as { message?: { content?: unknown } }).message
  const content = m?.content
  if (Array.isArray(content)) return content as Block[]
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

function summarize(content: unknown, max = 300): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((c) =>
        c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '',
      )
      .join('\n')
  }
  text = text.trim()
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text
}

function abortControllerFrom(signal?: AbortSignal): AbortController | undefined {
  if (!signal) return undefined
  const ac = new AbortController()
  if (signal.aborted) ac.abort(signal.reason)
  else signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true })
  return ac
}
