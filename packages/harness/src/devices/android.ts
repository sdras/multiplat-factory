import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { execa, type ResultPromise } from 'execa'
import type { MpfConfig } from '@mpf/core'
import { runProcess } from '../exec.ts'
import { resolveAndroidHome, resolveJavaHome } from '../toolchain/checks/android.ts'

export interface AndroidTools {
  sdk: string
  adb: string
  emulator: string
  javaHome?: string
  /** Environment to hand to Gradle and the SDK tools. */
  env: NodeJS.ProcessEnv
}

/** Discover the SDK and JDK generically; returns undefined when the SDK is absent. */
export async function androidTools(
  config: MpfConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AndroidTools | undefined> {
  const ctx = { env, platform: process.platform, toolchain: config.toolchain }
  const brewPrefix =
    process.platform === 'darwin'
      ? (
          await runProcess({ command: 'brew', args: ['--prefix'], env, timeoutMs: 10_000 }).catch(
            () => undefined,
          )
        )?.stdout.trim()
      : undefined
  const sdk = resolveAndroidHome(ctx, brewPrefix || undefined)
  if (!sdk) return undefined
  const javaHome = await resolveJavaHome(ctx)
  const exe = process.platform === 'win32' ? '.exe' : ''
  const merged: NodeJS.ProcessEnv = {
    ...env,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    PATH: [
      join(sdk, 'platform-tools'),
      join(sdk, 'emulator'),
      javaHome ? join(javaHome, 'bin') : '',
      env.PATH ?? '',
    ]
      .filter(Boolean)
      .join(':'),
  }
  return {
    sdk,
    adb: join(sdk, 'platform-tools', `adb${exe}`),
    emulator: join(sdk, 'emulator', `emulator${exe}`),
    javaHome,
    env: merged,
  }
}

export interface Device {
  serial: string
  state: string
}

export async function listDevices(tools: AndroidTools): Promise<Device[]> {
  const r = await runProcess({
    command: tools.adb,
    args: ['devices'],
    env: tools.env,
    timeoutMs: 20_000,
  })
  return r.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[0])
    .map((p) => ({ serial: p[0]!, state: p[1]! }))
}

export interface EmulatorHandle {
  serial: string
  /** Stops the emulator only if this call started it. */
  stop(): Promise<void>
}

export async function listAvds(tools: AndroidTools): Promise<string[]> {
  const r = await runProcess({
    command: tools.emulator,
    args: ['-list-avds'],
    env: tools.env,
    timeoutMs: 20_000,
  })
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('INFO'))
}

/**
 * Reuse a booted emulator when one is online; otherwise boot `avd` headless and wait
 * for `sys.boot_completed`. Callers hold the `emulator` lane while they use it.
 */
