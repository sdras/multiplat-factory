import { existsSync } from 'node:fs'
import { join } from 'pathe'
import type { MpfConfig } from '@mpf/core'
import { runProcess, tryOutput } from '../exec.ts'

export interface XcodeTools {
  developerDir: string
  env: NodeJS.ProcessEnv
}

/**
 * Locate a full Xcode without requiring `xcode-select` to point at it:
 * config override, DEVELOPER_DIR, xcode-select, then /Applications/Xcode.app.
 */
export async function xcodeTools(
  config: MpfConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<XcodeTools | undefined> {
  if (process.platform !== 'darwin') return undefined
  const candidates = [
    config.toolchain.developerDir,
    env.DEVELOPER_DIR,
    await tryOutput('xcode-select', ['-p'], env),
    '/Applications/Xcode.app/Contents/Developer',
  ]
  const developerDir = candidates.find(
    (c): c is string =>
      Boolean(c) && /Xcode[^/]*\.app\/Contents\/Developer$/.test(c!) && existsSync(c!),
  )
  if (!developerDir) return undefined
  return { developerDir, env: { ...env, DEVELOPER_DIR: developerDir } }
}

export interface SimDevice {
  udid: string
  name: string
  state: string
  runtime: string
}

export async function listSimulators(tools: XcodeTools): Promise<SimDevice[]> {
  const out = await tryOutput(
    'xcrun',
    ['simctl', 'list', '-j', 'devices', 'available'],
    tools.env,
    60_000,
  )
  if (!out) return []
  const json = JSON.parse(out) as {
    devices: Record<string, { udid: string; name: string; state: string }[]>
  }
  return Object.entries(json.devices).flatMap(([runtime, list]) =>
    list.map((d) => ({ udid: d.udid, name: d.name, state: d.state, runtime })),
  )
}

async function newestIosRuntime(
  tools: XcodeTools,
): Promise<{ identifier: string; deviceTypes: string[] } | undefined> {
  const out = await tryOutput('xcrun', ['simctl', 'list', '-j', 'runtimes'], tools.env, 60_000)
  if (!out) return undefined
  const json = JSON.parse(out) as {
    runtimes: {
      identifier: string
      platform: string
      isAvailable: boolean
      version: string
      supportedDeviceTypes?: { identifier: string; name: string }[]
    }[]
  }
  const ios = json.runtimes
    .filter((r) => r.platform === 'iOS' && r.isAvailable)
    .sort((a, b) => compareVersions(b.version, a.version))
  const best = ios[0]
  if (!best) return undefined
  return {
    identifier: best.identifier,
    deviceTypes: (best.supportedDeviceTypes ?? []).map((d) => d.identifier),
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

export interface SimulatorHandle {
  udid: string
  /** Shuts the simulator down only if this call booted it. */
  stop(): Promise<void>
}

/** Reuse a booted iPhone simulator, else boot (creating if needed) a dedicated device. */
export async function ensureSimulator(
  tools: XcodeTools,
  name = 'mpf-iphone',
  log: (m: string) => void = () => {},
  signal?: AbortSignal,
  timeoutMs = 240_000,
): Promise<SimulatorHandle> {
  const devices = await listSimulators(tools)
  const booted = devices.find((d) => d.state === 'Booted' && /iphone/i.test(d.name))
  if (booted) {
    log(`using booted simulator ${booted.name} (${booted.udid})`)
    return { udid: booted.udid, stop: async () => {} }
  }
  let device = devices.find((d) => d.name === name)
  if (!device) {
    const runtime = await newestIosRuntime(tools)
    if (!runtime) throw new Error('no iOS simulator runtime is installed')
    const preferred = [
      'iPhone-16',
      'iPhone-17',
      'iPhone-16-Pro',
      'iPhone-15',
      'iPhone-SE-3rd-generation',
    ]
    const type =
      preferred
        .map((p) => `com.apple.CoreSimulator.SimDeviceType.${p}`)
        .find((t) => runtime.deviceTypes.includes(t)) ??
      runtime.deviceTypes.find((t) => t.includes('iPhone'))
    if (!type) throw new Error('no iPhone device type available for the newest iOS runtime')
    log(
      `creating simulator ${name} (${type.split('.').pop()}, ${runtime.identifier.split('.').pop()})`,
    )
    const created = await runProcess({
      command: 'xcrun',
      args: ['simctl', 'create', name, type, runtime.identifier],
      env: tools.env,
      timeoutMs: 120_000,
    })
    if (created.exitCode !== 0) throw new Error(`simctl create failed: ${created.stderr.trim()}`)
    device = { udid: created.stdout.trim(), name, state: 'Shutdown', runtime: runtime.identifier }
  }
  if (signal?.aborted) throw new Error('aborted')
  log(`booting simulator ${device.name} (${device.udid})`)
  const boot = await runProcess({
    command: 'xcrun',
    args: ['simctl', 'boot', device.udid],
    env: tools.env,
    timeoutMs: 120_000,
  })
  if (boot.exitCode !== 0 && !/already booted|current state: Booted/i.test(boot.stderr)) {
    throw new Error(`simctl boot failed: ${boot.stderr.trim()}`)
  }
  const status = await runProcess({
    command: 'xcrun',
    args: ['simctl', 'bootstatus', device.udid, '-b'],
    env: tools.env,
    timeoutMs,
    signal,
  })
  if (status.exitCode !== 0)
    throw new Error(`simulator did not finish booting: ${status.stderr.trim().slice(-500)}`)
  const udid = device.udid
  return {
    udid,
    stop: async () => {
      await runProcess({
        command: 'xcrun',
        args: ['simctl', 'shutdown', udid],
        env: tools.env,
        timeoutMs: 60_000,
      }).catch(() => {})
    },
  }
}

export async function installApp(tools: XcodeTools, udid: string, appPath: string): Promise<void> {
  const r = await runProcess({
    command: 'xcrun',
    args: ['simctl', 'install', udid, appPath],
    env: tools.env,
    timeoutMs: 180_000,
  })
  if (r.exitCode !== 0) throw new Error(`simctl install failed: ${r.stderr.trim().slice(-500)}`)
}

export interface IosLaunchCheck {
  ok: boolean
  crash?: string
  /** What `dismissSystemDialogs` found over the simulator before the launch, when anything. */
  dismissedDialog?: string
}

/**
 * Launch (optionally through a deep link), wait, and confirm the process is still alive.
 * Environment for the app goes through SIMCTL_CHILD_* variables.
 */
export async function launchApp(
  tools: XcodeTools,
  udid: string,
  bundleId: string,
  opts: { url?: string; env?: Record<string, string>; waitMs?: number } = {},
): Promise<IosLaunchCheck> {
  const dismissedDialog = await dismissSystemDialogs(tools, udid, bundleId).catch(() => undefined)
  const result = (check: IosLaunchCheck): IosLaunchCheck =>
    dismissedDialog ? { ...check, dismissedDialog } : check
  await runProcess({
    command: 'xcrun',
    args: ['simctl', 'terminate', udid, bundleId],
    env: tools.env,
    timeoutMs: 30_000,
  }).catch(() => {})
  const env: NodeJS.ProcessEnv = { ...tools.env }
  for (const [k, v] of Object.entries(opts.env ?? {})) env[`SIMCTL_CHILD_${k}`] = v
  const launch = await runProcess({
    command: 'xcrun',
    args: ['simctl', 'launch', udid, bundleId],
    env,
    timeoutMs: 60_000,
  })
  if (launch.exitCode !== 0)
    return result({
      ok: false,
      crash: `simctl launch failed: ${(launch.stderr || launch.stdout).trim().slice(-500)}`,
    })
  if (opts.url) {
    const open = await runProcess({
      command: 'xcrun',
      args: ['simctl', 'openurl', udid, opts.url],
      env: tools.env,
      timeoutMs: 30_000,
    })
    if (open.exitCode !== 0)
      return result({
        ok: false,
        crash: `simctl openurl failed: ${open.stderr.trim().slice(-300)}`,
      })
  }
  await new Promise((r) => setTimeout(r, opts.waitMs ?? 5000))
  const running = await appRunning(tools, udid, bundleId)
  return result(
    running
      ? { ok: true }
      : { ok: false, crash: 'process is not running after launch (crashed or exited)' },
  )
}

/**
 * The Android counterpart clears ANR dialogs and choosers; on the simulator the equivalent is the
 * system "Open in <app>?" alert that `simctl openurl` and Maestro's `openLink` raise for a custom
 * scheme, and which hides the whole app from Maestro's hierarchy while it is up. That alert is
 * SpringBoard's: `simctl` can neither list SpringBoard's alerts nor inject a tap or key event
 * (`io` only captures screenshots and video, `ui` only sets appearance options, and `launchctl list`
 * shows nothing because SpringBoard is always running), so without a UI driver there is no reliable
 * way to see or dismiss it. This is deliberately a no-op that always resolves to undefined; it keeps
 * the launch path symmetric with Android and gives a future driver-backed implementation a home.
 * The scaffolds avoid the alert by navigating through the `mpf_route` launch argument instead of
 * `openurl`; when one is stuck, shut the simulator down (`SimulatorHandle.stop`) and boot again.
 */
export async function dismissSystemDialogs(
  tools: XcodeTools,
  udid: string,
  appId: string,
): Promise<string | undefined> {
  void tools
  void udid
  void appId
  return undefined
}

export async function appRunning(
  tools: XcodeTools,
  udid: string,
  bundleId: string,
): Promise<boolean> {
  const list = await tryOutput(
    'xcrun',
    ['simctl', 'spawn', udid, 'launchctl', 'list'],
    tools.env,
    30_000,
  )
  return Boolean(list && list.includes(`UIKitApplication:${bundleId}`))
}

export async function terminateApp(
  tools: XcodeTools,
  udid: string,
  bundleId: string,
): Promise<void> {
  await runProcess({
    command: 'xcrun',
    args: ['simctl', 'terminate', udid, bundleId],
    env: tools.env,
    timeoutMs: 30_000,
  }).catch(() => {})
}

export async function uninstallApp(
  tools: XcodeTools,
  udid: string,
  bundleId: string,
): Promise<void> {
  await runProcess({
    command: 'xcrun',
    args: ['simctl', 'uninstall', udid, bundleId],
    env: tools.env,
    timeoutMs: 60_000,
  }).catch(() => {})
}

export async function simScreenshot(
  tools: XcodeTools,
  udid: string,
  file: string,
): Promise<boolean> {
  const r = await runProcess({
    command: 'xcrun',
    args: ['simctl', 'io', udid, 'screenshot', file],
    env: tools.env,
    timeoutMs: 30_000,
  })
  return r.exitCode === 0 && existsSync(file)
}

export function derivedProductsDir(derivedData: string): string {
  return join(derivedData, 'Build', 'Products', 'Debug-iphonesimulator')
}
