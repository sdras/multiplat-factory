import {
  estimateCostUsd,
  newId,
  priceOptionsFor,
  toJsonSchema,
  type OpenAiCompatibleLlm,
} from '@mpf/core'
import type { z } from 'zod'
import type { AgentEvent, AgentRunOptions, AgentRunResult } from '../agent.ts'
import { decide, defaultPolicy, type PermissionPolicy } from '../permissions.ts'
import {
  ApiAbortError,
  chatCompletionWithEffort,
  isContextOverflow,
  type EffortState,
} from './client.ts'
import { loadSession, saveSession, type StoredSession } from './sessions.ts'
import {
  executeTool,
  normalizeInput,
  summarize,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  type ToolResult,
} from './tools.ts'
import {
  addUsage,
  EMPTY_USAGE,
  textOf,
  tokenUsageOf,
  toolCallsOf,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ToolCall,
  type ToolDefinition,
} from './types.ts'

export const SUBMIT_TOOL = 'submit_result'
const COMPACTION_KEEP = 8
export const COMPACTION_PLACEHOLDER = '[tool result omitted to fit the context window]'
const MAX_STRUCTURED_ATTEMPTS = 3
const NUDGE = 'Call submit_result with your result now.'

function defaultSystemPrompt(cwd: string, readDirs: string[] | undefined): string {
  const extra = readDirs?.length
    ? ` You may also read, but not change, these directories: ${readDirs.join(', ')}.`
    : ''
  return [
    `You are a software engineering agent working in the directory ${cwd}.`,
    `Stay inside that workspace: every file you read, write, or run a command on lives under it.${extra}`,
    'Read a file before editing it so your edits match its exact text. Keep changes focused, verify them with the tools you have, and do not ask questions: decide and proceed.',
    'When the work is done, finish with a final answer that says what you did and what, if anything, is left open.',
  ].join('\n')
}

const SUBMIT_INSTRUCTION = `When you have finished, call the ${SUBMIT_TOOL} tool exactly once with your final result. Its arguments must match the tool's schema; if they do not, the problems are returned and you call it again. Never put the result in a text reply instead.`

/** The parameters of `submit_result`: non-object schemas are wrapped so the tool's parameters stay an object. */
export function submitParameters(schema: Record<string, unknown>): {
  parameters: Record<string, unknown>
  wrapped: boolean
} {
  if (schema.type === 'object') return { parameters: schema, wrapped: false }
  return {
    parameters: {
      type: 'object',
      properties: { result: schema },
      required: ['result'],
      additionalProperties: false,
    },
    wrapped: true,
  }
}

export function submitTool(parameters: Record<string, unknown>): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: SUBMIT_TOOL,
      description:
        'Submit your final result. Call it exactly once, when the work is done; the arguments are validated against the schema and any problem is returned so you can call it again with a corrected result.',
      parameters,
    },
  }
}

/** The zod issues as one readable line for the model and the run log. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}

/** Parse a tool call's JSON arguments into an object, or say why they are not one. */
export function parseArguments(
  call: ToolCall,
): { input: Record<string, unknown> } | { error: string } {
  const raw = call.function.arguments.trim() || '{}'
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { error: `Malformed arguments for ${call.function.name}: expected a JSON object` }
    return { input: value as Record<string, unknown> }
  } catch (err) {
    return {
      error: `Malformed JSON arguments for ${call.function.name}: ${(err as Error).message}`,
    }
  }
}

/** Ids of tool calls a model wrote as text; their results go back as user messages. */
export const TEXT_CALL_PREFIX = 'mpf-text-call-'

export interface TextToolCall {
  name: string
  arguments: Record<string, unknown>
}

/**
 * Tool calls a model wrote as text instead of native `tool_calls`: `{"name": "Read",
 * "arguments": {...}}` (or `parameters`, or OpenAI's `{"function": {...}}`), bare, fenced, or
 * embedded in prose, one or several. Only names in `known` count. qwen2.5-coder through Ollama
 * answers every tool request this way, and smaller models on other servers do too.
 */
