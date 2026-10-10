import { describe, expect, it } from 'vitest'
import { CoreManifest } from '@mpf/core'
import { parseCargoOutput, parseVectorFailures } from '../src/cargo.ts'
import { coreFiles, manifestFor, rustIdent } from '../src/template.ts'
import { jsonEqual } from '../src/vectors.ts'

const FUNCTIONS = [
  {
    name: 'computeTotal',
    description: 'Sum line items with tax',
    inputSchema: { type: 'object', properties: { items: { type: 'array' } } },
    outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
    sourceSymbols: ['cart.ts:computeTotal'],
  },
  {
    name: 'clamp',
    description: 'Clamp a number',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'number' },
    sourceSymbols: [],
  },
]

describe('core crate template', () => {
  it('turns manifest names into Rust identifiers', () => {
    expect(rustIdent('computeTotal')).toBe('compute_total')
    expect(rustIdent('2faSetup')).toBe('f_2fa_setup')
    expect(rustIdent('match')).toBe('match_')
    expect(rustIdent('parse-JSON value')).toBe('parse_json_value')
  })

  it('writes a crate with the ABI, one module per function, the manifest, and the vectors test', () => {
    const files = coreFiles({ appName: 'Cart', functions: FUNCTIONS })
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'Cargo.toml',
        'manifest.json',
        'src/lib.rs',
        'src/api/mod.rs',
        'src/api/compute_total.rs',
        'src/api/clamp.rs',
        'tests/vectors.rs',
        'MPF.md',
      ]),
    )
    expect(files['Cargo.toml']).toContain('crate-type = ["cdylib", "rlib"]')
    expect(files['Cargo.toml']).toContain('panic = "abort"')
    expect(files['src/lib.rs']).toContain('pub extern "C" fn mpf_abi_version() -> i32')
    expect(files['src/lib.rs']).toContain('pub unsafe extern "C" fn mpf_call(')
    expect(files['src/api/mod.rs']).toContain('"computeTotal" => compute_total::call(input),')
    expect(files['src/api/mod.rs']).toContain('"clamp" => clamp::call(input),')
    const manifest = CoreManifest.parse(JSON.parse(files['manifest.json']!))
    expect(manifest.functions.map((f) => f.name)).toEqual(['computeTotal', 'clamp'])
    expect(manifestFor({ appName: 'Cart', functions: FUNCTIONS })).toEqual(manifest)
  })

  it('refuses two functions that collapse to the same module name', () => {
    expect(() =>
      coreFiles({
        appName: 'x',
        functions: [
          { ...FUNCTIONS[1]!, name: 'clamp' },
          { ...FUNCTIONS[1]!, name: 'Clamp' },
        ],
      }),
    ).toThrow(/map to the Rust module/)
  })
})

describe('cargo output parsing', () => {
  it('extracts rustc diagnostics with locations', () => {
    const out = `   Compiling mpf_core v0.1.0 (/w/core)
error[E0425]: cannot find value \`totl\` in this scope
  --> src/api/compute_total.rs:12:9
   |
12 |         totl
   |         ^^^^ help: a local variable with a similar name exists: \`total\`

warning: unused variable: \`x\`
 --> src/api/clamp.rs:3:9

error: aborting due to 1 previous error; 1 warning emitted
error: could not compile \`mpf_core\` (lib) due to 1 previous error; 1 warning emitted`
    const d = parseCargoOutput(out, '/w/core')
    expect(d).toHaveLength(2)
    expect(d[0]).toMatchObject({
      severity: 'error',
      file: 'src/api/compute_total.rs',
      line: 12,
      column: 9,
      tool: 'rustc',
    })
    expect(d[0]!.message).toContain('[E0425]')
    expect(d[1]).toMatchObject({ severity: 'warning', file: 'src/api/clamp.rs', line: 3 })
  })

  it('reads per-vector failures from the vectors test', () => {
    const out = `thread 'golden_vectors' panicked at tests/vectors.rs:30:5:
2 of 9 vectors failed:
computeTotal/empty: expected {"total":0} got {"total":0.0}
clamp/max: error unimplemented: clamp is not implemented yet`
    expect(parseVectorFailures(out)).toEqual([
      'computeTotal/empty: expected {"total":0} got {"total":0.0}',
      'clamp/max: error unimplemented: clamp is not implemented yet',
    ])
  })
})

describe('jsonEqual', () => {
  it('ignores key order and treats 1.0 as 1', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1.0, { c: 2 }], a: 1 })).toBe(true)
    expect(jsonEqual({ a: 1 }, { a: '1' })).toBe(false)
  })
})