export async function ensureEmulator(
  tools: AndroidTools,
  avd: string,
  log: (m: string) => void,
  signal?: AbortSignal,
  timeoutMs = 300_000,
): Promise<EmulatorHandle> {
  const online = (await listDevices(tools)).find(
    (d) => d.serial.startsWith('emulator-') && d.state === 'device',
  )
  if (online && (await booted(tools, online.serial))) {
    log(`using running emulator ${online.serial}`)
    return { serial: online.serial, stop: async () => {} }
  }
  const avds = await listAvds(tools)
  if (!avds.includes(avd)) {
    throw new Error(
      `AVD "${avd}" not found (have: ${avds.join(', ') || 'none'}); create one with avdmanager or run mpf doctor`,
    )
  }
  log(`booting emulator ${avd} (headless)`)
  const child: ResultPromise = execa(
    tools.emulator,
    [
      '-avd',
      avd,
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      '-no-snapshot',
      '-gpu',
      'swiftshader_indirect',
      '-netdelay',
      'none',
      '-netspeed',
      'full',
    ],
    {
      env: tools.env,
      reject: false,
      cleanup: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      forceKillAfterDelay: 5000,
    },
  )
  let stderr = ''
  child.stderr?.on('data', (b: Buffer) => {
    stderr += b.toString()
  })
  const deadline = Date.now() + timeoutMs
  let serial: string | undefined
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      child.kill('SIGTERM')
      throw new Error('aborted')
    }
    const devices = await listDevices(tools)
    const emu = devices.find((d) => d.serial.startsWith('emulator-') && d.state === 'device')
    if (emu && (await booted(tools, emu.serial))) {
      serial = emu.serial
      break
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  if (!serial) {
    child.kill('SIGTERM')
    throw new Error(
      `emulator did not boot within ${timeoutMs / 1000}s${stderr ? `: ${stderr.slice(-800)}` : ''}`,
    )
  }
  await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'shell', 'settings', 'put', 'global', 'animator_duration_scale', '0'],
    env: tools.env,
    timeoutMs: 10_000,
  })
  await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'shell', 'settings', 'put', 'global', 'transition_animation_scale', '0'],
    env: tools.env,
    timeoutMs: 10_000,
  })
  await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'shell', 'settings', 'put', 'global', 'window_animation_scale', '0'],
    env: tools.env,
    timeoutMs: 10_000,
  })
  log(`emulator ${serial} booted`)
  return {
    serial,
    stop: async () => {
      await runProcess({
        command: tools.adb,
        args: ['-s', serial!, 'emu', 'kill'],
        env: tools.env,
        timeoutMs: 15_000,
      }).catch(() => {})
      child.kill('SIGTERM')
      await child.catch(() => {})
    },
  }
}

async function booted(tools: AndroidTools, serial: string): Promise<boolean> {
  const r = await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
    env: tools.env,
    timeoutMs: 10_000,
  }).catch(() => undefined)
  return r?.stdout.trim() === '1'
}

export async function installApk(tools: AndroidTools, serial: string, apk: string): Promise<void> {
  const r = await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'install', '-r', '-t', apk],
    env: tools.env,
    timeoutMs: 180_000,
  })
  if (r.exitCode !== 0 || /Failure/.test(r.stdout + r.stderr))
    throw new Error(`adb install failed: ${(r.stderr || r.stdout).trim().slice(-500)}`)
}

export interface LaunchCheck {
  ok: boolean
  crash?: string
  /** What `dismissSystemDialogs` found over the emulator before the launch, when anything. */
  dismissedDialog?: string
}

/** Start the app, wait, and look for a fatal exception from its process. */
export async function launchAndCheck(
  tools: AndroidTools,
  serial: string,
  packageName: string,
  opts: {
    extras?: Record<string, string>
    deepLink?: string
    waitMs?: number
    activity?: string
  } = {},
): Promise<LaunchCheck> {
  // A system dialog left by an earlier run (an ANR, a stale chooser) stays above anything `am start` brings up.
  const dismissedDialog = await dismissSystemDialogs(tools, serial, { appId: packageName }).catch(
    () => undefined,
  )
  const result = (check: LaunchCheck): LaunchCheck =>
    dismissedDialog ? { ...check, dismissedDialog } : check
  await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'logcat', '-c'],
    env: tools.env,
    timeoutMs: 10_000,
  })
  // Always target the component explicitly: implicit MAIN/LAUNCHER resolution by package is unreliable on recent Android.
  const component = `${packageName}/${opts.activity ?? '.MainActivity'}`
  const args = ['-s', serial, 'shell', 'am', 'start', '-W', '-n', component]
  if (opts.deepLink) args.push('-a', 'android.intent.action.VIEW', '-d', opts.deepLink)
  else args.push('-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER')
  for (const [k, v] of Object.entries(opts.extras ?? {})) args.push('--es', k, v)
  const start = await runProcess({ command: tools.adb, args, env: tools.env, timeoutMs: 60_000 })
  if (start.exitCode !== 0 || /Error/.test(start.stdout))
    return result({
      ok: false,
      crash: `am start failed: ${(start.stdout + start.stderr).trim().slice(-500)}`,
    })
  await new Promise((r) => setTimeout(r, opts.waitMs ?? 5000))
  const log = await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'logcat', '-d', '-s', 'AndroidRuntime:E'],
    env: tools.env,
    timeoutMs: 20_000,
  })
  if (/FATAL EXCEPTION/.test(log.stdout) && log.stdout.includes(packageName)) {
    return result({ ok: false, crash: log.stdout.slice(0, 4000) })
  }
  const alive = await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'shell', 'pidof', packageName],
    env: tools.env,
    timeoutMs: 10_000,
  })
  if (!alive.stdout.trim())
    return result({ ok: false, crash: 'process is not running after launch' })
  return result({ ok: true })
}

