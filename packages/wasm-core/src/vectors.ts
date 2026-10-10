import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import {
  GoldenVectorSet,
  type GoldenVectorSet as VectorSet,
  type ParityCase,
  type ParityHost,
  type ParityReport,
} from '@mpf/core'
import type { LoadedCore } from './host.ts'

/** Write one file per function under `<crate>/vectors/`. Existing files for other functions are kept. */
export function writeVectorSets(crateDir: string, sets: VectorSet[]): string[] {
  const dir = join(crateDir, 'vectors')
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (const set of sets) {
    const file = `${set.function.replace(/[^A-Za-z0-9_-]+/g, '_')}.json`
    writeFileSync(join(dir, file), `${JSON.stringify(GoldenVectorSet.parse(set), null, 2)}\n`)
    written.push(`vectors/${file}`)
  }
  return written
}

export function readVectorSets(crateDir: string): VectorSet[] {
  const dir = join(crateDir, 'vectors')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => GoldenVectorSet.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
}

/** Deep JSON equality with numbers compared after JSON round-trip (so 1.0 == 1). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = normalize((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/** Run every vector through a loaded core and report per case. */
export function runVectors(
  core: LoadedCore,
  sets: VectorSet[],
  host: ParityHost = 'node',
): ParityReport {
  const cases: ParityCase[] = []
  for (const set of sets) {
    for (const v of set.vectors) {
      try {
        const env = core.callRaw(set.function, v.input)
        if (!env.ok)
          cases.push({
            function: set.function,
            vectorId: v.id,
            status: 'error',
            message: `${env.error?.code}: ${env.error?.message}`,
          })
        else if (jsonEqual(env.value, v.expected))
          cases.push({ function: set.function, vectorId: v.id, status: 'pass', actual: env.value })
        else
          cases.push({
            function: set.function,
            vectorId: v.id,
            status: 'fail',
            actual: env.value,
            message: `expected ${JSON.stringify(v.expected)}, got ${JSON.stringify(env.value)}`,
          })
      } catch (err) {
        cases.push({
          function: set.function,
          vectorId: v.id,
          status: 'error',
          message: (err as Error).message,
        })
      }
    }
  }
  const passed = cases.filter((c) => c.status === 'pass').length
  return { host, cases, summary: { total: cases.length, passed, failed: cases.length - passed } }
}
