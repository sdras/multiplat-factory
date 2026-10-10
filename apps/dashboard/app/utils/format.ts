import type { Run, Stage, StageKind, StageStatus } from '@mpf/core/schemas'

export const TERMINAL_RUN = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
export const ACTIVE_RUN = new Set(['queued', 'running', 'paused', 'waiting_human'])
export const LIVE_STATUSES = new Set(['running', 'waiting_human'])

const LABELS: Record<string, string> = {
  waiting_human: 'waiting for you',
  human: 'checkpoint',
}

/** Human label for a run, stage, test or check status. */
export function statusLabel(status: string): string {
  return LABELS[status] ?? status.replace(/_/g, ' ')
}

export function isLive(status: string): boolean {
  return LIVE_STATUSES.has(status)
}

export function shortId(id: string): string {
  return id.slice(-8)
}

export function money(n: number, digits = 2): string {
  return `$${n.toFixed(digits)}`
}

/** m:ss, or h:mm:ss past an hour. Never negative. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** "Today 14:07", "Yesterday 16:04", or "Sep 24, 15:22". */
export function when(iso: string, now = Date.now()): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const day = new Date(d).setHours(0, 0, 0, 0)
  const today = new Date(now).setHours(0, 0, 0, 0)
  const diff = Math.round((today - day) / 86_400_000)
  if (diff === 0) return `Today ${time}`
  if (diff === 1) return `Yesterday ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

export function runElapsed(run: Run, now: number): number {
  const start = new Date(run.createdAt).getTime()
  const end = TERMINAL_RUN.has(run.status) ? new Date(run.updatedAt).getTime() : now
  return end - start
}

export function stageWindow(stage: Stage, now: number): string {
  if (!stage.startedAt) return 'not started'
  const start = new Date(stage.startedAt).getTime()
  const end = stage.endedAt ? new Date(stage.endedAt).getTime() : now
  return `${clock(end - start)}${stage.endedAt ? '' : ' so far'}`
}

const CORE_KINDS: ReadonlySet<StageKind> = new Set(['core.extract', 'core.vectors', 'core.build'])

/** Which timeline lane a stage belongs to. */
export function laneOf(stage: Stage): string {
  if (stage.target) return stage.target
  if (CORE_KINDS.has(stage.kind)) return 'core'
  if (stage.kind === 'report') return 'finish'
  return 'analyze'
}

export const LANE_TITLES: Record<string, string> = {
  analyze: 'Analyze',
  core: 'Core',
  web: 'Web',
  ios: 'iOS',
  android: 'Android',
  finish: 'Finish',
}

/** Collapses a group of stages to the one status that matters for a glance. */
export function groupStatus(stages: Stage[]): StageStatus {
  if (!stages.length) return 'pending'
  const has = (s: StageStatus) => stages.some((x) => x.status === s)
  if (has('waiting_human')) return 'waiting_human'
  if (has('failed') || has('blocked')) return 'failed'
  if (has('running')) return 'running'
  if (has('paused')) return 'paused'
  if (has('cancelled')) return 'cancelled'
  if (stages.every((x) => x.status === 'skipped')) return 'skipped'
  if (stages.every((x) => x.status === 'succeeded' || x.status === 'skipped')) return 'succeeded'
  return 'pending'
}

/** Short description of a tool call's input for the transcript. */
export function toolInputSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url']) {
    const v = o[key]
    if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 117)}…` : v
  }
  const json = JSON.stringify(input)
  return json.length > 100 ? `${json.slice(0, 97)}…` : json
}
