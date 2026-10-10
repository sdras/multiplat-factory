export { buildStageGraph } from './graph.ts'
export {
  UNREACHABLE,
  deriveRunStatus,
  depsSatisfied,
  indexStages,
  isTerminal,
  isUnreachable,
  readyStages,
  transition,
  InvalidTransition,
  type StageAction,
} from './machine.ts'
export { buildStage, generateStage, testStage, type TargetDeps } from './stages/target.ts'
export { reportStage, type ReportDeps } from './stages/report.ts'
export { Orchestrator, type OrchestratorOptions } from './runner.ts'
export { fakeRegistry } from './stages/fake.ts'
export { realRegistry } from './stages/real.ts'
export type { StageContext, StageOutcome, StageRunner, StageRunnerRegistry } from './types.ts'
