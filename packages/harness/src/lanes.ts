import PQueue from 'p-queue'

export type LaneName =
  'xcodebuild' | 'gradle' | 'simulator' | 'emulator' | 'web' | 'agent' | (string & {})

export interface LaneLimits {
  [lane: string]: number
}

/**
 * Serializes contended resources (one xcodebuild at a time, one emulator, etc.).
 * Unknown lanes default to concurrency 1.
 */
export class Lanes {
  private queues = new Map<string, PQueue>()

  constructor(private limits: LaneLimits = {}) {}

  run<T>(lane: LaneName, fn: () => Promise<T>): Promise<T> {
    let q = this.queues.get(lane)
    if (!q) {
      q = new PQueue({ concurrency: this.limits[lane] ?? 1 })
      this.queues.set(lane, q)
    }
    return q.add(fn) as Promise<T>
  }

  pending(lane: LaneName): number {
    const q = this.queues.get(lane)
    return q ? q.size + q.pending : 0
  }
}
