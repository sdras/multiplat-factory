import { z } from 'zod'
import { Id, IsoDate } from './common.ts'

export const ArtifactKind = z.enum([
  'source-screenshot',
  'target-screenshot',
  'web-dist',
  'ios-app',
  'android-apk',
  'log',
  'appspec',
  'behaviorspec',
  'inventory',
  'detection',
  'portplan',
  'verdict',
  'test-report',
  'wasm-module',
  'core-manifest',
  'golden-vectors',
  'parity-report',
  'port-readme',
  'run-report',
  'diagnostics',
  'other',
])
export type ArtifactKind = z.infer<typeof ArtifactKind>

export const Artifact = z.object({
  id: Id,
  runId: Id,
  stageId: Id,
  kind: ArtifactKind,
  /** Path relative to the run directory. */
  relPath: z.string(),
  mime: z.string().default('application/octet-stream'),
  sha256: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  createdAt: IsoDate,
  meta: z.record(z.string(), z.unknown()).default({}),
})
export type Artifact = z.infer<typeof Artifact>
