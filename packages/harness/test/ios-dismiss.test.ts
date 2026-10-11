import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { dismissSystemDialogs } from '../src/devices/ios.ts'
import type { XcodeTools } from '../src/devices/ios.ts'

const tools = {} as XcodeTools

/** A stand-in for the Maestro CLI that reports what a real run prints. */
function fakeMaestro(output: string): { bin: string; env: NodeJS.ProcessEnv } {
  const bin = join(mkdtempSync(join(tmpdir(), 'mpf-fake-maestro-')), 'maestro')
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`)
  chmodSync(bin, 0o755)
  return { bin, env: process.env }
}

describe.skipIf(process.platform === 'win32')('iOS dismissSystemDialogs', () => {
  it('is a no-op without Maestro', async () => {
    expect(await dismissSystemDialogs(tools, 'UDID', 'app.id')).toBeUndefined()
  })

  it('reports the Open-in confirmation when Maestro tapped Cancel, and nothing when it was skipped', async () => {
    const tapped = fakeMaestro(
      'Run flow when "Open in .*" is visible...\n  Tap on "Cancel"... COMPLETED',
    )
    expect(await dismissSystemDialogs(tools, 'UDID', 'app.id', tapped)).toMatch(/Open in/)
    const skipped = fakeMaestro('Run flow when "Open in .*" is visible... SKIPPED')
    expect(await dismissSystemDialogs(tools, 'UDID', 'app.id', skipped)).toBeUndefined()
  })
})
