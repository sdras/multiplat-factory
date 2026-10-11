import { describe, expect, it } from 'vitest'
import { findFreePort, noBrowserPath, startDevServer } from '../src/devserver.ts'

describe('startDevServer', () => {
  it.skipIf(process.platform === 'win32')(
    'puts no-op open and xdg-open shims first on the dev server PATH',
    async () => {
      const port = await findFreePort()
      // A dev script that, like `webpack serve --open`, tries to open a browser before serving.
      const script = `const { execSync } = require('node:child_process'); execSync('open http://127.0.0.1/ && xdg-open http://127.0.0.1/'); console.log('OPEN=' + execSync('command -v open').toString().trim()); require('node:http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1'); setInterval(() => {}, 1000)`
      const output: string[] = []
      const handle = await startDevServer({
        command: process.execPath,
        args: ['-e', script],
        cwd: process.cwd(),
        port,
        timeoutMs: 15_000,
        onOutput: (c) => output.push(c),
      })
      try {
        expect(output.join('')).toContain(`OPEN=${noBrowserPath()}/open`)
      } finally {
        await handle.stop()
      }
    },
    30_000,
  )

  it('probes the URL the tool announces when it ignores the requested port', async () => {
    const requested = await findFreePort()
    const actual = await findFreePort()
    // A dev server that, like webpack-dev-server, ignores PORT and prints where it really listens.
    const script = `const http = require('node:http'); const s = http.createServer((q, r) => r.end('ok')); s.listen(${actual}, '127.0.0.1', () => console.log('Project is running at: http://localhost:${actual}/')); setInterval(() => {}, 1000)`
    const handle = await startDevServer({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      port: requested,
      urlPattern: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\/?/,
      timeoutMs: 15_000,
    })
    try {
      expect(handle.url).toBe(`http://127.0.0.1:${actual}/`)
      expect((await fetch(handle.url)).status).toBe(200)
    } finally {
      await handle.stop()
    }
  }, 30_000)
})
