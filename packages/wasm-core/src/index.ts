export {
  ABI_VERSION,
  CORE_CRATE,
  CORE_WASM,
  CORE_VERSIONS,
  coreFiles,
  manifestFor,
  rustIdent,
  type CoreProject,
} from './template.ts'
export {
  WASM_OUT,
  WASM_TARGET,
  buildCoreWasm,
  testCore,
  parseCargoOutput,
  parseVectorFailures,
  type CargoBuildResult,
  type CargoRunOptions,
  type CargoTestResult,
} from './cargo.ts'
export { CoreCallError, loadCore, type CoreEnvelope, type LoadedCore } from './host.ts'
export { jsonEqual, readVectorSets, runVectors, writeVectorSets } from './vectors.ts'
export {
  CORE_EXTRACT_SYSTEM,
  VECTORS_SYSTEM,
  coreExtractPrompt,
  coreFixPrompt,
  vectorsPrompt,
} from './prompts.ts'
export {
  CoreExtractResult,
  coreBuildStage,
  coreExtractStage,
  coreVectorsStage,
  type CoreDeps,
} from './stages.ts'
export { sourceToolEnv, type SourceToolEnv } from './source-tools.ts'
