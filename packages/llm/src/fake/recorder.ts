import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'pathe'
import type { AgentEvent } from '../agent.ts'

/**
 * Appends worker events as JSONL so a run can be replayed without credentials.
 * Enabled by passing a path; the replayer lands with the first real adapters.
 */
export class AgentRecorder {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true })
  }

  record(stageId: string, event: AgentEvent): void {
    appendFileSync(
      this.path,
      `${JSON.stringify({ stageId, ts: new Date().toISOString(), ...event })}\n`,
    )
  }
}
