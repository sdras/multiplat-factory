import { z } from 'zod'
import { Effort, ModelConfig } from './run.ts'

/** User-level configuration (~/.mpf/config.json, mpf.config.ts, env). */
export const MpfConfig = z.object({
  dataDir: z.string().optional().describe('Overrides the default ~/.mpf'),
  models: ModelConfig.prefault({}),
  effort: z
    .object({ generate: Effort.default('xhigh'), critic: Effort.default('high') })
    .prefault({}),
  budget: z
    .object({
      defaultUsd: z.number().positive().default(30),
      hardCapUsd: z.number().positive().default(100),
    })
    .prefault({}),
  concurrency: z
    .object({
      agents: z.number().int().positive().default(3),
      lanes: z
        .object({
          xcodebuild: z.number().int().positive().default(1),
          gradle: z.number().int().positive().default(1),
          simulator: z.number().int().positive().default(1),
          emulator: z.number().int().positive().default(1),
          web: z.number().int().positive().default(2),
        })
        .prefault({}),
    })
    .prefault({}),
  toolchain: z
    .object({
      androidHome: z.string().optional(),
      javaHome: z.string().optional(),
      developerDir: z.string().optional(),
      maestro: z.string().optional(),
      cargo: z.string().optional(),
    })
    .prefault({}),
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(4310),
    })
    .prefault({}),
})
export type MpfConfig = z.infer<typeof MpfConfig>
