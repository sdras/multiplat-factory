import { serve, type ServerType } from '@hono/node-server'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { fileURLToPath } from 'node:url'
import {
  RunEventBus,
  SqliteRunStore,
  dbPath,
  ensureDir,
  mpfHome,
  type MpfConfig,
  type Run,
  type RunStore,
} from '@mpf/core'
import { runDoctor } from '@mpf/harness'
import {
  Orchestrator,
  fakeRegistry,
  realRegistry,
  type StageRunnerRegistry,
} from '@mpf/orchestrator'
import { createApp } from './app.ts'

export interface DaemonOptions {
  config: MpfConfig
  /** Data directory; defaults to mpfHome(). */
  dataDir?: string
  /** Real stage runners. Empty until the real pipeline lands. */
  registry?: StageRunnerRegistry
  store?: RunStore
  dashboardDir?: string
  version?: string
}

export interface Daemon {
  url: string
  port: number
  orchestrator: Orchestrator
  store: RunStore
  bus: RunEventBus
  close(): Promise<void>
}

export interface DaemonInfo {
  url: string
  pid: number
  startedAt: string
}

export function daemonInfoPath(dataDir = mpfHome()): string {
  return join(dataDir, 'daemon.json')
}

export function readDaemonInfo(dataDir = mpfHome()): DaemonInfo | undefined {
  const p = daemonInfoPath(dataDir)
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as DaemonInfo
  } catch {
    return undefined
  }
}

/** True when a daemon answers on the recorded URL. */
export async function daemonAlive(info: DaemonInfo | undefined): Promise<boolean> {
  if (!info) return false
  try {
    const res = await fetch(`${info.url}/api/v1/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/** Locate a built dashboard next to this package (monorepo dev) or bundled with the CLI. */
export function defaultDashboardDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', '..', 'dashboard', '.output', 'public'),
    join(here, '..', 'dashboard'),
    join(here, 'dashboard'),
  ]
  return candidates.find((c) => existsSync(join(c, 'index.html')))
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const dataDir = opts.dataDir ?? opts.config.dataDir ?? mpfHome()
  ensureDir(dataDir)
  const store = opts.store ?? new SqliteRunStore(dbPath(dataDir))
  const bus = new RunEventBus(store)
  const real = opts.registry ?? realRegistry(opts.config)
  const realPipeline = Object.keys(real).length > 0
  const fake = fakeRegistry()
  const orchestrator = new Orchestrator({
    store,
    bus,
    config: opts.config,
    dataDir,
    registry: (run: Run) => (run.options.fake ? fake : real),
  })
  const app = createApp({
    orchestrator,
    store,
    bus,
    config: opts.config,
    doctor: () => runDoctor(opts.config),
    realPipeline,
    availableStages: Object.keys(real),
    dashboardDir: opts.dashboardDir ?? defaultDashboardDir(),
    // The CLI passes its package.json version; an embedding without one (tests, demos) says so.
    version: opts.version ?? 'dev',
  })

  const server: ServerType = await new Promise((resolve) => {
    const s = serve(
      { fetch: app.fetch, port: opts.config.server.port, hostname: opts.config.server.host },
      () => resolve(s),
    )
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : opts.config.server.port
  const url = `http://${opts.config.server.host}:${port}`
  const infoPath = daemonInfoPath(dataDir)
  writeFileSync(
    infoPath,
    JSON.stringify({ url, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
  )

  return {
    url,
    port,
    orchestrator,
    store,
    bus,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            if (existsSync(infoPath)) unlinkSync(infoPath)
          } catch {
            /* ignore */
          }
          store.close()
          resolve()
        })
      }),
  }
}
