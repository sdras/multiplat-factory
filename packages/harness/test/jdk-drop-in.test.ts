import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { findJavaCandidates, resolveJava } from '../src/toolchain/checks/android.ts'

/** A JDK unpacked under <MPF_HOME>/jdks: only `bin/java` matters to the scan, so a script stands in for it. */
function dropIn(home: string, name: string, versionLine: string, macLayout: boolean): string {
  const root = macLayout ? join(home, 'jdks', name, 'Contents', 'Home') : join(home, 'jdks', name)
  mkdirSync(join(root, 'bin'), { recursive: true })
  const java = join(root, 'bin', 'java')
  writeFileSync(java, `#!/bin/sh\necho '${versionLine}' >&2\n`)
  chmodSync(java, 0o755)
  return root
}

describe.skipIf(process.platform === 'win32')('JDKs dropped under the run home', () => {
  it('finds them in either layout, reads JDK 8 as major 8, and picks one by range', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mpf-jdks-'))
    const eight = dropIn(home, 'zulu-8.jdk', 'openjdk version "1.8.0_504"', true)
    const seventeen = dropIn(home, 'temurin-17', 'openjdk version "17.0.12" 2024-07-16', false)
    const ctx = {
      env: { MPF_HOME: home, PATH: '/usr/bin:/bin' },
      platform: 'linux',
      toolchain: {},
    } as never
    const found = await findJavaCandidates(ctx)
    expect(found.map((c) => [c.home, c.major])).toEqual(
      expect.arrayContaining([
        [eight, 8],
        [seventeen, 17],
      ]),
    )
    expect((await resolveJava(ctx, { min: 8, max: 9 }))?.home).toBe(eight)
    // The newest JDK in range wins, and a machine may carry its own under /usr/lib/jvm (GitHub's
    // Linux runners ship Temurin 8 to 21), so pin the range to the drop-in's major: within one
    // major the drop-in is found first.
    expect((await resolveJava(ctx, { min: 17, max: 17 }))?.home).toBe(seventeen)
  })
})
