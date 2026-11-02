import { z } from 'zod'
import { LlmSettings, LlmSettingsInput } from './llm.ts'
import { Id, IsoDate, Platform, Target } from './common.ts'

export const RunStatus = z.enum([
  'queued',
  'running',
  'paused',
  'waiting_human',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
])
export type RunStatus = z.infer<typeof RunStatus>

export const CoreMode = z.enum(['auto', 'always', 'never'])
export type CoreMode = z.infer<typeof CoreMode>

export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof Effort>

export const ModelConfig = z.object({
  generate: z.string().default('claude-opus-5'),
  critic: z.string().default('claude-opus-5'),
  cheap: z.string().default('claude-sonnet-5'),
})
export type ModelConfig = z.infer<typeof ModelConfig>

/** Per-role model names a config may set; roles left unset take the provider's defaults. */
export const ModelOverrides = z.object({
  generate: z.string().optional(),
  critic: z.string().optional(),
  cheap: z.string().optional(),
})
export type ModelOverrides = z.infer<typeof ModelOverrides>

export const RunOptions = z.object({
  parentRunId: Id.optional(),
  revisionInstructions: z.array(z.object({ stageId: z.string(), text: z.string() })).default([]),
  coreMode: CoreMode.default('auto'),
  budgetUsd: z.number().positive().max(500).default(30),
  models: ModelConfig.prefault({}),
  /** Which model provider the run's workers use (no secrets; keys come from the environment). */
  llm: LlmSettings.prefault({}),
  effort: z
    .object({
      generate: Effort.default('xhigh'),
      critic: Effort.default('high'),
    })
    .prefault({}),
  checkpoints: z
    .object({
      planApproval: z.boolean().default(true),
      beforeFixLoop: z.boolean().default(false),
    })
    .prefault({}),
  e2e: z.boolean().default(true),
  webFramework: z.enum(['react', 'vue', 'svelte', 'vanilla']).optional(),
  iosMinVersion: z.string().optional(),
  androidMinSdk: z.number().int().optional(),
  /** Run the fake pipeline (no LLM, no toolchains). Used for self-test and dashboard demos. */
  fake: z.boolean().default(false),
  /** Pause the run after the first stage of this kind succeeds (e.g. 'plan' to review analysis only). */
  until: z.string().optional(),
})
export type RunOptions = z.infer<typeof RunOptions>

export const RunSource = z.object({
  locator: z.string().describe('Local path or git URL'),
  commit: z.string().optional(),
  platform: Platform.optional(),
  framework: z.string().optional(),
  language: z.string().optional(),
  adapterId: z.string().optional(),
})
export type RunSource = z.infer<typeof RunSource>

export const Run = z.object({
  id: Id,
  createdAt: IsoDate,
  updatedAt: IsoDate,
  status: RunStatus,
  source: RunSource,
  targets: z.array(Target).min(1),
  options: RunOptions,
  runDir: z.string(),
  costUsd: z.number().nonnegative().default(0),
  summary: z.string().optional(),
  error: z.string().optional(),
})
export type Run = z.infer<typeof Run>

/**
 * What a client sends to create a run. Everything else is derived. `models` and `llm` stay as
 * partial as they were sent, so the provider's defaults can fill the roles a client did not name
 * (a parsed partial `ModelConfig` would already carry Claude's names).
 */
export const CreateRunInput = z.object({
  source: RunSource.pick({ locator: true, commit: true }),
  targets: z.array(Target).min(1),
  options: RunOptions.partial()
    .extend({ models: ModelOverrides.optional(), llm: LlmSettingsInput.optional() })
    .optional(),
})
/** Input type: nested option objects may be partial; defaults fill the rest. */
export type CreateRunInput = z.input<typeof CreateRunInput>
