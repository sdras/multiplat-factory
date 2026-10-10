import { writeFileSync } from 'node:fs'
import { join } from 'pathe'
import type { StageContext, StageOutcome, StageRunner } from '@mpf/harness'
import { buildInventory } from '../inventory.ts'
import type { DetectionArtifact } from './ingest.ts'

export function inventoryStage(): StageRunner {
  return {
    async run(ctx: StageContext): Promise<StageOutcome> {
      const detection = ctx.readJsonArtifact<DetectionArtifact>('detection')
      if (!detection) {
        return {
          status: 'failed',
          retryable: false,
          error: { class: 'internal', message: 'detection artifact missing', diagnostics: [] },
        }
      }
      const root = join(ctx.run.runDir, 'source')
      const inventory = await buildInventory(root, {
        hints: detection.hints,
        framework: detection.best.framework,
      })
      writeFileSync(join(ctx.run.runDir, 'inventory.json'), JSON.stringify(inventory, null, 2))
      ctx.addArtifact({ kind: 'inventory', relPath: 'inventory.json' })
      const parsed = inventory.files.filter((f) => f.parsed).length
      ctx.log(
        'info',
        `${inventory.totals.files} files, ${inventory.totals.loc} lines, ${parsed} parsed with tree-sitter, ${inventory.skipped.length} skipped`,
      )
      return {
        status: 'succeeded',
        result: {
          files: inventory.totals.files,
          loc: inventory.totals.loc,
          parsed,
          byRole: inventory.totals.byRole,
        },
      }
    },
  }
}