export async function screencap(
  tools: AndroidTools,
  serial: string,
  file: string,
): Promise<boolean> {
  const r = await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'exec-out', 'screencap', '-p'],
    env: tools.env,
    timeoutMs: 30_000,
    captureLimit: 50_000_000,
  })
  if (r.exitCode !== 0) return false
  // exec-out is binary; re-run through execa buffer to avoid utf8 mangling
  const bin = await execa(tools.adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    env: tools.env,
    encoding: 'buffer',
    reject: false,
    timeout: 30_000,
  })
  if (bin.exitCode !== 0 || !bin.stdout) return false
  writeFileSync(file, bin.stdout as unknown as Buffer)
  return existsSync(file)
}

export async function stopApp(
  tools: AndroidTools,
  serial: string,
  packageName: string,
): Promise<void> {
  await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'shell', 'am', 'force-stop', packageName],
    env: tools.env,
    timeoutMs: 15_000,
  })
}

export async function clearAppData(
  tools: AndroidTools,
  serial: string,
  packageName: string,
): Promise<void> {
  await runProcess({
    command: tools.adb,
    args: ['-s', serial, 'shell', 'pm', 'clear', packageName],
    env: tools.env,
    timeoutMs: 15_000,
  })
}

export type SystemDialogKind = 'anr' | 'crash' | 'chooser'

export interface SystemDialog {
  kind: SystemDialogKind
  /** The window title as the window manager prints it, e.g. `Application Not Responding: com.example`. */
  window: string
  /** The package the dialog is about: the stalled or crashed process, or the chooser's own package. */
  packageName?: string
}

export interface DismissDialogOptions {
  /** The package under test: an ANR or crash dialog of its own is reported but never force-stopped. */
  appId?: string
  /** Pause after a key press or force-stop before the focus is read again, in ms. */
  settleMs?: number
  /** Process runner; tests substitute a scripted fake. */
  run?: typeof runProcess
}

const WINDOW_TITLE = /Window\{[0-9a-f]+ u\d+ ([^}]*)\}/

/** Classify a window-manager window title; undefined for the app, the launcher, and system UI chrome. */
function classifyWindow(title: string): SystemDialog | undefined {
  const anr = /^Application Not Responding: (\S+)/.exec(title)
  if (anr) return { kind: 'anr', window: title, packageName: anr[1]!.split(':')[0] }
  const crash = /^Application Error: (\S+)/.exec(title)
  if (crash) return { kind: 'crash', window: title, packageName: crash[1]!.split(':')[0] }
  if (/ResolverActivity|ChooserActivity/.test(title))
    return { kind: 'chooser', window: title, packageName: title.split('/')[0] || undefined }
  return undefined
}

/**
 * The pure parser behind `dismissSystemDialogs`. `windowDump` is `dumpsys window windows`, or
 * `dumpsys window` / `dumpsys window displays` appended to it: the focused window (`mCurrentFocus=`)
 * decides where it is printed, and the topmost visible window of the list otherwise (API 35+ prints
 * no focus line under `windows`). `processDump` is `dumpsys activity processes`, whose per-process
 * error state names the ANR or crash dialog object even before its window has focus.
 */
