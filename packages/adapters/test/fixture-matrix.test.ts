import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectSource } from '../src/registry.ts'

/**
 * The public fixture matrix: every repo pinned in fixtures/manifest.json must be detected as the
 * adapter, framework, and language the manifest expects. Repos are synced into fixtures/.cache by
 * `pnpm fixtures:sync`; a fixture that is not synced here is skipped, not failed.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const manifest = JSON.parse(readFileSync(join(root, 'fixtures', 'manifest.json'), 'utf8')) as {
  fixtures: { id: string; subdir?: string; pin?: string; expect?: Record<string, string> }[]
}

describe('public fixture matrix', () => {
  for (const fixture of manifest.fixtures) {
    const dir = join(root, 'fixtures', '.cache', fixture.id, fixture.subdir ?? '')
    const synced = existsSync(dir) && !!fixture.expect
    it.skipIf(!synced)(`${fixture.id} is detected as ${fixture.expect?.adapterId}`, async () => {
      const r = await detectSource(dir)
      expect(r.best, `no adapter matched ${fixture.id}`).toBeDefined()
      for (const [key, value] of Object.entries(fixture.expect ?? {})) {
        expect((r.best as Record<string, unknown> | undefined)?.[key], key).toBe(value)
      }
    })
  }
})
