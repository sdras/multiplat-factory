import { z } from 'zod'

export const CheckStatus = z.enum(['ok', 'warn', 'missing'])

export const FixHint = z.object({
  brew: z.string().optional(),
  apt: z.string().optional(),
  winget: z.string().optional(),
  manual: z.string().optional(),
})

export const ToolchainCheck = z.object({
  id: z.string(),
  label: z.string(),
  status: CheckStatus,
  version: z.string().optional(),
  detail: z.string(),
  /** Which targets or features this check gates, e.g. ['ios'], ['android'], ['core'], ['llm']. */
  affects: z.array(z.string()).default([]),
  fix: FixHint.optional(),
})
export type ToolchainCheck = z.infer<typeof ToolchainCheck>

export const ToolchainReport = z.object({
  generatedAt: z.string(),
  host: z.object({ os: z.string(), arch: z.string(), node: z.string() }),
  checks: z.array(ToolchainCheck),
  /** Derived: which targets can run on this host right now. */
  availableTargets: z.array(z.enum(['web', 'ios', 'android'])),
  llmBackend: z.enum(['messages', 'agent-sdk', 'openai-compatible', 'none']),
})
export type ToolchainReport = z.infer<typeof ToolchainReport>