export function systemDialogFromDumpsys(
  windowDump: string,
  processDump = '',
): SystemDialog | undefined {
  const focus = /^\s*mCurrentFocus=(.*)$/m.exec(windowDump)
  if (focus) {
    const title = WINDOW_TITLE.exec(focus[1]!)?.[1]
    const dialog = title ? classifyWindow(title) : undefined
    if (dialog) return dialog
  }
  for (const block of windowDump.split(/^(?=\s*Window #\d+ Window\{)/m)) {
    const title = /^\s*Window #\d+ Window\{[0-9a-f]+ u\d+ ([^}]*)\}:/.exec(block)?.[1]
    if (!title || /isVisible=false|mViewVisibility=0x[48]/.test(block)) continue
    const dialog = classifyWindow(title)
    if (dialog) return dialog
  }
  let proc: string | undefined
  for (const line of processDump.split('\n')) {
    const header =
      /^\s*(\*[A-Z]+\* UID \d+|PID #\d+:) ProcessRecord\{[0-9a-f]+ \d+:([^/\s}]+)\//.exec(line)
    if (header) proc = header[2]
    if (!proc) continue
    if (/AppNotRespondingDialog/.test(line))
      return {
        kind: 'anr',
        window: `Application Not Responding: ${proc}`,
        packageName: proc.split(':')[0],
      }
    if (/AppErrorDialog/.test(line))
      return {
        kind: 'crash',
        window: `Application Error: ${proc}`,
        packageName: proc.split(':')[0],
      }
  }
  return undefined
}

export function describeSystemDialog(dialog: SystemDialog): string {
  switch (dialog.kind) {
    case 'anr':
      return `"Application Not Responding" dialog for ${dialog.packageName}`
    case 'crash':
      return `"Application Error" dialog for ${dialog.packageName}`
    case 'chooser':
      return `app chooser (${dialog.window})`
  }
}

/**
 * Clear a system dialog sitting over the emulator: a stalled app's "isn't responding" dialog
 * (Digital Wellbeing's covered every flow of one observe run, and the evidence showed an empty
 * screen) or a stale "Open with" chooser. Reads the window manager's focus, presses BACK (which
 * closes a chooser and stands for "Wait" on an ANR dialog), reads it again, and force-stops the
 * stalled process when BACK changed nothing and the process is not the app under test. Returns
 * one line saying what was found and what happened to it, or undefined when nothing was showing.
 * Observe and e2e callers can run it before each flow pass; `launchAndCheck` runs it before every launch.
 */
export async function dismissSystemDialogs(
  tools: AndroidTools,
  serial: string,
  opts: DismissDialogOptions = {},
): Promise<string | undefined> {
  const run = opts.run ?? runProcess
  const settleMs = opts.settleMs ?? 500
  const shell = async (...args: string[]) =>
    (
      await run({
        command: tools.adb,
        args: ['-s', serial, 'shell', ...args],
        env: tools.env,
        timeoutMs: 20_000,
      })
    ).stdout
  const settle = () => new Promise((r) => setTimeout(r, settleMs))
  const detect = async (): Promise<SystemDialog | undefined> => {
    let windows = await shell('dumpsys', 'window', 'windows')
    if (!/mCurrentFocus=/.test(windows))
      windows += `\n${await shell('dumpsys', 'window', 'displays')}`
    return (
      systemDialogFromDumpsys(windows) ??
      systemDialogFromDumpsys('', await shell('dumpsys', 'activity', 'processes'))
    )
  }
  const dialog = await detect()
  if (!dialog) return undefined
  const label = describeSystemDialog(dialog)
  const stillShowing = async () => {
    const now = await detect()
    return now?.kind === dialog.kind && now.window === dialog.window
  }
  await shell('input', 'keyevent', 'KEYCODE_BACK')
  await settle()
  if (!(await stillShowing())) return `dismissed ${label} with BACK`
  const pkg = dialog.packageName
  if (dialog.kind === 'chooser' || !pkg) return `${label} is still showing after BACK`
  if (pkg === opts.appId)
    return `${label} is still showing after BACK; it belongs to the app under test, so it was not force-stopped`
  await shell('am', 'force-stop', pkg)
  await settle()
  if (!(await stillShowing()))
    return `dismissed ${label} by force-stopping ${pkg} after BACK left it open`
  return `${label} is still showing after BACK and am force-stop ${pkg}`
}
