import { z } from 'zod'

/** ABI contract implemented by the crate template and every host binding; see docs/ABI.md. */
export const CORE_ABI_VERSION = 1
/** File name of the built module inside every target and the crate's target dir. */
export const CORE_WASM_FILE = 'mpf_core.wasm'

export const VectorProvenance = z.enum(['executed', 'derived'])
export type VectorProvenance = z.infer<typeof VectorProvenance>

export const GoldenVector = z.object({
  id: z.string().describe('Stable id, unique within the function, e.g. "empty-cart"'),
  input: z.unknown().describe('The request object the function receives'),
  expected: z.unknown().describe('The value the function must return (not the envelope)'),
  provenance: VectorProvenance,
  note: z.string().optional(),
})
export type GoldenVector = z.infer<typeof GoldenVector>

/** One file per core function: `vectors/<function>.json`. */
export const GoldenVectorSet = z.object({
  function: z.string(),
  vectors: z.array(GoldenVector),
})
export type GoldenVectorSet = z.infer<typeof GoldenVectorSet>

/** What the vectors worker returns: sets for every planned function. */
export const GoldenVectorsOutput = z.object({
  sets: z.array(GoldenVectorSet),
  notes: z.string().default(''),
})
export type GoldenVectorsOutput = z.infer<typeof GoldenVectorsOutput>

export const CoreManifestFunction = z.object({
  name: z.string(),
  description: z.string().default(''),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
})
export type CoreManifestFunction = z.infer<typeof CoreManifestFunction>

/** Returned by the module's `mpf_manifest` export; see docs/ABI.md. */
export const CoreManifest = z.object({
  abiVersion: z.literal(1),
  functions: z.array(CoreManifestFunction),
})
export type CoreManifest = z.infer<typeof CoreManifest>

export const ParityHost = z.enum(['rust', 'node', 'web', 'ios', 'android'])
export type ParityHost = z.infer<typeof ParityHost>

export const ParityCase = z.object({
  function: z.string(),
  vectorId: z.string(),
  status: z.enum(['pass', 'fail', 'error']),
  actual: z.unknown().optional(),
  message: z.string().optional(),
})
export type ParityCase = z.infer<typeof ParityCase>

/** One host's run over every vector; the dashboard joins reports by function + vector id. */
export const ParityReport = z.object({
  host: ParityHost,
  cases: z.array(ParityCase),
  summary: z.object({
    total: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
  }),
})
export type ParityReport = z.infer<typeof ParityReport>
