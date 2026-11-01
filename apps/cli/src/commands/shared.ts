import { consola } from 'consola'
import { loadConfig, type MpfConfig, type Run } from '@mpf/core'
import { daemonAlive, readDaemonInfo, startDaemon, type Daemon } from '@mpf/server'
import { cliVersion } from '../version.ts'

export const log = consola.withTag('mpf')

export async function config(): Promise<MpfConfig> {
  return loadConfig()
}

/** Use the running daemon if there is one, otherwise start an embedded one for this process. */
export async function ensureDaemon(cfg: MpfConfig): Promise<{ url: string; embedded?: Daemon }> {
  const info = readDaemonInfo(cfg.dataDir)
  if (await daemonAlive(info)) return { url: info!.url }
  const embedded = await startDaemon({
    config: { ...cfg, server: { ...cfg.server, port: 0 } },
    version: cliVersion(),
  })
  return { url: embedded.url, embedded }
}

export async function api<T>(url: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${url}/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return body
}

export function describeRun(run: Run): string {
  return `${run.id}  ${run.status.padEnd(13)} ${run.source.locator} -> ${run.targets.join(',')}  $${run.costUsd.toFixed(2)}`
}
