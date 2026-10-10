import { stageId, type Run, type Stage, type StageKind, type Target } from '@mpf/core'

/**
 * Builds the stage DAG for a run. Pure: same run -> same graph.
 *
 *   ingest -> inventory -> spec -> behaviors -> observe -> plan
 *   plan -> core.extract -> core.vectors -> core.build            (when coreMode != never)
 *   plan [+ core.build] -> generate:<t> -> build:<t> -> test:<t> -> critique:<t> -> fix:<t>
 *   all fix:<t> -> report
 *
 * Fix loops are not extra nodes: after a successful fix the orchestrator re-queues
 * build/test/critique for that target with attempt+1.
 */
export function buildStageGraph(run: Run): Stage[] {
  const stages: Stage[] = []
  let ord = 0
  const add = (
    kind: StageKind,
    dependsOn: string[],
    target?: Target,
    extra: Partial<Stage> = {},
  ) => {
    const s: Stage = {
      id: stageId(kind, target),
      runId: run.id,
      kind,
      target,
      status: 'pending',
      attempt: 0,
      maxAttempts: 3,
      dependsOn,
      ord: ord++,
      inputs: [],
      outputs: [],
      costUsd: 0,
      ...extra,
    }
    stages.push(s)
    return s.id
  }

  const ingest = add('ingest', [])
  const inventory = add('inventory', [ingest])
  const spec = add('spec', [inventory])
  const behaviors = add('behaviors', [spec])
  const observe = add('observe', [behaviors])
  const plan = add('plan', [observe])

  const generateDeps = [plan]
  if (run.options.coreMode !== 'never') {
    const extract = add('core.extract', [plan])
    const vectors = add('core.vectors', [extract])
    const build = add('core.build', [vectors])
    generateDeps.push(build)
  }

  const ends: string[] = []
  for (const target of run.targets) {
    const gen = add('generate', generateDeps, target)
    const build = add('build', [gen], target)
    const test = add('test', [build], target)
    const critique = add('critique', [test], target)
    const fix = add('fix', [critique], target, { maxAttempts: 5 })
    ends.push(fix)
  }
  // The report waits for the end of every target's loop (fix runs or skips after the last critique).
  add('report', ends)
  return stages
}
