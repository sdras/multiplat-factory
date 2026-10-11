import { describe, expect, it } from 'vitest'
import { findFreePort, startDevServer } from '../src/devserver.ts'

describe('startDevServer', () => {
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
