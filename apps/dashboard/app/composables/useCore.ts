/**
 * Browser host for a run's shared core module (docs/ABI.md), used by the playground page.
 * Same ABI walk as the Node host in @mpf/wasm-core, kept dependency-free here because the
 * dashboard only imports isomorphic schema code.
 */
export interface CoreEnvelope {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

export interface BrowserCore {
  manifest: {
    abiVersion: number
    functions: {
      name: string
      description: string
      inputSchema: Record<string, unknown>
      outputSchema: Record<string, unknown>
    }[]
  }
  call(name: string, input: unknown): CoreEnvelope
}

interface Exports {
  memory: WebAssembly.Memory
  mpf_abi_version(): number
  mpf_alloc(len: number): number
  mpf_free(ptr: number, len: number): void
  mpf_call(namePtr: number, nameLen: number, reqPtr: number, reqLen: number): bigint
  mpf_manifest(): bigint
}

export async function loadBrowserCore(bytes: ArrayBuffer): Promise<BrowserCore> {
  const { instance } = await WebAssembly.instantiate(bytes, {})
  const ex = instance.exports as unknown as Exports
  const version = ex.mpf_abi_version()
  if (version !== 1) throw new Error(`core ABI version ${version}; this dashboard speaks 1`)
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const write = (s: string) => {
    const b = enc.encode(s)
    const ptr = ex.mpf_alloc(b.length)
    new Uint8Array(ex.memory.buffer, ptr, b.length).set(b)
    return { ptr, len: b.length }
  }
  const take = (packed: bigint) => {
    const ptr = Number(packed >> 32n)
    const len = Number(packed & 0xffff_ffffn)
    const s = dec.decode(new Uint8Array(ex.memory.buffer, ptr, len))
    ex.mpf_free(ptr, len)
    return s
  }
  const manifest = JSON.parse(take(ex.mpf_manifest())) as BrowserCore['manifest']
  return {
    manifest,
    call(name, input) {
      const n = write(name)
      const r = write(JSON.stringify(input ?? null))
      try {
        return JSON.parse(take(ex.mpf_call(n.ptr, n.len, r.ptr, r.len))) as CoreEnvelope
      } finally {
        ex.mpf_free(n.ptr, n.len)
        ex.mpf_free(r.ptr, r.len)
      }
    },
  }
}

/** A starting input for a function: an object with one placeholder per schema property. */
export function exampleInput(schema: Record<string, unknown>): unknown {
  const type = schema.type
  if (type === 'object' || schema.properties) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(
      (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
    ))
      out[k] = exampleInput(v)
    return out
  }
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  switch (type) {
    case 'string':
      return ''
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'null':
      return null
    default:
      return null
  }
}
