import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MpfConfig } from '@mpf/core'
import { hasWasmTarget, rustTools } from '@mpf/harness'
import { WASM_OUT, buildCoreWasm, testCore } from '../src/cargo.ts'
import { loadCore } from '../src/host.ts'
import { coreFiles } from '../src/template.ts'
import { runVectors, writeVectorSets } from '../src/vectors.ts'

const tools = await rustTools(MpfConfig.parse({}), process.env)
const wasmReady = tools ? await hasWasmTarget(tools) : false

/** Toolchain-tagged: builds the template crate for real. Skipped without cargo + wasm32. */
describe.skipIf(!wasmReady)('@toolchain:rust core ABI end to end', () => {
  it(
    'builds the scaffold, then a filled function answers through the Node host and the vectors',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mpf-core-'))
      const files = coreFiles({
        appName: 'Counter',
        functions: [
          {
            name: 'clampCount',
            description: 'count never below zero',
            inputSchema: { type: 'object', properties: { count: { type: 'integer' } } },
            outputSchema: { type: 'integer' },
            sourceSymbols: ['main.js:clampCount'],
          },
        ],
      })
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true })
        writeFileSync(join(dir, rel), content)
      }
      // Fill the stub the way the worker would.
      writeFileSync(
        join(dir, 'src/api/clamp_count.rs'),
        `use crate::{CoreError, CoreResult};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct Input { count: i64 }

pub fn call(input: Value) -> CoreResult {
    let req: Input = serde_json::from_value(input)?;
    if req.count > 1_000_000 { return Err(CoreError::invalid_input("count too large")); }
    Ok(json!(req.count.max(0)))
}
`,
      )
      writeVectorSets(dir, [
        {
          function: 'clampCount',
          vectors: [
            { id: 'positive', input: { count: 3 }, expected: 3, provenance: 'derived' },
            { id: 'negative', input: { count: -2 }, expected: 0, provenance: 'derived' },
          ],
        },
      ])
      const build = await buildCoreWasm({ cwd: dir, tools: tools!, timeoutMs: 10 * 60_000 })
      expect(build.diagnostics).toEqual([])
      expect(build.ok).toBe(true)
      const test = await testCore({ cwd: dir, tools: tools!, timeoutMs: 10 * 60_000 })
      expect(test.failures).toEqual([])
      expect(test.ok).toBe(true)

      const core = await loadCore(readFileSync(join(dir, WASM_OUT)))
      expect(core.imports).toEqual([])
      expect(core.manifest.functions.map((f) => f.name)).toEqual(['clampCount'])
      expect(core.call('clampCount', { count: -5 })).toBe(0)
      expect(core.call('clampCount', { count: 7 })).toBe(7)
      expect(core.callRaw('clampCount', { count: 'x' })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      })
      expect(core.callRaw('nope', {})).toMatchObject({
        ok: false,
        error: { code: 'unknown_function' },
      })
      expect(core.callRaw('clampCount', { count: 2_000_000 })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input', message: 'count too large' },
      })

      const report = runVectors(core, [
        {
          function: 'clampCount',
          vectors: [
            { id: 'positive', input: { count: 3 }, expected: 3, provenance: 'derived' },
            { id: 'wrong', input: { count: 3 }, expected: 4, provenance: 'derived' },
            { id: 'bad', input: { count: 'x' }, expected: 0, provenance: 'derived' },
          ],
        },
      ])
      expect(report.summary).toEqual({ total: 3, passed: 1, failed: 2 })
      expect(report.cases.map((c) => c.status)).toEqual(['pass', 'fail', 'error'])
      // A large payload round-trips through linear memory growth (serde ignores the unknown field here).
      expect(core.callRaw('clampCount', { count: 1, pad: 'x'.repeat(200_000) })).toEqual({
        ok: true,
        value: 1,
      })
    },
    10 * 60_000,
  )
})
