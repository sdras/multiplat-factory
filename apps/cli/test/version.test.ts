import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cliVersion } from '../src/version.ts'

describe('cliVersion', () => {
  it('is the version in apps/cli/package.json, the one place a release bumps', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string }
    expect(cliVersion()).toBe(pkg.version)
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
