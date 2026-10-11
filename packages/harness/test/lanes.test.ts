import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Lanes } from '../src/lanes.ts'
import { LANE_LOCK_DEFAULTS, laneLockPath, type LaneLockHolder } from '../src/lanelock.ts'

const fast = { pollMs: 10, logEveryMs: 0 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mpf-lanes-'))
}

function simulatorLock(dataDir: string): string {
  return laneLockPath(join(dataDir, 'locks'), 'simulator')
}

function writeLock(path: string, holder: LaneLockHolder): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(holder))
}

function readHolder(path: string): LaneLockHolder {
  return JSON.parse(readFileSync(path, 'utf8')) as LaneLockHolder
}

describe('Lanes with a data directory', () => {
  it('serializes a simulator task across two instances through the lock file', async () => {
    const dataDir = tempDataDir()
    const path = simulatorLock(dataDir)
    const a = new Lanes({}, { dataDir, lock: fast })
    const b = new Lanes({}, { dataDir, lock: fast })
    expect(a.lockPath('simulator')).toBe(path)

    const marks: Record<string, number> = {}
    let aStarted!: () => void
    const started = new Promise<void>((r) => (aStarted = r))
    const first = a.run('simulator', async () => {
      marks.aStart = performance.now()
      aStarted()
      expect(readHolder(path)).toMatchObject({ pid: process.pid, lane: 'simulator' })
      expect(Date.parse(readHolder(path).since)).not.toBeNaN()
      await sleep(80)
      marks.aEnd = performance.now()
    })
    await started
    const second = b.run('simulator', async () => {
      marks.bStart = performance.now()
    })
    await Promise.all([first, second])

    expect(marks.bStart).toBeGreaterThanOrEqual(marks.aEnd!)
    expect(existsSync(path)).toBe(false)
  })

  it('removes the lock file after the task, also when the task throws', async () => {
    const dataDir = tempDataDir()
    const path = simulatorLock(dataDir)
    const lanes = new Lanes({}, { dataDir, lock: fast })
    await expect(
      lanes.run('simulator', async () => {
        expect(existsSync(path)).toBe(true)
        throw new Error('flow failed')
      }),
    ).rejects.toThrow('flow failed')
    expect(existsSync(path)).toBe(false)
  })

  it('takes over a lock left by a pid that is not running and says so', async () => {
    const dataDir = tempDataDir()
    const path = simulatorLock(dataDir)
    writeLock(path, { pid: 999999, since: new Date().toISOString(), lane: 'simulator' })
    const log: string[] = []
    const lanes = new Lanes(
      {},
      { dataDir, log: (m) => log.push(m), lock: { ...fast, maxWaitMs: 2_000 } },
    )

    const result = await lanes.run('simulator', async () => readHolder(path))

    expect(result).toMatchObject({ pid: process.pid, lane: 'simulator' })
    expect(log).toContainEqual(
      expect.stringMatching(
        /^taking over the simulator lock held by pid 999999 since .*: pid 999999 is not running$/,
      ),
    )
    expect(existsSync(path)).toBe(false)
  })

  it('takes over a lock older than the stale limit even while its holder is alive', async () => {
    const dataDir = tempDataDir()
    const path = simulatorLock(dataDir)
    const since = new Date(Date.now() - LANE_LOCK_DEFAULTS.staleMs - 60_000).toISOString()
    writeLock(path, { pid: process.ppid, since, lane: 'simulator' })
    const log: string[] = []
    const lanes = new Lanes(
      {},
      { dataDir, log: (m) => log.push(m), lock: { ...fast, maxWaitMs: 2_000 } },
    )

    await lanes.run('simulator', async () => {})

    expect(log).toContainEqual(
      expect.stringMatching(
        /^taking over the simulator lock held by pid \d+ since .*: it is 3h 1m old, past the 3h limit$/,
      ),
    )
    expect(existsSync(path)).toBe(false)
  })

  it('takes over a lock carrying this pid that this process does not hold', async () => {
    const dataDir = tempDataDir()
    const path = simulatorLock(dataDir)
    writeLock(path, { pid: process.pid, since: new Date().toISOString(), lane: 'simulator' })
    const log: string[] = []
    const lanes = new Lanes(
      {},
      { dataDir, log: (m) => log.push(m), lock: { ...fast, maxWaitMs: 2_000 } },
    )
    await lanes.run('simulator', async () => {})
    expect(log[0]).toMatch(/earlier process that had this pid/)
    expect(existsSync(path)).toBe(false)
  })

  it('waits while a live process holds the device, logs the holder, and gives up naming it', async () => {
    const dataDir = tempDataDir()
    const path = simulatorLock(dataDir)
    writeLock(path, { pid: process.ppid, since: new Date().toISOString(), lane: 'simulator' })
    const log: string[] = []
    const lanes = new Lanes(
      {},
      { dataDir, log: (m) => log.push(m), lock: { pollMs: 10, maxWaitMs: 60, logEveryMs: 0 } },
    )

    await expect(lanes.run('simulator', async () => 'never')).rejects.toThrow(
      new RegExp(
        `^gave up waiting for the simulator after \\d+s: held by pid ${process.ppid} since `,
      ),
    )

    expect(log[0]).toMatch(
      new RegExp(
        `^waiting for the simulator: held by pid ${process.ppid} since (\\d{4}-\\d{2}-\\d{2} )?\\d{2}:\\d{2}$`,
      ),
    )
    expect(log.length).toBeGreaterThan(1)
    // The holder's file is theirs: still there, untouched.
    expect(readHolder(path).pid).toBe(process.ppid)
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('leaves a lock file that another process took over in the meantime', async () => {
    const dataDir = tempDataDir()
    const path = simulatorLock(dataDir)
    const lanes = new Lanes({}, { dataDir, lock: fast })
    await lanes.run('simulator', async () => {
      writeLock(path, { pid: process.ppid, since: new Date().toISOString(), lane: 'simulator' })
    })
    expect(readHolder(path).pid).toBe(process.ppid)
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('does not create lock files for the build lanes', async () => {
    const dataDir = tempDataDir()
    const lanes = new Lanes({}, { dataDir, lock: fast })
    for (const lane of ['xcodebuild', 'gradle', 'web', 'agent'] as const) {
      expect(lanes.lockPath(lane)).toBeUndefined()
      await lanes.run(lane, async () => {
        expect(existsSync(join(dataDir, 'locks'))).toBe(false)
      })
    }
    expect(existsSync(join(dataDir, 'locks'))).toBe(false)
    expect(lanes.lockPath('emulator')).toBe(join(dataDir, 'locks', 'emulator.lock'))
  })

  it('shares queues and locks between withLog views and routes their messages', async () => {
    const dataDir = tempDataDir()
    const path = simulatorLock(dataDir)
    writeLock(path, { pid: 999999, since: new Date().toISOString(), lane: 'simulator' })
    const base = new Lanes({}, { dataDir, lock: { ...fast, maxWaitMs: 2_000 } })
    const stageLog: string[] = []
    const scoped = base.withLog((m) => stageLog.push(m))

    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const order: string[] = []
    const first = scoped.run('simulator', async () => {
      await gate
      order.push('first')
    })
    const second = base.run('simulator', async () => {
      order.push('second')
    })
    await sleep(30)
    expect(base.pending('simulator')).toBe(2)
    expect(scoped.pending('simulator')).toBe(2)
    open()
    await Promise.all([first, second])

    expect(order).toEqual(['first', 'second'])
    expect(stageLog.some((m) => m.startsWith('taking over the simulator lock'))).toBe(true)
    expect(existsSync(path)).toBe(false)
  })
})

describe('Lanes without a data directory', () => {
  it('serializes in process only and never touches the disk', async () => {
    const lanes = new Lanes({ simulator: 1 })
    expect(lanes.lockPath('simulator')).toBeUndefined()
    const order: string[] = []
    await Promise.all([
      lanes.run('simulator', async () => {
        order.push('a-start')
        await sleep(20)
        order.push('a-end')
      }),
      lanes.run('simulator', async () => {
        order.push('b')
      }),
    ])
    expect(order).toEqual(['a-start', 'a-end', 'b'])
  })
})
