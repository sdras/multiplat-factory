import { z } from 'zod'

export * from './common.ts'
export * from './run.ts'
export * from './stage.ts'
export * from './artifact.ts'
export * from './event.ts'
export * from './appspec.ts'
export * from './behaviorspec.ts'
export * from './portplan.ts'
export * from './verdict.ts'
export * from './testresult.ts'
export * from './toolchain.ts'
export * from './config.ts'
export * from './inventory.ts'
export * from './corevectors.ts'

/**
 * JSON Schema for LLM structured outputs (Agent SDK `outputFormat`, Messages `output_config`).
 * Draft-7 without a `$schema` key: the Claude Code runtime validates with a draft-7 validator
 * and rejects documents that reference the 2020-12 meta-schema.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >
  delete json.$schema
  return json
}

export * from './review.ts'

export * from './design.ts'
