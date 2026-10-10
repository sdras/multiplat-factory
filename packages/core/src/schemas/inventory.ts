import { z } from 'zod'
import { Platform } from './common.ts'

export const Detection = z.object({
  adapterId: z.string(),
  platform: Platform,
  framework: z.string(),
  language: z.string(),
  entry: z.string().describe('Entry file, scheme, or module'),
  score: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  supported: z.boolean(),
  unsupportedReason: z.string().optional(),
  webFramework: z.string().optional(),
})
export type Detection = z.infer<typeof Detection>

export const FileRole = z.enum([
  'entry',
  'component',
  'route',
  'state',
  'logic',
  'test',
  'config',
  'style',
  'asset',
  'other',
])
export type FileRole = z.infer<typeof FileRole>

export const SourceSymbol = z.object({
  name: z.string(),
  kind: z.string(),
  line: z.number().int().positive(),
  exported: z.boolean().default(false),
})
export type SourceSymbol = z.infer<typeof SourceSymbol>

export const InventoryFile = z.object({
  path: z.string(),
  language: z.string(),
  loc: z.number().int().nonnegative(),
  role: FileRole,
  symbols: z.array(SourceSymbol).default([]),
  imports: z.array(z.string()).default([]),
  parsed: z.boolean().default(false),
})
export type InventoryFile = z.infer<typeof InventoryFile>

export const AnalysisHints = z.object({
  framework: z.string(),
  entryFiles: z.array(z.string()).default([]),
  routeHints: z.array(z.string()).default([]),
  stateHints: z.array(z.string()).default([]),
  persistenceHints: z.array(z.string()).default([]),
  integrationHints: z.array(z.string()).default([]),
  /** Test hooks already present in the source (data-testid, accessibilityIdentifier, testTag, view ids); AppSpec testIds must reuse them. */
  testHooks: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
})
export type AnalysisHints = z.infer<typeof AnalysisHints>

export const Inventory = z.object({
  root: z.string(),
  files: z.array(InventoryFile),
  totals: z.object({
    files: z.number().int(),
    loc: z.number().int(),
    byLanguage: z.record(z.string(), z.number().int()),
    byRole: z.record(z.string(), z.number().int()),
  }),
  hints: AnalysisHints,
  skipped: z.array(z.string()).default([]),
})
export type Inventory = z.infer<typeof Inventory>
