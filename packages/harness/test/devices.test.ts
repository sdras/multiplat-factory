import { describe, expect, it } from 'vitest'
import type { runProcess } from '../src/exec.ts'
import {
  describeSystemDialog,
  dismissSystemDialogs,
  systemDialogFromDumpsys,
  type AndroidTools,
} from '../src/devices/android.ts'
import { dismissSystemDialogs as dismissIosSystemDialogs } from '../src/devices/ios.ts'
import type { XcodeTools } from '../src/devices/ios.ts'

const APP = 'dev.multiplat.fixtures.notes'
const WELLBEING = 'com.google.android.apps.wellbeing'

/** `dumpsys window` on the API 36 emulator while the app under test had focus. */
const FOCUS_APP = `
  mCurrentFocus=Window{15c07b6 u0 ${APP}/${APP}.MainActivity}
  mFocusedApp=ActivityRecord{254637302 u0 ${APP}/.MainActivity t1097}
`

/** The focus line of the run where Digital Wellbeing's ANR dialog sat over every flow. */
const FOCUS_ANR = `
  mCurrentFocus=Window{a1b2c3d u0 Application Not Responding: ${WELLBEING}}
  mFocusedApp=ActivityRecord{254637302 u0 ${APP}/.MainActivity t1097}
`

const FOCUS_CHOOSER = `
  mCurrentFocus=Window{7e6d5c4 u0 com.android.intentresolver/com.android.intentresolver.ChooserActivity}
  mFocusedApp=ActivityRecord{1c0ffee u0 com.android.intentresolver/.ChooserActivity t1101}
`

const FOCUS_NULL = `
  mCurrentFocus=null
  mFocusedApp=null
`

/** `dumpsys window windows` on API 35+: the z-ordered list without a focus line. */
const WINDOWS_ANR = `WINDOW MANAGER WINDOWS (dumpsys window windows)
  Window #0 Window{322a7c2 u0 ScreenDecorOverlayBottom}:
    mDisplayId=0 taskId=-1 mSession=Session{5ec7261 1234:u0a10066}
    isOnScreen=true
    isVisible=true
  Window #1 Window{9f8e7d6 u0 Application Not Responding: ${WELLBEING}}:
    mOwnerUid=1000 showForAllUsers=true package=android appop=NONE
    mAttrs={(0,0)(wrapxwrap) gr=CENTER sim={adjust=pan} ty=SYSTEM_ALERT fmt=TRANSLUCENT
    isOnScreen=true
    isVisible=true
  Window #2 Window{15c07b6 u0 ${APP}/${APP}.MainActivity}:
    mOwnerUid=10278 showForAllUsers=false package=${APP} appop=NONE
    isOnScreen=true
    isVisible=true
  mTopFocusedDisplayId=0
`

const WINDOWS_STALE_RESOLVER = `WINDOW MANAGER WINDOWS (dumpsys window windows)
  Window #0 Window{15c07b6 u0 ${APP}/${APP}.MainActivity}:
    isOnScreen=true
    isVisible=true
  Window #1 Window{0badf00 u0 android/com.android.internal.app.ResolverActivity}:
    mViewVisibility=0x8 mHaveFrame=true mObscured=false
    isOnScreen=false
    isVisible=false
  mTopFocusedDisplayId=0
`

/** `dumpsys activity processes`: the error state of a process whose ANR dialog exists. */
const PROCESSES_ANR = `ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)
  *APP* UID 10210 ProcessRecord{8c9d85c 1045:com.google.android.ext.services/u0a210}
    user #0 uid=10210 gids={50210, 20210, 9997}
    lastActivityTime=-1d2h3m4s5ms
  *APP* UID 10171 ProcessRecord{3c2e1f0 4521:${WELLBEING}/u0a171}
    user #0 uid=10171 gids={50171, 20171, 9997}
    mCrashing=false [] mNotResponding=true [com.android.server.am.AppNotRespondingDialog@7b3a9c] bad=false
  *APP* UID 10278 ProcessRecord{a0b1c2d 5275:${APP}/u0a278}
    user #0 uid=10278 gids={50278, 20278, 9997}
`

