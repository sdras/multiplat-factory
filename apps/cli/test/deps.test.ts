import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel: string) =>
  JSON.parse(readFileSync(join(root, rel), 'utf8')) as {
    name: string
    dependencies?: Record<string, string>
  }

/**
 * tsup inlines every @mpf/* package into the published bin, so their third-party runtime
 * dependencies must be declared by the CLI package or `npm i -g @multiplat/factory` breaks.
 */
describe('published CLI dependencies', () => {
  it('declare every third-party runtime dependency of the bundled workspace packages', () => {
    const cli = read('apps/cli/package.json')
    const bundled = [
      ...readdirSync(join(root, 'packages')).map((d) => `packages/${d}/package.json`),
      'apps/server/package.json',
    ]
    const missing: string[] = []
    for (const rel of bundled) {
      const pkg = read(rel)
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        if (version.startsWith('workspace:')) continue
        if (!cli.dependencies?.[name]) missing.push(`${name} (from ${pkg.name})`)
      }
    }
    expect(missing).toEqual([])
  })

  it('never lists a workspace package as a runtime dependency (they are inlined by tsup)', () => {
    const cli = read('apps/cli/package.json')
    expect(Object.keys(cli.dependencies ?? {}).filter((n) => n.startsWith('@mpf/'))).toEqual([])
  })
})