export function parseTextToolCalls(text: string, known: Set<string>): TextToolCall[] {
  const out: TextToolCall[] = []
  for (const candidate of jsonCandidates(text)) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      const call = asTextCall(item, known)
      if (call) out.push(call)
    }
  }
  return out
}

function asTextCall(value: unknown, known: Set<string>): TextToolCall | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const fn =
    v.function && typeof v.function === 'object' ? (v.function as Record<string, unknown>) : v
  const name = typeof fn.name === 'string' ? fn.name : undefined
  if (!name || !known.has(name)) return undefined
  let args: unknown = fn.arguments ?? fn.parameters ?? fn.input ?? {}
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return undefined
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  return { name, arguments: args as Record<string, unknown> }
}

/** The JSON texts a reply may carry: fenced blocks, the whole reply, or balanced objects in prose. */
function jsonCandidates(text: string): string[] {
  const fenced = fencedBlocks(text)
  if (fenced.length) return fenced
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return [trimmed]
  return balancedObjects(text)
}

/** The contents of every \`\`\` fence, a leading \`json\` tag dropped (a split, so no backtracking). */
function fencedBlocks(text: string): string[] {
  const parts = text.split('```')
  const out: string[] = []
  for (let i = 1; i < parts.length; i += 2) {
    const block = parts[i]!.replace(/^json\b/, '').trim()
    if (block) out.push(block)
  }
  return out
}

function balancedObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

/** Replace every tool result except the newest `keep` with a placeholder; returns how many changed. */
export function compactToolResults(messages: ChatMessage[], keep = COMPACTION_KEEP): number {
  const toolIndexes = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []))
  const stale = toolIndexes.slice(0, Math.max(0, toolIndexes.length - keep))
  let changed = 0
  for (const i of stale) {
    const m = messages[i]!
    if (m.role === 'tool' && m.content !== COMPACTION_PLACEHOLDER) {
      m.content = COMPACTION_PLACEHOLDER
      changed++
    }
  }
  return changed
}

function offeredTools(opts: AgentRunOptions, policy: PermissionPolicy): ToolDefinition[] {
  const defs: ToolDefinition[] = TOOL_NAMES.filter(
    (n) => (!opts.tools || opts.tools.includes(n)) && !policy.denyTools.includes(n),
  ).map((n) => TOOL_DEFINITIONS[n])
  return defs
}

function systemPromptFor(opts: AgentRunOptions, structured: boolean): string {
  let text: string
  if (typeof opts.systemPrompt === 'string') text = opts.systemPrompt
  else {
    text = defaultSystemPrompt(opts.cwd, opts.readDirs)
    if (opts.systemPrompt?.append) text += `\n\n${opts.systemPrompt.append}`
  }
  if (structured) text += `\n\n${SUBMIT_INSTRUCTION}`
  return text
}

/**
 * The factory's own agent loop over the OpenAI-compatible chat-completions protocol: the same
 * tools, sandbox policy, events, budget and turn caps, structured output, and session resumption
 * the Agent SDK path offers, so a stage cannot tell which backend ran its worker.
 */
