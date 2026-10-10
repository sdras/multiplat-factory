import type { Detection } from '@mpf/core'
import { makeDetectContext, type DetectContext, type SourceAdapter } from './types.ts'
import { WEB_SOURCE_ADAPTERS } from './source/web.ts'
import { MOBILE_SOURCE_ADAPTERS } from './source/mobile.ts'
import { CROSS_PLATFORM_ADAPTERS } from './source/cross.ts'

export const SOURCE_ADAPTERS: SourceAdapter[] = [
  ...CROSS_PLATFORM_ADAPTERS,
  ...MOBILE_SOURCE_ADAPTERS,
  ...WEB_SOURCE_ADAPTERS,
]

export function getSourceAdapter(id: string): SourceAdapter | undefined {
  return SOURCE_ADAPTERS.find((a) => a.id === id)
}

export interface DetectResult {
  ctx: DetectContext
  /** All detections, best first. */
  all: Detection[]
  best?: Detection
  /** True when two adapters scored within 0.05 of each other. */
  ambiguous: boolean
}

/** Run every adapter's detector against a directory. Adapters never throw out of detection. */
export async function detectSource(
  dir: string,
  adapters: SourceAdapter[] = SOURCE_ADAPTERS,
): Promise<DetectResult> {
  const ctx = makeDetectContext(dir)
  const all: Detection[] = []
  for (const a of adapters) {
    try {
      const d = await a.detect(ctx)
      if (d) all.push(d)
    } catch {
      /* a broken detector must not hide the others */
    }
  }
  all.sort((x, y) => y.score - x.score)
  const best = all[0]
  const second = all[1]
  const ambiguous = Boolean(best && second && best.score - second.score < 0.05)
  return { ctx, all, best, ambiguous }
}
