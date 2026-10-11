import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'pathe'

/** What a lock file records about its holder. */
export interface LaneLockHolder {
  pid: number
  /** ISO timestamp of the acquisition. */
  since: string
  lane: string
}

export interface LaneLockOptions {
  /** Directory the lock files live in (created on demand). */
  dir: string
  /** Receives the waiting and takeover lines. Silent by default. */
  log?: (message: string) => void
  /** How often to look again while another process holds the lane. Default 2 s. */
  pollMs?: number
  /** A lock older than this is taken over even if its holder is still running. Default 3 h. */
  staleMs?: number
  /** Give up (throw) after waiting this long. Default 60 min. */
  maxWaitMs?: number
  /** Repeat the waiting line at most this often while the holder stays the same. Default 30 s. */
  logEveryMs?: number
}

export const LANE_LOCK_DEFAULTS = {
  pollMs: 2_000,
  staleMs: 3 * 60 * 60 * 1_000,
  maxWaitMs: 60 * 60 * 1_000,
  logEveryMs: 30_000,
} as const

/** A lock file nobody could parse is taken over once it has not changed for this long. */
const UNREADABLE_GRACE_MS = 30_000

/** Lock paths this process currently holds, so a file carrying our pid is recognized as ours. */
const heldHere = new Set<string>()

export function laneLockPath(dir: string, lane: string): string {
  return join(dir, `${lane}.lock`)
}

interface LockFile {
  holder?: LaneLockHolder
  mtimeMs: number
  ino: number
}

/**
 * Takes the cross-process lock for a lane: `<dir>/<lane>.lock`, created exclusively with the
 * holder's `{ pid, since, lane }`. An existing lock whose pid is gone, or that is older than
 * `staleMs`, is taken over; a live one is polled until it goes away or `maxWaitMs` passes.
 * Resolves to the release function, which removes the file only while it still names this pid.
 */
export async function acquireLaneLock(lane: string, opts: LaneLockOptions): Promise<() => void> {
  const pollMs = opts.pollMs ?? LANE_LOCK_DEFAULTS.pollMs
  const staleMs = opts.staleMs ?? LANE_LOCK_DEFAULTS.staleMs
  const maxWaitMs = opts.maxWaitMs ?? LANE_LOCK_DEFAULTS.maxWaitMs
  const logEveryMs = opts.logEveryMs ?? LANE_LOCK_DEFAULTS.logEveryMs
  const log = opts.log ?? (() => {})
  const path = laneLockPath(opts.dir, lane)
  mkdirSync(opts.dir, { recursive: true })

  const started = Date.now()
  let lastLogAt = 0
  let lastHolderKey = ''
  for (;;) {
    if (tryCreate(path, lane)) {
      heldHere.add(path)
      const waited = Date.now() - started
      if (waited >= pollMs) log(`the ${lane} is free after ${formatDuration(waited)}`)
      return () => release(path)
    }
    const current = readLock(path)
    if (!current) continue // released between our attempt and our read
    const now = Date.now()
    const stale = staleReason(current, path, now, staleMs)
    if (stale) {
      log(`taking over the ${lane} lock ${describeHolder(current)}: ${stale}`)
      removeIfUnchanged(path, current.ino)
      continue
    }
    if (now - started >= maxWaitMs) {
      throw new Error(
        `gave up waiting for the ${lane} after ${formatDuration(now - started)}: ` +
          `${describeHolder(current)} (${path})`,
      )
    }
    const key = `${current.holder?.pid ?? 'unreadable'}@${current.holder?.since ?? current.mtimeMs}`
    if (key !== lastHolderKey || now - lastLogAt >= logEveryMs) {
      log(`waiting for the ${lane}: ${describeHolder(current)}`)
      lastHolderKey = key
      lastLogAt = now
    }
    await sleep(pollMs)
  }
}

function tryCreate(path: string, lane: string): boolean {
  const holder: LaneLockHolder = { pid: process.pid, since: new Date().toISOString(), lane }
  try {
    writeFileSync(path, JSON.stringify(holder), { flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

function readLock(path: string): LockFile | undefined {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  try {
    const st = fstatSync(fd)
    const text = readFileSync(fd, 'utf8')
    return { holder: parseHolder(text), mtimeMs: st.mtimeMs, ino: st.ino }
  } finally {
    closeSync(fd)
  }
}

function parseHolder(text: string): LaneLockHolder | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { pid, since, lane } = parsed as Record<string, unknown>
    if (typeof pid !== 'number' || typeof since !== 'string') return undefined
    return { pid, since, lane: typeof lane === 'string' ? lane : '' }
  } catch {
    return undefined
  }
}

function staleReason(
  lock: LockFile,
  path: string,
  now: number,
  staleMs: number,
): string | undefined {
  const { holder } = lock
  if (!holder) {
    return now - lock.mtimeMs >= UNREADABLE_GRACE_MS ? 'the lock file is unreadable' : undefined
  }
  if (holder.pid === process.pid && !heldHere.has(path)) {
    return 'it was left by an earlier process that had this pid'
  }
  if (!pidAlive(holder.pid)) return `pid ${holder.pid} is not running`
  const sinceMs = Date.parse(holder.since)
  const age = now - (Number.isNaN(sinceMs) ? lock.mtimeMs : sinceMs)
  if (age >= staleMs)
    return `it is ${formatDuration(age)} old, past the ${formatDuration(staleMs)} limit`
  return undefined
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: alive but owned by someone else. Anything else (ESRCH) means gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Removes a lock file we judged stale, unless it was replaced since we read it. */
function removeIfUnchanged(path: string, ino: number): void {
  try {
    const st = statSync(path)
    if (ino && st.ino && st.ino !== ino) return
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

function release(path: string): void {
  heldHere.delete(path)
  const current = readLock(path)
  if (current?.holder?.pid !== process.pid) return
  try {
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

function describeHolder(lock: LockFile): string {
  if (!lock.holder) return `the lock file is unreadable (changed ${formatSince(lock.mtimeMs)})`
  return `held by pid ${lock.holder.pid} since ${formatSince(lock.holder.since)}`
}

/** `10:42` for today, `2026-10-09 10:42` for another day, the raw value if it is not a date. */
export function formatSince(value: string | number): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  if (sameDay) return hhmm
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h}h ${rest}m` : `${h}h`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
