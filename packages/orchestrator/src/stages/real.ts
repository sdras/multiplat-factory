import type { MpfConfig } from '@mpf/core'
import type { StageRunnerRegistry } from '@mpf/harness'
import {
  behaviorsStage,
  ingestStage,
  inventoryStage,
  observeStage,
  planStage,
  specStage,
} from '@mpf/analyzer'
import { buildStage, generateStage, testStage } from './target.ts'
import { coreBuildStage, coreExtractStage, coreVectorsStage } from '@mpf/wasm-core'
import { critiqueStage, fixStage } from './critic.ts'
import { reportStage } from './report.ts'

/**
 * The real pipeline as far as it exists in this build. Kinds absent here block
 * with an explicit "no runner" error rather than pretending to succeed.
 * Targets without an adapter or toolchain skip with a reason.
 */
export function realRegistry(config: MpfConfig): StageRunnerRegistry {
  return {
    ingest: ingestStage(),
    inventory: inventoryStage(),
    spec: specStage(config),
    behaviors: behaviorsStage(config),
    observe: observeStage(),
    plan: planStage(config),
    'core.extract': coreExtractStage(config),
    'core.vectors': coreVectorsStage(config),
    'core.build': coreBuildStage(config),
    generate: generateStage(config),
    build: buildStage(config),
    test: testStage(config),
    critique: critiqueStage(config),
    fix: fixStage(config),
    report: reportStage(),
  }
}
