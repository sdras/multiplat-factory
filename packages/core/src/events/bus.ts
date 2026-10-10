import type { Event, EventPayload } from '../schemas/index.ts'
import type { RunStore } from '../store/types.ts'
import { nowIso } from '../ids.ts'

export type EventListener = (event: Event) => void

/**
 * Persists every event through the store (which assigns `seq`) and fans it out
 * to per-run and global subscribers. Subscribers that throw never break emit.
 */
export class RunEventBus {
  private perRun = new Map<string, Set<EventListener>>()
  private global = new Set<EventListener>()

  constructor(private store: RunStore) {}

  emit(runId: string, stageId: string | undefined, payload: EventPayload): Event {
    const event = this.store.appendEvent({ runId, stageId, ts: nowIso(), ...payload })
    for (const l of this.perRun.get(runId) ?? []) safe(l, event)
    for (const l of this.global) safe(l, event)
    return event
  }

  subscribe(runId: string, listener: EventListener): () => void {
    let set = this.perRun.get(runId)
    if (!set) {
      set = new Set()
      this.perRun.set(runId, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set && set.size === 0) this.perRun.delete(runId)
    }
  }

  subscribeAll(listener: EventListener): () => void {
    this.global.add(listener)
    return () => this.global.delete(listener)
  }
}

function safe(listener: EventListener, event: Event) {
  try {
    listener(event)
  } catch {
    // listeners are observers; never let one break the pipeline
  }
}
