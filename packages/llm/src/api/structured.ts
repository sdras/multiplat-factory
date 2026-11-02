import { estimateCostUsd, priceOptionsFor, toJsonSchema, type OpenAiCompatibleLlm } from '@mpf/core'
import type { z } from 'zod'
import type { StructuredCallOptions, StructuredCallResult } from '../messages.ts'
import {
  ApiAbortError,
  chatCompletionWithEffort,
  rejectsToolChoice,
  type EffortState,
} from './client.ts'
import {
  describeIssues,
  parseArguments,
  parseTextToolCalls,
  SUBMIT_TOOL,
  submitParameters,
  submitTool,
} from './loop.ts'
import {
  addUsage,
  EMPTY_USAGE,
  textOf,
  tokenUsageOf,
  toolCallsOf,
  type ChatMessage,
  type ChatRequest,
  type ContentPart,
  type TokenUsage,
} from './types.ts'

type AnthropicContent = StructuredCallOptions<z.ZodType>['user']

/** Anthropic-style content blocks (text, base64 or URL images) as OpenAI content parts. */
export function userContent(content: AnthropicContent): string | ContentPart[] {
  if (typeof content === 'string') return content
  const parts: ContentPart[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      const source = block.source
      if (source.type === 'base64')
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${source.media_type};base64,${source.data}` },
        })
      else if (source.type === 'url')
        parts.push({ type: 'image_url', image_url: { url: source.url } })
    } else parts.push({ type: 'text', text: JSON.stringify(block) })
  }
  return parts
}

/** JSON from a text answer, with a Markdown code fence tolerated. */
function parseJsonText(text: string): { value: unknown } | { error: string } {
  let raw = text.trim()
  if (raw.startsWith('```') && raw.endsWith('```')) {
    const firstBreak = raw.indexOf('\n')
    raw = firstBreak < 0 ? '' : raw.slice(firstBreak + 1, -3).trim()
  }
  try {
    return { value: JSON.parse(raw) }
  } catch (err) {
    return { error: `the answer is not JSON: ${(err as Error).message}` }
  }
}

/**
 * One structured call over the chat-completions protocol: the schema is offered as the only tool
 * and the model is made to call it; a server that refuses `tool_choice` gets a JSON-schema
 * `response_format` instead. A result that fails the zod schema is sent back once for repair.
 */
export async function apiStructuredCall<T extends z.ZodType>(
  opts: StructuredCallOptions<T>,
  llm: OpenAiCompatibleLlm,
): Promise<StructuredCallResult<z.infer<T>>> {
  const schema = toJsonSchema(opts.schema)
  const submit = submitParameters(schema)
  const tool = submitTool(submit.parameters)
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: userContent(opts.user) },
  ]
  let usage: TokenUsage = EMPTY_USAGE
  let costUsd = 0
  let useResponseFormat = false
  const effortState: EffortState = { reasoningRejected: false }
  const prices = priceOptionsFor(llm)
  const done = (
    partial: Omit<StructuredCallResult<z.infer<T>>, 'costUsd' | 'usage'>,
  ): StructuredCallResult<z.infer<T>> => ({
    ...partial,
    costUsd,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: 0,
    } as unknown as StructuredCallResult<z.infer<T>>['usage'],
  })

  type Answer =
    | { kind: 'refusal'; explanation: string }
    | { kind: 'value'; value: unknown; assistant: ChatMessage; callId?: string }
    | { kind: 'unparsable'; error: string; assistant: ChatMessage; callId?: string }

  const ask = async (): Promise<Answer> => {
    const body: ChatRequest = useResponseFormat
      ? {
          model: opts.model,
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'result', schema: submit.parameters },
          },
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        }
      : {
          model: opts.model,
          messages,
          tools: [tool],
          tool_choice: { type: 'function', function: { name: SUBMIT_TOOL } },
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        }
    let response
    try {
      response = await chatCompletionWithEffort(llm, body, opts.effort, effortState)
    } catch (err) {
      if (!useResponseFormat && rejectsToolChoice(err)) {
        useResponseFormat = true
        return ask()
      }
      throw err
    }
    const choice = response.choices?.[0]
    const turnUsage = tokenUsageOf(response.usage)
    usage = addUsage(usage, turnUsage)
    costUsd += estimateCostUsd(opts.model, turnUsage, prices)
    if (choice?.message.refusal) return { kind: 'refusal', explanation: choice.message.refusal }
    const calls = toolCallsOf(choice)
    const text = textOf(choice?.message.content)
    const call = calls.find((c) => c.function.name === SUBMIT_TOOL) ?? calls[0]
    const assistant: ChatMessage = {
      role: 'assistant',
      ...(text ? { content: text } : calls.length ? {} : { content: '' }),
      ...(calls.length ? { tool_calls: calls } : {}),
    }
    if (call) {
      const parsed = parseArguments(call)
      if ('error' in parsed)
        return { kind: 'unparsable', error: parsed.error, assistant, callId: call.id }
      const value = submit.wrapped ? parsed.input.result : parsed.input
      return { kind: 'value', value, assistant, callId: call.id }
    }
    // A model that writes the call as text (`{"name": "submit_result", "arguments": {...}}`).
    const textCall = text ? parseTextToolCalls(text, new Set([SUBMIT_TOOL]))[0] : undefined
    if (textCall) {
      const value = submit.wrapped ? textCall.arguments.result : textCall.arguments
      return { kind: 'value', value, assistant }
    }
    if (useResponseFormat || text) {
      const parsed = parseJsonText(text)
      if ('error' in parsed) return { kind: 'unparsable', error: parsed.error, assistant }
      const value =
        submit.wrapped &&
        parsed.value &&
        typeof parsed.value === 'object' &&
        'result' in parsed.value
          ? (parsed.value as { result: unknown }).result
          : parsed.value
      return { kind: 'value', value, assistant }
    }
    return {
      kind: 'unparsable',
      error: `no ${SUBMIT_TOOL} call and no text answer (finish_reason ${choice?.finish_reason ?? 'unknown'})`,
      assistant,
    }
  }

  const validate = (
    answer: Answer,
  ): { ok: true; data: z.infer<T> } | { ok: false; error: string } => {
    if (answer.kind === 'refusal') return { ok: false, error: 'model refused' }
    if (answer.kind === 'unparsable') return { ok: false, error: answer.error }
    const check = opts.schema.safeParse(answer.value)
    return check.success
      ? { ok: true, data: check.data as z.infer<T> }
      : { ok: false, error: describeIssues(check.error) }
  }

  try {
    const first = await ask()
    if (first.kind === 'refusal')
      return done({
        ok: false,
        refusal: { category: null, explanation: first.explanation },
        error: 'model refused',
      })
    const firstCheck = validate(first)
    if (firstCheck.ok) return done({ ok: true, data: firstCheck.data })

    // One repair round with the validation error in the transcript. A server whose model never
    // made a native tool call gets the schema as a response format instead, which constrains the
    // output where a tool description only suggests it.
    if (!first.callId) useResponseFormat = true
    messages.push(first.assistant)
    const problem = `The result did not match the schema: ${firstCheck.error}. Answer again with a corrected result${useResponseFormat ? '' : ` by calling ${SUBMIT_TOOL}`}.`
    // Every call the model made needs its tool message, or the server rejects the transcript.
    const callIds =
      first.assistant.role === 'assistant'
        ? (first.assistant.tool_calls ?? []).map((c) => c.id)
        : []
    if (callIds.length)
      for (const id of callIds)
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: id === first.callId ? problem : 'Not used; only one result is read.',
        })
    else messages.push({ role: 'user', content: problem })
    const second = await ask()
    if (second.kind === 'refusal')
      return done({
        ok: false,
        refusal: { category: null, explanation: second.explanation },
        error: 'model refused',
      })
    const secondCheck = validate(second)
    if (secondCheck.ok) return done({ ok: true, data: secondCheck.data })
    return done({ ok: false, error: `structured output failed validation: ${secondCheck.error}` })
  } catch (err) {
    return done({
      ok: false,
      error: err instanceof ApiAbortError ? 'aborted' : ((err as Error).message ?? String(err)),
    })
  }
}
