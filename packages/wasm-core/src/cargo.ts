import { existsSync } from 'node:fs'
import { join, relative } from 'pathe'
import type { Diagnostic } from '@mpf/core'
import { runProcess, type RustTools } from '@mpf/harness'
import { CORE_WASM } from './template.ts'

export interface CargoRunOptions {
  cwd: string
  tools: RustTools
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
  timeoutMs?: number
}

export interface CargoBuildResult {
  ok: boolean
  /** Workspace-relative path of the module when the build succeeded. */
  wasm?: string
  bytes?: number
  diagnostics: Diagnostic[]
  logTail: string
  durationMs: number
}

export interface CargoTestResult {
  ok: boolean
  /** Failure lines from the vectors test, one per vector. */
  failures: string[]
  diagnostics: Diagnostic[]
  logTail: string
  durationMs: number
}

export const WASM_TARGET = 'wasm32-unknown-unknown'
export const WASM_OUT = `target/${WASM_TARGET}/release/${CORE_WASM}`

/** `cargo build --release --target wasm32-unknown-unknown`, with rustc diagnostics parsed. */
export async function buildCoreWasm(o: CargoRunOptions): Promise<CargoBuildResult> {
  const r = await runProcess({
    command: o.tools.cargo,
    args: ['build', '--release', '--target', WASM_TARGET, '--color', 'never'],
    cwd: o.cwd,
    env: o.tools.env,
    timeoutMs: o.timeoutMs ?? 15 * 60_000,
    signal: o.signal,
    onStdout: o.onOutput,
    onStderr: o.onOutput,
  })
  const output = `${r.stdout}\n${r.stderr}`
  const ok = r.exitCode === 0 && existsSync(join(o.cwd, WASM_OUT))
  return {
    ok,
    wasm: ok ? WASM_OUT : undefined,
    diagnostics: ok ? [] : parseCargoOutput(output, o.cwd),
    logTail: output.slice(-4000),
    durationMs: r.durationMs,
  }
}

/** `cargo test` on the host: unit tests plus the golden-vector suite. */
export async function testCore(o: CargoRunOptions): Promise<CargoTestResult> {
  const r = await runProcess({
    command: o.tools.cargo,
    args: ['test', '--color', 'never', '--', '--nocapture'],
    cwd: o.cwd,
    env: o.tools.env,
    timeoutMs: o.timeoutMs ?? 15 * 60_000,
    signal: o.signal,
    onStdout: o.onOutput,
    onStderr: o.onOutput,
  })
  const output = `${r.stdout}\n${r.stderr}`
  const failures = parseVectorFailures(output)
  return {
    ok: r.exitCode === 0,
    failures,
    diagnostics: r.exitCode === 0 ? [] : parseCargoOutput(output, o.cwd),
    logTail: output.slice(-4000),
    durationMs: r.durationMs,
  }
}

/**
 * rustc diagnostics:
 *   error[E0425]: cannot find value `x` in this scope
 *     --> src/api/total.rs:12:9
 */
export function parseCargoOutput(output: string, cwd: string): Diagnostic[] {
  const diags: Diagnostic[] = []
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^(error|warning)(?:\[(\w+)\])?: (.+)$/.exec(lines[i]!)
    if (!m) continue
    const [, sev, code, message] = m
    if (/^\d+ warnings? emitted$|^aborting due to|^could not compile/.test(message!)) continue
    let file: string | undefined
    let line: number | undefined
    let column: number | undefined
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const loc = /^\s*--> (.+?):(\d+):(\d+)/.exec(lines[j]!)
      if (loc) {
        file = relative(cwd, join(cwd, loc[1]!))
        line = Number(loc[2])
        column = Number(loc[3])
        break
      }
    }
    diags.push({
      severity: sev === 'error' ? 'error' : 'warning',
      file,
      line,
      column,
      message: code ? `${message} [${code}]` : message!,
      tool: 'rustc',
    })
  }
  if (!diags.some((d) => d.severity === 'error') && /error/i.test(output)) {
    const tail = output
      .split('\n')
      .filter((l) => /error/i.test(l))
      .slice(-3)
      .join('\n')
    diags.push({ severity: 'error', message: tail || 'cargo failed', tool: 'cargo' })
  }
  return diags
}

/** Lines the vectors test prints per failing vector: `<function>/<id>: expected ... got ...`. */
export function parseVectorFailures(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9_-]+\/[^:]+: (expected|error)/.test(l))
}
