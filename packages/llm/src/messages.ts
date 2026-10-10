import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { estimateCostUsd, type Effort } from '@mpf/core'
import type { z } from 'zod'

let client: Anthropic | undefined

/** Lazily constructed; resolves credentials from the environment or an `ant auth login` profile. */
export function anthropic(): Anthropic {
  client ??= new Anthropic()
  return client
}

export interface StructuredCallOptions<T extends z.ZodType> {
  model: string
  system: string
  /** Stable system prefix is cached; put volatile content in `user`. */
  user: Anthropic.MessageParam['content']
  schema: T
  effort?: Effort
  maxTokens?: number
}

export interface StructuredCallResult<T> {
  ok: boolean
  data?: T
  refusal?: { category: string | null; explanation?: string }
  costUsd: number
  usage: Anthropic.Usage
  error?: string
}

/** One structured-output call for analysis and critic stages. Uses adaptive thinking (the default). */
export async function structuredCall<T extends z.ZodType>(
  opts: StructuredCallOptions<T>,
): Promise<StructuredCallResult<z.infer<T>>> {
  const response = await anthropic().messages.parse({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16000,
    system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: opts.user }],
    output_config: { format: zodOutputFormat(opts.schema), effort: opts.effort ?? 'high' },
  })
  const costUsd = estimateCostUsd(opts.model, response.usage)
  if (response.stop_reason === 'refusal') {
    return {
      ok: false,
      refusal: {
        category: response.stop_details?.category ?? null,
        explanation: response.stop_details?.explanation ?? undefined,
      },
      costUsd,
      usage: response.usage,
      error: 'model refused',
    }
  }
  if (response.parsed_output == null) {
    return {
      ok: false,
      costUsd,
      usage: response.usage,
      error: `no parsable output (stop_reason ${response.stop_reason})`,
    }
  }
  return { ok: true, data: response.parsed_output as z.infer<T>, costUsd, usage: response.usage }
}
