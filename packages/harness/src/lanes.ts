import PQueue from 'p-queue'
import { join } from 'pathe'
import { acquireLaneLock, laneLockPath, type LaneLockOptions } from './lanelock.ts'

export type LaneName =
  'xcodebuild' | 'gradle' | 'simulator' | 'emulator' | 'web' | 'agent' | (string & {})

export interface LaneLimits {
  [lane: string]: number
}

export interface LaneOptions {
  /**
   * Run data directory. When given, the exclusive lanes also take a file lock under
   * `<dataDir>/locks/<lane>.lock`, so two processes (a daemon and a CLI, two terminals) never drive
   * the same device at once. Without it, lanes serialize only inside this process.
   */
  dataDir?: string
  /** Lanes that are exclusive across processes. Default: the device lanes. */
  exclusive?: LaneName[]
  /** Receives the waiting and takeover lines of the file lock. Silent by default. */
  log?: (message: string) => void
  /** File lock timing overrides (tests). */
  lock?: Pick<LaneLockOptions, 'pollMs' | 'staleMs' | 'maxWaitMs' | 'logEveryMs'>
}

/** Lanes that stand for one physical device per machine, not one process. */
export const EXCLUSIVE_LANES: readonly LaneName[] = ['simulator', 'emulator']

/**
 * Serializes contended resources (one xcodebuild at a time, one emulator, etc.).
 * Unknown lanes default to concurrency 1. Callers in this process queue up in order; a device
 * lane's turn additionally waits for the machine-wide file lock when a data directory is set.
 */
export class Lanes {
  private readonly queues: Map<string, PQueue>
  private readonly exclusive: Set<string>

  constructor(
    private readonly limits: LaneLimits = {},
    private readonly options: LaneOptions = {},
    /** Shared with the instances `withLog` derives, so they stay one set of queues. */
    queues?: Map<string, PQueue>,
  ) {
    this.queues = queues ?? new Map()
    this.exclusive = new Set(options.exclusive ?? EXCLUSIVE_LANES)
  }

  /** The same lanes (shared queues and locks) with lock messages routed to `log`, e.g. a stage's log. */
  withLog(log: (message: string) => void): Lanes {
    return new Lanes(this.limits, { ...this.options, log }, this.queues)
  }

  /** The lock file a lane takes, or undefined when it serializes only inside this process. */
  lockPath(lane: LaneName): string | undefined {
    const dir = this.lockDir(lane)
    return dir ? laneLockPath(dir, lane) : undefined
  }

  run<T>(lane: LaneName, fn: () => Promise<T>): Promise<T> {
    const q = this.queue(lane)
    const dir = this.lockDir(lane)
    if (!dir) return q.add(fn) as Promise<T>
    return q.add(async () => {
      const release = await acquireLaneLock(lane, {
        dir,
        log: this.options.log,
        ...this.options.lock,
      })
      try {
        return await fn()
      } finally {
        release()
      }
    }) as Promise<T>
  }

  pending(lane: LaneName): number {
    const q = this.queues.get(lane)
    return q ? q.size + q.pending : 0
  }

  private queue(lane: LaneName): PQueue {
    let q = this.queues.get(lane)
    if (!q) {
      q = new PQueue({ concurrency: this.limits[lane] ?? 1 })
      this.queues.set(lane, q)
    }
    return q
  }

  private lockDir(lane: LaneName): string | undefined {
    const { dataDir } = this.options
    if (!dataDir || !this.exclusive.has(lane)) return undefined
    return join(dataDir, 'locks')
  }
}
