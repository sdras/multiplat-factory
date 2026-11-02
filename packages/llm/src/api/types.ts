/** The subset of the OpenAI chat-completions wire format the factory speaks. */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content?: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } }

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  tool_choice?: ToolChoice
  reasoning_effort?: 'low' | 'medium' | 'high'
  max_tokens?: number
  response_format?: {
    type: 'json_schema'
    json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean }
  }
}

export interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface ChatChoice {
  index?: number
  finish_reason?: string | null
  message: {
    role?: string
    content?: string | ContentPart[] | null
    tool_calls?: Array<{
      id?: string
      type?: string
      function?: { name?: string; arguments?: string | Record<string, unknown> }
    }>
    refusal?: string | null
  }
}

export interface ChatResponse {
  id?: string
  model?: string
  choices?: ChatChoice[]
  usage?: ChatUsage
}

/** A response's usage on the Anthropic-style shape `estimateCostUsd` prices. */
export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function tokenUsageOf(usage: ChatUsage | undefined): TokenUsage {
  const prompt = usage?.prompt_tokens ?? 0
  const cached = Math.min(prompt, usage?.prompt_tokens_details?.cached_tokens ?? 0)
  return {
    input_tokens: prompt - cached,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  }
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  }
}

export const EMPTY_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

/** The assistant text of a response: a string, or the text parts of an array content. */
export function textOf(content: ChatChoice['message']['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Tool calls of a response, with ids and string arguments whatever the server sent. */
export function toolCallsOf(choice: ChatChoice | undefined): ToolCall[] {
  const calls = choice?.message.tool_calls ?? []
  return calls.map((c, i) => ({
    id: c.id || `call_${i}`,
    type: 'function' as const,
    function: {
      name: c.function?.name ?? '',
      arguments:
        typeof c.function?.arguments === 'string'
          ? c.function.arguments
          : JSON.stringify(c.function?.arguments ?? {}),
    },
  }))
}
