# Shared core ABI (v1)

The shared core is one WebAssembly module, built from a Rust crate, that runs unchanged on every
target: WasmKit on iOS, Chicory on Android, `WebAssembly.instantiate` in browsers and Node. The
contract below is what the crate template (`packages/wasm-core/src/template.ts`) implements and
what the generated host bindings (`packages/adapters/src/core/`) rely on. The module is named
`mpf_core.wasm` wherever it is copied (`CORE_WASM_FILE` in `@mpf/core`).

## Module shape

- Target `wasm32-unknown-unknown`, `panic = "abort"`, `opt-level = "z"`, `lto = true`.
- **Zero imports.** The module must not import anything (no WASI, no host functions). The Node host
  (`packages/wasm-core/src/host.ts`), which the build stage runs over the fresh module, refuses a
  module with imports, so the same binary loads in every host without shims.
- Exports:

| Export            | Signature                                       | Meaning                                               |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `memory`          | linear memory                                   | Shared with the host for passing bytes.               |
| `mpf_abi_version` | `() -> i32`                                     | `1` for this contract. Hosts refuse other values.     |
| `mpf_alloc`       | `(len: i32) -> ptr: i32`                        | Reserve `len` bytes the host may write into.          |
| `mpf_free`        | `(ptr: i32, len: i32)`                          | Release a block returned by `mpf_alloc` or by a call. |
| `mpf_call`        | `(name_ptr, name_len, req_ptr, req_len) -> i64` | Invoke a function by name with a UTF-8 JSON request.  |
| `mpf_manifest`    | `() -> i64`                                     | The manifest (see below) as UTF-8 JSON.               |

An `i64` result packs a block: the high 32 bits are the pointer, the low 32 bits the byte length.
The host reads the bytes, then frees them with `mpf_free(ptr, len)`.

## Calls

Requests and responses are UTF-8 JSON. A function receives the request object and answers with an
envelope:

```json
{ "ok": true,  "value": <any JSON> }
{ "ok": false, "error": { "code": "invalid_input", "message": "..." } }
```

Error codes are stable strings chosen by the core (`invalid_input`, `unknown_function`,
`unimplemented`, `internal`). A request that is not JSON answers `invalid_input`; a name the
manifest does not list answers `unknown_function`; the template scaffolds every planned function
as a stub that answers `unimplemented` so the crate builds before the worker fills it in. A panic
aborts the instance; the crate must validate instead of panicking.

## Manifest

```json
{
  "abiVersion": 1,
  "functions": [
    { "name": "computeTotal", "description": "...", "inputSchema": { ... }, "outputSchema": { ... } }
  ]
}
```

`inputSchema` and `outputSchema` are JSON Schema (draft-7). The factory writes the manifest from
the port plan when it scaffolds the crate; the build stage reads it back through `mpf_manifest`
so edits inside the crate win. Host bindings (Swift, Kotlin, TypeScript) are generated from it and
never hand-written.

## Determinism

The core has no clock, random source, locale, or I/O. Anything time- or locale-dependent is an
explicit input (`nowMs`, `timeZone`, `locale`, `seed`). This is what makes golden vectors
meaningful on every host.

## Golden vectors and parity

`vectors/<function>.json` holds `{ "function": "...", "vectors": [ { "id", "input", "expected",
"provenance": "executed" | "derived", "note"? } ] }`. `executed` vectors were recorded by running
the source app's logic (the core workers may run the source platform's interpreter for this);
`derived` vectors were written by reading it. Five hosts assert the same files: `cargo test`
natively, the Node host over the `.wasm` (both in the `core.build` stage), the web scaffold's
vitest, XCTest through WasmKit on the simulator, and JUnit through Chicory on the JVM. Their
results, keyed by function and vector id, form the parity matrix on the dashboard's tests page and
the "Shared core" section of each `PORT.md`.
