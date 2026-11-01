import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  releaseBootedDevices,
  rememberBootedDevice,
  rememberedDevices,
} from '../src/devices/remember.ts'
import type { runProcess } from '../src/exec.ts'

type Exec = typeof runProcess

describe('booted devices', () => {
  it('remembers what a run booted, stops it at the end, and leaves what another process holds', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'mpf-devices-'))
    rememberBootedDevice(runDir, { kind: 'emulator', id: 'emulator-5554' })
    rememberBootedDevice(runDir, { kind: 'simulator', id: 'UDID-1' })
    rememberBootedDevice(runDir, { kind: 'emulator', id: 'emulator-5554' })
    expect(rememberedDevices(runDir).map((d) => d.id)).toEqual(['UDID-1', 'emulator-5554'])

    const commands: string[] = []
    const exec: Exec = (async (o: { command: string; args?: string[] }) => {
      commands.push([o.command, ...(o.args ?? [])].join(' '))
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }
    }) as unknown as Exec
    const busy = await releaseBootedDevices(runDir, {
      heldByAnother: (lane) => (lane === 'emulator' ? { pid: 4242 } : undefined),
      android: { adb: '/sdk/adb', env: {} },
      xcode: { env: {} },
      exec,
    })
    expect(busy).toEqual(['simulator UDID-1'])
    expect(commands).toEqual(['xcrun simctl shutdown UDID-1'])
    expect(rememberedDevices(runDir).map((d) => d.id)).toEqual(['emulator-5554'])

    const kept = await releaseBootedDevices(runDir, {
      keep: true,
      heldByAnother: () => undefined,
      android: { adb: '/sdk/adb', env: {} },
      exec,
    })
    expect(kept).toEqual([])
    expect(commands).toHaveLength(1)

    const freed = await releaseBootedDevices(runDir, {
      heldByAnother: () => undefined,
      android: { adb: '/sdk/adb', env: {} },
      exec,
    })
    expect(freed).toEqual(['emulator emulator-5554'])
    expect(commands.at(-1)).toBe('/sdk/adb -s emulator-5554 emu kill')
    expect(JSON.parse(readFileSync(join(runDir, 'devices.json'), 'utf8'))).toEqual([])
  })
})
