import type { Diagnostic } from '@mpf/core'
import type { TestOutcome } from '../types.ts'

/** Parse compiler diagnostics from xcodebuild output (`/path/File.swift:12:5: error: message`). */
export function parseXcodebuildOutput(output: string, workspace: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const seen = new Set<string>()
  const rel = (p: string) =>
    p.startsWith(workspace) ? p.slice(workspace.length).replace(/^\//, '') : p
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '')
    const m = /^(\/[^:]+?):(\d+):(\d+): (error|warning|note): (.*)$/.exec(line)
    if (m) {
      const d: Diagnostic = {
        severity: m[4] as Diagnostic['severity'],
        file: rel(m[1]!),
        line: Number(m[2]),
        column: Number(m[3]),
        message: m[5]!.trim(),
        tool: 'swiftc',
      }
      const key = `${d.file}:${d.line}:${d.message}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push(d)
      }
      continue
    }
    const e = /^(?:xcodebuild: )?error: (.*)$/.exec(line)
    if (e && !seen.has(e[1]!)) {
      seen.add(e[1]!)
      out.push({ severity: 'error', message: e[1]!.trim(), tool: 'xcodebuild' })
    }
  }
  if (
    !out.some((d) => d.severity === 'error') &&
    /BUILD FAILED|TEST FAILED|\*\* .* FAILED \*\*/.test(output)
  ) {
    const tail = output.trim().split('\n').slice(-12).join(' ').replace(/\s+/g, ' ').slice(0, 800)
    out.push({ severity: 'error', message: `xcodebuild failed: ${tail}`, tool: 'xcodebuild' })
  }
  return out
}

/** Parse `Test Case '-[Suite test]' passed (0.1 seconds)` lines from xcodebuild test output. */
export function parseXcodebuildTests(
  output: string,
  kind: TestOutcome['kind'] = 'unit',
): TestOutcome {
  const cases: TestOutcome['cases'] = []
  const re = /Test Case '-\[(\S+) (\S+)\]' (passed|failed|skipped)(?: \(([\d.]+) seconds\))?/g
  let m: RegExpExecArray | null
  const failures = new Map<string, string>()
  for (const line of output.split('\n')) {
    const f = /^(\/[^:]+?):(\d+): error: -\[(\S+) (\S+)\] : (.*)$/.exec(line)
    if (f) failures.set(`${f[3]}.${f[4]}`, `${f[5]} (${f[1]!.split('/').pop()}:${f[2]})`)
  }
  while ((m = re.exec(output))) {
    const id = `${m[1]}.${m[2]}`
    const status = m[3] === 'passed' ? 'pass' : m[3] === 'failed' ? 'fail' : 'skip'
    cases.push({
      id,
      name: m[2]!,
      status,
      durationMs: Math.round(Number(m[4] ?? 0) * 1000),
      message: failures.get(id),
      artifacts: [],
    })
  }
  if (!cases.length) {
    return {
      kind,
      status: 'skip',
      skipReason: /BUILD FAILED|error:/.test(output)
        ? 'tests did not compile'
        : 'no test cases ran',
      cases: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
    }
  }
  const passed = cases.filter((c) => c.status === 'pass').length
  const failed = cases.filter((c) => c.status === 'fail').length
  const skipped = cases.filter((c) => c.status === 'skip').length
  return {
    kind,
    status: failed ? 'fail' : passed ? 'pass' : 'skip',
    cases,
    summary: { total: cases.length, passed, failed, skipped, flaky: 0 },
  }
}
