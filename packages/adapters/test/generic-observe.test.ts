import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { findFreePort } from '@mpf/harness'
import { webGeneric } from '../src/source/web.ts'
import type { DetectContext } from '../src/types.ts'

/** A tiny npm project with an empty node_modules, so the adapter skips the install. */
function project(scripts: Record<string, string>, files: Record<string, string>): DetectContext {
  const dir = mkdtempSync(join(tmpdir(), 'mpf-generic-'))
  mkdirSync(join(dir, 'node_modules'))
  const pkg = { name: 'x', version: '1.0.0', scripts }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return {
    dir,
    files: Object.keys(files),
    exists: (rel) => existsSync(join(dir, rel)),
    read: (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : undefined),
    packageJson: pkg,
    deps: {},
  }
}

const detection = {} as Parameters<NonNullable<typeof webGeneric.observe>>[1]

describe('webGeneric.observe', () => {
  it('builds and serves the production output statically when a build script exists', async () => {
    const ctx = project(
      { build: 'node build.js', dev: 'node -e "process.exit(1)"' },
      {
        'build.js':
          "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.html', '<h1>built</h1>')",
        // An older index.html in a known folder is not this build's output.
        'public/index.html': '<h1>template</h1>',
      },
    )
    const logs: string[] = []
    const handle = await webGeneric.observe!(ctx, detection, {
      port: await findFreePort(),
      log: (m) => logs.push(m),
    })
    try {
      expect(await (await fetch(handle.url)).text()).toContain('built')
      expect(logs.join('\n')).toContain('serving the production build from dist')
    } finally {
      await handle.stop()
    }
  }, 60_000)

  it('serves an output-only folder the build left untouched, never a stale template folder', async () => {
    // The build is a no-op (webpack compares before emitting), so dist/index.html keeps its old mtime.
    const ctx = project(
      { build: 'node -e "process.exit(0)"' },
      { 'dist/index.html': '<h1>previous output</h1>', 'public/index.html': '<h1>template</h1>' },
    )
    const logs: string[] = []
    const handle = await webGeneric.observe!(ctx, detection, {
      port: await findFreePort(),
      log: (m) => logs.push(m),
    })
    try {
      expect(await (await fetch(handle.url)).text()).toContain('previous output')
    } finally {
      await handle.stop()
    }
  }, 60_000)

  it('falls back to the dev script, probing the port it announces, when the build fails', async () => {
    const actual = await findFreePort()
    const dev = `node -e "const h = require('node:http'); h.createServer((q, r) => r.end('dev')).listen(${actual}, '127.0.0.1', () => console.log('http://localhost:${actual}/')); setInterval(() => {}, 1000)"`
    const ctx = project({ build: 'node -e "process.exit(2)"', dev }, {})
    const logs: string[] = []
    const handle = await webGeneric.observe!(ctx, detection, {
      port: await findFreePort(),
      log: (m) => logs.push(m),
    })
    try {
      expect(await (await fetch(handle.url)).text()).toBe('dev')
      expect(logs.join('\n')).toMatch(/falling back to the dev server/)
    } finally {
      await handle.stop()
    }
  }, 60_000)
})