describe('systemDialogFromDumpsys', () => {
  it('finds nothing when the app under test holds the focus', () => {
    expect(systemDialogFromDumpsys(FOCUS_APP)).toBeUndefined()
    expect(systemDialogFromDumpsys(FOCUS_NULL)).toBeUndefined()
    expect(systemDialogFromDumpsys('')).toBeUndefined()
  })

  it('names the ANR dialog and its process from the focus line', () => {
    expect(systemDialogFromDumpsys(FOCUS_ANR)).toEqual({
      kind: 'anr',
      window: `Application Not Responding: ${WELLBEING}`,
      packageName: WELLBEING,
    })
    expect(
      systemDialogFromDumpsys('  mCurrentFocus=Window{1 u0 Application Error: com.example:remote}'),
    ).toEqual({
      kind: 'crash',
      window: 'Application Error: com.example:remote',
      packageName: 'com.example',
    })
  })

  it('names the chooser and resolver windows', () => {
    expect(systemDialogFromDumpsys(FOCUS_CHOOSER)).toEqual({
      kind: 'chooser',
      window: 'com.android.intentresolver/com.android.intentresolver.ChooserActivity',
      packageName: 'com.android.intentresolver',
    })
    expect(
      systemDialogFromDumpsys(
        '  mCurrentFocus=Window{2 u0 android/com.android.internal.app.ResolverActivity}',
      )?.kind,
    ).toBe('chooser')
  })

  it('falls back to the topmost visible window when the list has no focus line', () => {
    expect(systemDialogFromDumpsys(WINDOWS_ANR)?.kind).toBe('anr')
    // A resolver that is finishing is still listed but invisible: not a dialog over the app.
    expect(systemDialogFromDumpsys(WINDOWS_STALE_RESOLVER)).toBeUndefined()
  })

  it('reads an ANR dialog that has not taken focus yet from the process error state', () => {
    expect(systemDialogFromDumpsys(FOCUS_APP, PROCESSES_ANR)).toEqual({
      kind: 'anr',
      window: `Application Not Responding: ${WELLBEING}`,
      packageName: WELLBEING,
    })
    expect(
      systemDialogFromDumpsys(FOCUS_APP, PROCESSES_ANR.replace(/mNotResponding.*\n/, '')),
    ).toBeUndefined()
  })

  it('describes each kind for the log', () => {
    expect(describeSystemDialog(systemDialogFromDumpsys(FOCUS_ANR)!)).toBe(
      `"Application Not Responding" dialog for ${WELLBEING}`,
    )
    expect(describeSystemDialog(systemDialogFromDumpsys(FOCUS_CHOOSER)!)).toBe(
      'app chooser (com.android.intentresolver/com.android.intentresolver.ChooserActivity)',
    )
  })
})

const tools: AndroidTools = {
  sdk: '/sdk',
  adb: '/sdk/platform-tools/adb',
  emulator: '/sdk/emulator/emulator',
  env: { ANDROID_HOME: '/sdk' },
}

interface FakeEmulator {
  /** Shell commands after `-s <serial> shell`, in order. */
  commands: string[]
  run: typeof runProcess
}

/**
 * An emulator whose `dumpsys` answers follow a script: the window dump switches to the next entry
 * of `after` when the named command runs, so a test says which action clears the dialog.
 */
function fakeEmulator(opts: {
  windows: string
  displays?: string
  processes?: string
  after?: Record<string, string>
}): FakeEmulator {
  let windows = opts.windows
  let displays = opts.displays ?? ''
  const commands: string[] = []
  const run: typeof runProcess = async (p) => {
    expect(p.command).toBe(tools.adb)
    expect(p.args?.slice(0, 3)).toEqual(['-s', 'emulator-5554', 'shell'])
    const cmd = (p.args ?? []).slice(3).join(' ')
    commands.push(cmd)
    let stdout = ''
    if (cmd === 'dumpsys window windows') stdout = windows
    else if (cmd === 'dumpsys window displays') stdout = displays
    else if (cmd === 'dumpsys activity processes') stdout = opts.processes ?? ''
    const next = opts.after?.[cmd]
    if (next !== undefined) {
      windows = next
      displays = next
    }
    return {
      command: cmd,
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 1,
      timedOut: false,
      cancelled: false,
    }
  }
  return { commands, run }
}

