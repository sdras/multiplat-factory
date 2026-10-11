import { createServer, type Server } from 'node:http'
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter } from 'node:path'
import { extname, join, normalize } from 'pathe'
import { execa, type ResultPromise } from 'execa'

export interface DevServerHandle {
  url: string
  stop(): Promise<void>
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

/**
 * Poll until the URL answers with any HTTP status below 500. A getter re-reads the URL on every
 * probe, so a tool that announces a different port than it was given is probed where it listens.
 */
export async function waitForHttp(
  url: string | (() => string),
  timeoutMs = 90_000,
  signal?: AbortSignal,
): Promise<void> {
  const current = () => (typeof url === 'function' ? url() : url)
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('aborted')
    try {
      const res = await fetch(current(), { signal: AbortSignal.timeout(3000), redirect: 'manual' })
      if (res.status < 500) return
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `server at ${current()} did not become ready within ${timeoutMs} ms${lastErr ? `: ${(lastErr as Error).message}` : ''}`,
  )
}

export interface StartDevServerOptions {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Port the command was told to use; the URL is derived from it. */
  port: number
  /** Regex that extracts a URL from output when the tool picks its own port. */
  urlPattern?: RegExp
  timeoutMs?: number
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
}

/**
 * A PATH entry whose `open` and `xdg-open` do nothing. Dev scripts often carry `--open` (webpack
 * serve, vite --open), and an observation must never pop a browser window on the user's machine.
 */
export function noBrowserPath(): string | undefined {
  if (process.platform === 'win32') return undefined
  const dir = join(tmpdir(), 'mpf-no-open')
  try {
    mkdirSync(dir, { recursive: true })
    for (const name of ['open', 'xdg-open']) {
      const file = join(dir, name)
      if (!existsSync(file)) {
        writeFileSync(file, '#!/bin/sh\nexit 0\n')
        chmodSync(file, 0o755)
      }
    }
    return dir
  } catch {
    return undefined
  }
}

/** Launch a framework dev server and wait until it serves. Kills the process on stop. */
export async function startDevServer(opts: StartDevServerOptions): Promise<DevServerHandle> {
  const shim = noBrowserPath()
  const PATH = shim ? `${shim}${delimiter}${process.env.PATH ?? ''}` : process.env.PATH
  const child: ResultPromise = execa(opts.command, opts.args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...opts.env,
      PATH,
      PORT: String(opts.port),
      BROWSER: 'none',
      CI: '1',
    },
    reject: false,
    cleanup: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    forceKillAfterDelay: 3000,
  })
  let url = `http://127.0.0.1:${opts.port}/`
  let output = ''
  let finished = false
  child.then(
    () => (finished = true),
    () => (finished = true),
  )
  const onData = (b: Buffer) => {
    const s = b.toString()
    output += s
    opts.onOutput?.(s)
    if (opts.urlPattern) {
      const m = opts.urlPattern.exec(s)
      if (m?.[0]) {
        const announced = m[0]
          .replace('localhost', '127.0.0.1')
          .replace('0.0.0.0', '127.0.0.1')
          .replace(/\/?$/, '/')
        // webpack-dev-server and friends ignore PORT and pick their own; follow what they announce.
        if (announced !== url)
          opts.onOutput?.(`[mpf] dev server announced ${announced}; probing it`)
        url = announced
      }
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  const stop = async () => {
    if (!finished) child.kill('SIGTERM')
    await child.catch(() => {})
  }
  const exited = child.then((r) => {
    throw new Error(`dev server exited early (code ${r.exitCode}):\n${output.slice(-2000)}`)
  })
  try {
    await Promise.race([waitForHttp(() => url, opts.timeoutMs ?? 90_000, opts.signal), exited])
  } catch (err) {
    await stop()
    throw err
  }
  return { url, stop }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** Minimal static server for build-less web apps (index.html + modules). SPA fallback to index.html. */
export async function serveStaticDir(dir: string, port: number): Promise<DevServerHandle> {
  const server: Server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'))
    if (path.includes('..')) {
      res.writeHead(403).end()
      return
    }
    let file = join(dir, path)
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const idx = join(file, 'index.html')
      file = existsSync(idx) ? idx : join(dir, 'index.html')
    }
    if (!existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
