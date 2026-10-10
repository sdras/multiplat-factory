/**
 * Isomorphic run-view reducer. Used by the dashboard (from the SSE stream) and
 * by server-side tests, so both sides derive identical views from the event log.
 * No Node imports here.
 */
import type { Artifact, Event, Run, Stage, TestResult, Verdict } from './schemas/index.ts'

export interface TranscriptItem {
  seq: number
  ts: string
  kind: 'message' | 'tool_use' | 'tool_result' | 'proc' | 'log'
  text: string
  meta?: Record<string, unknown>
}

export interface RunView {
  run?: Run
  stages: Stage[]
  artifacts: Artifact[]
  tests: TestResult[]
  verdicts: Verdict[]
  transcripts: Record<string, TranscriptItem[]>
  pending?: { stageId?: string; reason: string; choices: { id: string; label: string }[] }
  lastSeq: number
}

export const MAX_TRANSCRIPT = 2000

export function emptyView(): RunView {
  return { stages: [], artifacts: [], tests: [], verdicts: [], transcripts: {}, lastSeq: -1 }
}

export function applyEvent(view: RunView, e: Event): RunView {
  if (e.seq <= view.lastSeq) return view
  const next: RunView = { ...view, lastSeq: e.seq }
  switch (e.type) {
    case 'run.status':
      next.run = e.run
      break
    case 'stage.status': {
      const i = next.stages.findIndex((s) => s.id === e.stage.id)
      next.stages = i === -1 ? [...next.stages, e.stage] : next.stages.with(i, e.stage)
      next.stages = [...next.stages].sort((a, b) => a.ord - b.ord)
      if (e.stage.status !== 'waiting_human' && next.pending?.stageId === e.stage.id) {
        next.pending = undefined
      }
      break
    }
    case 'artifact.added':
      next.artifacts = [...next.artifacts, e.artifact]
      break
    case 'test.result':
      next.tests = [...next.tests, e.result]
      break
    case 'critic.verdict':
      next.verdicts = [...next.verdicts, e.verdict]
      break
    case 'human.required':
      next.pending = { stageId: e.stageId, reason: e.reason, choices: e.choices }
      break
    case 'cost.update':
      if (next.run) next.run = { ...next.run, costUsd: e.runCostUsd }
      break
    case 'agent.message':
      if (!e.partial) push(next, e, 'message', e.text, { role: e.role })
      break
    case 'agent.tool_use':
      push(next, e, 'tool_use', e.tool, { toolUseId: e.toolUseId, input: e.input })
      break
    case 'agent.tool_result':
      push(next, e, 'tool_result', e.summary, { toolUseId: e.toolUseId, tool: e.tool, ok: e.ok })
      break
    case 'proc.started':
      push(next, e, 'proc', `$ ${e.command}`, { procId: e.procId, cwd: e.cwd })
      break
    case 'proc.stdout':
    case 'proc.stderr':
      push(next, e, 'proc', e.chunk, { procId: e.procId, stream: e.type })
      break
    case 'proc.exited':
      push(next, e, 'proc', `exit ${e.exitCode ?? 'signal'} (${e.durationMs} ms)`, {
        procId: e.procId,
      })
      break
    case 'log':
      push(next, e, 'log', e.message, { level: e.level })
      break
    default:
      break
  }
  return next
}

export function applyEvents(view: RunView, events: Iterable<Event>): RunView {
  let v = view
  for (const e of events) v = applyEvent(v, e)
  return v
}

function push(
  view: RunView,
  e: Event,
  kind: TranscriptItem['kind'],
  text: string,
  meta?: Record<string, unknown>,
) {
  const key = e.stageId ?? '_run'
  const list = view.transcripts[key] ?? []
  const item: TranscriptItem = { seq: e.seq, ts: e.ts, kind, text, meta }
  const trimmed =
    list.length >= MAX_TRANSCRIPT ? list.slice(list.length - MAX_TRANSCRIPT + 1) : list
  view.transcripts = { ...view.transcripts, [key]: [...trimmed, item] }
}