export async function runApiAgent(
  opts: AgentRunOptions,
  llm: OpenAiCompatibleLlm,
): Promise<AgentRunResult> {
  const env = { ...process.env, ...opts.env } as NodeJS.ProcessEnv
  const policy: PermissionPolicy = opts.policy ?? {
    ...defaultPolicy(opts.cwd, opts.readDirs),
    bashAllow: opts.bashAllow ?? [],
  }
  const emit = (e: AgentEvent) => opts.onEvent?.(e)
  const maxTurns = opts.maxTurns ?? 100
  const prices = priceOptionsFor(llm)

  let session: StoredSession
  if (opts.resume) {
    try {
      session = loadSession(env, opts.resume)
    } catch (err) {
      return {
        ok: false,
        text: '',
        costUsd: 0,
        numTurns: 0,
        denials: 0,
        error: (err as Error).message,
      }
    }
  } else {
    session = {
      id: newId(),
      model: opts.model,
      messages: [],
      costUsd: 0,
      turns: 0,
      updatedAt: '',
    }
  }
  const priorCost = session.costUsd
  const priorTurns = session.turns
  emit({ type: 'session', sessionId: session.id })

  const submit = opts.outputSchema ? submitParameters(toJsonSchema(opts.outputSchema)) : undefined
  const tools = offeredTools(opts, policy)
  if (submit) tools.push(submitTool(submit.parameters))
  const offered = new Set(tools.map((t) => t.function.name))
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPromptFor(opts, submit !== undefined) },
    ...session.messages.filter((m) => m.role !== 'system'),
    { role: 'user', content: opts.prompt },
  ]
  session.messages = messages
  session.model = opts.model

  let callCost = 0
  let usage = EMPTY_USAGE
  let lastText = ''
  let stopReason: string | null | undefined
  let numTurns = 0
  let denials = 0
  let structured: unknown
  let structuredAttempts = 0
  let nudged = false
  const effortState: EffortState = { reasoningRejected: false }

  const persist = () => {
    session.costUsd = priorCost + callCost
    session.turns = priorTurns + numTurns
    try {
      saveSession(env, session)
    } catch {
      // The transcript is a convenience for `resume`; a failed save must not fail the worker.
    }
  }
  const finish = (ok: boolean, error?: string): AgentRunResult => {
    persist()
    return {
      ok,
      text: lastText,
      structured,
      costUsd: priorCost + callCost,
      sessionCostUsd: priorCost + callCost,
      numTurns,
      sessionId: session.id,
      stopReason,
      error,
      denials,
      usage,
    }
  }
  const toolMessage = (call: ToolCall, text: string): void => {
    // A call the model wrote as text has no id the server knows; its result is a user message.
    if (call.id.startsWith(TEXT_CALL_PREFIX))
      messages.push({
        role: 'user',
        content: `Result of ${call.function.name}:\n${text || '(no output)'}`,
      })
    else messages.push({ role: 'tool', tool_call_id: call.id, content: text || '(no output)' })
  }
  const skipCalls = (calls: ToolCall[], reason: string): void => {
    for (const call of calls) toolMessage(call, `[not executed: ${reason}]`)
  }

  const request = async (): Promise<ChatResponse> => {
    let compacted = false
    for (;;) {
      const body: ChatRequest = {
        model: opts.model,
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' as const } : {}),
      }
      try {
        return await chatCompletionWithEffort(llm, body, opts.effort, effortState, {
          signal: opts.signal,
        })
      } catch (err) {
        if (isContextOverflow(err) && !compacted && compactToolResults(messages) > 0) {
          compacted = true
          continue
        }
        if (isContextOverflow(err))
          throw new Error(`context window exceeded: ${(err as Error).message}`, { cause: err })
        throw err
      }
    }
  }

  try {
    for (;;) {
      if (opts.signal?.aborted) return finish(false, 'aborted')
      if (numTurns >= maxTurns) return finish(false, `maximum turns (${maxTurns}) reached`)
      let response: ChatResponse
      try {
        response = await request()
      } catch (err) {
        if (err instanceof ApiAbortError || opts.signal?.aborted) return finish(false, 'aborted')
        return finish(false, (err as Error).message ?? String(err))
      }
      numTurns++
      const choice = response.choices?.[0]
      const turnUsage = tokenUsageOf(response.usage)
      usage = addUsage(usage, turnUsage)
      callCost += estimateCostUsd(opts.model, turnUsage, prices)
      stopReason = choice?.finish_reason ?? null
      const text = textOf(choice?.message.content)
      let calls = toolCallsOf(choice)
      // Some servers and small models never produce native tool calls and write them as text.
      const textCalls = calls.length ? [] : parseTextToolCalls(text, offered)
      const viaText = textCalls.length > 0
      if (viaText)
        calls = textCalls.map((c, i) => ({
          id: `${TEXT_CALL_PREFIX}${numTurns}-${i}`,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        }))
      messages.push({
        role: 'assistant',
        ...(text ? { content: text } : calls.length ? {} : { content: '' }),
        ...(calls.length && !viaText ? { tool_calls: calls } : {}),
      })
      if (text.trim() && !viaText) {
        lastText = text
        emit({ type: 'message', role: 'assistant', text })
      }

      if (opts.maxBudgetUsd !== undefined && callCost > opts.maxBudgetUsd) {
        skipCalls(calls, 'maximum budget reached')
        return finish(
          false,
          `maximum budget of $${opts.maxBudgetUsd.toFixed(2)} reached ($${callCost.toFixed(2)} spent after ${numTurns} turns)`,
        )
      }

      if (!calls.length) {
        if (submit && structured === undefined) {
          if (!nudged) {
            nudged = true
            messages.push({ role: 'user', content: NUDGE })
            persist()
            continue
          }
          return finish(false, 'worker finished without structured output')
        }
        return finish(true)
      }

      const images: Array<NonNullable<ToolResult['image']>> = []
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!
        const name = call.function.name
        const parsed = parseArguments(call)
        emit({
          type: 'tool_use',
          toolUseId: call.id,
          tool: name,
          input: 'input' in parsed ? parsed.input : call.function.arguments,
        })
        if ('error' in parsed) {
          toolMessage(call, parsed.error)
          emit({
            type: 'tool_result',
            toolUseId: call.id,
            tool: name,
            ok: false,
            summary: parsed.error,
          })
          continue
        }

        if (name === SUBMIT_TOOL && submit && opts.outputSchema) {
          const candidate = submit.wrapped ? parsed.input.result : parsed.input
          const check = opts.outputSchema.safeParse(candidate)
          if (check.success) {
            structured = check.data
            toolMessage(call, 'Result accepted.')
            emit({
              type: 'tool_result',
              toolUseId: call.id,
              tool: name,
              ok: true,
              summary: 'Result accepted.',
            })
            skipCalls(calls.slice(i + 1), 'the result was submitted')
            return finish(true)
          }
          structuredAttempts++
          const issues = describeIssues(check.error)
          const reply = `The result did not match the schema: ${issues}. Fix it and call ${SUBMIT_TOOL} again.`
          toolMessage(call, reply)
          emit({
            type: 'tool_result',
            toolUseId: call.id,
            tool: name,
            ok: false,
            summary: summarize(reply),
          })
          if (structuredAttempts >= MAX_STRUCTURED_ATTEMPTS) {
            skipCalls(calls.slice(i + 1), 'structured output failed validation')
            return finish(false, `structured output failed validation: ${issues}`)
          }
          continue
        }

        if (!offered.has(name)) {
          const msg = `Unknown tool: ${name}. Available tools: ${[...offered].join(', ')}`
          toolMessage(call, msg)
          emit({ type: 'tool_result', toolUseId: call.id, tool: name, ok: false, summary: msg })
          continue
        }

        const input = normalizeInput(name, parsed.input, opts.cwd)
        const decision = decide(policy, name, input)
        if (!decision.allow) {
          denials++
          emit({ type: 'denied', tool: name, reason: decision.reason })
          const msg = `Denied: ${decision.reason}`
          toolMessage(call, msg)
          emit({ type: 'tool_result', toolUseId: call.id, tool: name, ok: false, summary: msg })
          continue
        }

        const result = await executeTool(name, input, { cwd: opts.cwd, env, signal: opts.signal })
        toolMessage(call, result.text)
        emit({
          type: 'tool_result',
          toolUseId: call.id,
          tool: name,
          ok: !result.isError,
          summary: summarize(result.text),
        })
        if (result.image) images.push(result.image)
        if (opts.signal?.aborted) {
          skipCalls(calls.slice(i + 1), 'aborted')
          return finish(false, 'aborted')
        }
      }
      for (const image of images) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: `Image from Read of ${image.path}:` },
            { type: 'image_url', image_url: { url: image.dataUrl } },
          ],
        })
      }
      persist()
    }
  } catch (err) {
    // An event sink or the session file failing mid-turn must not lose the turn's cost.
    return finish(false, err instanceof Error ? err.message : String(err))
  }
}
