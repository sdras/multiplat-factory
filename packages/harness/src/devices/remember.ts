import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { runProcess } from '../exec.ts'

/** A device a run booted itself (not one it found running), so the run can stop it when it ends. */
export interface BootedDevice {
  kind: 'emulator' | 'simulator'
  /** The emulator serial or the simulator udid. */
  id: string
  bootedAt: string
}

const FILE = 'devices.json'

/** Devices this run booted, from `<runDir>/devices.json`. */
export function rememberedDevices(runDir: string): BootedDevice[] {
  const file = join(runDir, FILE)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as BootedDevice[]) : []
  } catch {
    return []
  }
}

/** Record a device the run just booted (idempotent per kind and id). */
export function rememberBootedDevice(runDir: string, device: Omit<BootedDevice, 'bootedAt'>): void {
  const all = rememberedDevices(runDir).filter(
    (d) => !(d.kind === device.kind && d.id === device.id),
  )
  all.push({ ...device, bootedAt: new Date().toISOString() })
  writeFileSync(join(runDir, FILE), JSON.stringify(all, null, 2))
}

export interface ReleaseOptions {
  /** Leave every device running (`MPF_KEEP_DEVICES=1`). */
  keep?: boolean
  /** Another live process holding the device's lane, if any; such a device is left alone. */
  heldByAnother: (lane: 'emulator' | 'simulator') => { pid: number } | undefined
  android?: { adb: string; env: NodeJS.ProcessEnv }
  xcode?: { env: NodeJS.ProcessEnv }
  log?: (message: string) => void
  /** Process runner (tests inject one). */
  exec?: typeof runProcess
}

/**
 * Stop the devices this run booted, unless told to keep them or another process is using the
 * lane. A headless emulator left behind burns most of a host core doing nothing; a user who ran
 * `mpf port` once should not find it still running a week later. Returns what was stopped.
 */
export async function releaseBootedDevices(
  runDir: string,
  opts: ReleaseOptions,
): Promise<string[]> {
  const devices = rememberedDevices(runDir)
  if (!devices.length || opts.keep) return []
  const exec = opts.exec ?? runProcess
  const stopped: string[] = []
  const kept: BootedDevice[] = []
  for (const device of devices) {
    const holder = opts.heldByAnother(device.kind)
    if (holder) {
      opts.log?.(
        `leaving the ${device.kind} ${device.id} running: pid ${holder.pid} holds its lane`,
      )
      kept.push(device)
      continue
    }
    try {
      if (device.kind === 'emulator') {
        if (!opts.android) throw new Error('no Android tools to stop it with')
        await exec({
          command: opts.android.adb,
          args: ['-s', device.id, 'emu', 'kill'],
          env: opts.android.env,
          timeoutMs: 20_000,
        })
      } else {
        await exec({
          command: 'xcrun',
          args: ['simctl', 'shutdown', device.id],
          env: opts.xcode?.env ?? process.env,
          timeoutMs: 60_000,
        })
      }
      stopped.push(`${device.kind} ${device.id}`)
    } catch (err) {
      opts.log?.(`could not stop the ${device.kind} ${device.id}: ${(err as Error).message}`)
      kept.push(device)
    }
  }
  writeFileSync(join(runDir, FILE), JSON.stringify(kept, null, 2))
  return stopped
}
