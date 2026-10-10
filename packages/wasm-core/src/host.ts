/// <reference lib="dom" />
import { CoreManifest, type CoreManifest as Manifest } from '@mpf/core'
import { ABI_VERSION } from './template.ts'

export interface CoreEnvelope {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

export interface LoadedCore {
  manifest: Manifest
  /** Call a function and return the raw envelope. */
  callRaw(name: string, input: unknown): CoreEnvelope
  /** Call a function; throws `CoreCallError` on an error envelope. */
  call(name: string, input: unknown): unknown
  imports: string[]
}

export class CoreCallError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

interface Exports {
  memory: WebAssembly.Memory
  mpf_abi_version(): number
  mpf_alloc(len: number): number
  mpf_free(ptr: number, len: number): void
  mpf_call(namePtr: number, nameLen: number, reqPtr: number, reqLen: number): bigint
  mpf_manifest(): bigint
}

/**
 * Node/browser host for a core module built to docs/ABI.md. The same code drives the web
 * target's parity tests and the dashboard playground; Swift and Kotlin hosts mirror it.
 */
export async function loadCore(bytes: Uint8Array | ArrayBuffer): Promise<LoadedCore> {
  const module = await WebAssembly.compile(bytes as BufferSource)
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`)
  if (imports.length)
    throw new Error(`core module has imports, which the ABI forbids: ${imports.join(', ')}`)
  const instance = await WebAssembly.instantiate(module, {})
  const ex = instance.exports as unknown as Exports
  for (const name of [
    'memory',
    'mpf_abi_version',
    'mpf_alloc',
    'mpf_free',
    'mpf_call',
    'mpf_manifest',
  ]) {
    if (!(name in ex)) throw new Error(`core module lacks the ${name} export`)
  }
  const version = ex.mpf_abi_version()
  if (version !== ABI_VERSION)
    throw new Error(`core ABI version ${version}; this host speaks ${ABI_VERSION}`)
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  const write = (s: string): { ptr: number; len: number } => {
    const b = enc.encode(s)
    const ptr = ex.mpf_alloc(b.length)
    new Uint8Array(ex.memory.buffer, ptr, b.length).set(b)
    return { ptr, len: b.length }
  }
  const take = (packed: bigint): string => {
    const ptr = Number(packed >> 32n)
    const len = Number(packed & 0xffff_ffffn)
    const s = dec.decode(new Uint8Array(ex.memory.buffer, ptr, len))
    ex.mpf_free(ptr, len)
    return s
  }

  const manifest = CoreManifest.parse(JSON.parse(take(ex.mpf_manifest())))

  const callRaw = (name: string, input: unknown): CoreEnvelope => {
    const n = write(name)
    const r = write(JSON.stringify(input ?? null))
    try {
      return JSON.parse(take(ex.mpf_call(n.ptr, n.len, r.ptr, r.len))) as CoreEnvelope
    } finally {
      ex.mpf_free(n.ptr, n.len)
      ex.mpf_free(r.ptr, r.len)
    }
  }
  return {
    manifest,
    imports,
    callRaw,
    call(name, input) {
      const env = callRaw(name, input)
      if (!env.ok)
        throw new CoreCallError(
          env.error?.code ?? 'internal',
          env.error?.message ?? 'unknown error',
        )
      return env.value
    },
  }
}
