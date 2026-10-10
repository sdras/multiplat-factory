import { z } from 'zod'

export const Platform = z.enum(['web', 'ios', 'android'])
export type Platform = z.infer<typeof Platform>

export const Target = Platform
export type Target = Platform

export const IsoDate = z.string().describe('ISO-8601 timestamp')

export const Id = z.string().min(1)

export const Priority = z.enum(['must', 'should'])
export type Priority = z.infer<typeof Priority>

export const Severity = z.enum(['blocking', 'advisory', 'nit'])
export type Severity = z.infer<typeof Severity>

/** Structured diagnostic parsed from a compiler, test runner, or tool. */
export const Diagnostic = z.object({
  file: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  severity: z.enum(['error', 'warning', 'note']),
  code: z.string().optional(),
  message: z.string(),
  tool: z.string().optional(),
})
export type Diagnostic = z.infer<typeof Diagnostic>