describe('dismissSystemDialogs (android)', () => {
  it('does nothing when no dialog is showing', async () => {
    const emu = fakeEmulator({ windows: FOCUS_APP })
    const r = await dismissSystemDialogs(tools, 'emulator-5554', { run: emu.run, settleMs: 0 })
    expect(r).toBeUndefined()
    expect(emu.commands).toEqual(['dumpsys window windows', 'dumpsys activity processes'])
  })

  it('closes a chooser with BACK', async () => {
    const emu = fakeEmulator({
      windows: FOCUS_CHOOSER,
      after: { 'input keyevent KEYCODE_BACK': FOCUS_APP },
    })
    const r = await dismissSystemDialogs(tools, 'emulator-5554', {
      appId: APP,
      run: emu.run,
      settleMs: 0,
    })
    expect(r).toBe(
      'dismissed app chooser (com.android.intentresolver/com.android.intentresolver.ChooserActivity) with BACK',
    )
    expect(emu.commands).toEqual([
      'dumpsys window windows',
      'input keyevent KEYCODE_BACK',
      'dumpsys window windows',
      'dumpsys activity processes',
    ])
  })

  it('force-stops a stalled process that is not the app under test when BACK leaves its ANR dialog up', async () => {
    const emu = fakeEmulator({
      windows: FOCUS_ANR,
      after: { [`am force-stop ${WELLBEING}`]: FOCUS_APP },
    })
    const r = await dismissSystemDialogs(tools, 'emulator-5554', {
      appId: APP,
      run: emu.run,
      settleMs: 0,
    })
    expect(r).toBe(
      `dismissed "Application Not Responding" dialog for ${WELLBEING} by force-stopping ${WELLBEING} after BACK left it open`,
    )
    expect(emu.commands).toEqual([
      'dumpsys window windows',
      'input keyevent KEYCODE_BACK',
      'dumpsys window windows',
      `am force-stop ${WELLBEING}`,
      'dumpsys window windows',
      'dumpsys activity processes',
    ])
  })

  it('never force-stops the app under test and says the dialog is still there', async () => {
    const emu = fakeEmulator({
      windows: `  mCurrentFocus=Window{1 u0 Application Not Responding: ${APP}}`,
    })
    const r = await dismissSystemDialogs(tools, 'emulator-5554', {
      appId: APP,
      run: emu.run,
      settleMs: 0,
    })
    expect(r).toBe(
      `"Application Not Responding" dialog for ${APP} is still showing after BACK; it belongs to the app under test, so it was not force-stopped`,
    )
    expect(emu.commands).not.toContain(`am force-stop ${APP}`)
  })

  it('reads the focus from `dumpsys window displays` when the window list omits it', async () => {
    const emu = fakeEmulator({
      windows: WINDOWS_STALE_RESOLVER,
      displays: FOCUS_ANR,
      after: { 'input keyevent KEYCODE_BACK': FOCUS_APP },
    })
    const r = await dismissSystemDialogs(tools, 'emulator-5554', { run: emu.run, settleMs: 0 })
    expect(r).toBe(`dismissed "Application Not Responding" dialog for ${WELLBEING} with BACK`)
    expect(emu.commands.slice(0, 3)).toEqual([
      'dumpsys window windows',
      'dumpsys window displays',
      'input keyevent KEYCODE_BACK',
    ])
  })
})

describe('dismissSystemDialogs (ios)', () => {
  it('is a documented no-op: simctl cannot see or dismiss the "Open in" alert', async () => {
    const xcode: XcodeTools = { developerDir: '/Xcode/Contents/Developer', env: {} }
    await expect(dismissIosSystemDialogs(xcode, 'UDID', 'app.mpf.counter')).resolves.toBeUndefined()
  })
})
