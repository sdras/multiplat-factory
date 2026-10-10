import type { Diagnostic } from '@mpf/core'

/**
 * Parse compiler and build diagnostics out of Gradle output.
 * Handles Kotlin (`e: file:///path/File.kt:12:5 message`), Java (`/path/File.java:12: error: message`),
 * AAPT/resource errors, and the "What went wrong" block.
 */
export function parseGradleOutput(output: string, workspace: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const seen = new Set<string>()
  const push = (d: Diagnostic) => {
    const key = `${d.file}:${d.line}:${d.message}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(d)
  }
  const rel = (p: string) =>
    p.startsWith(workspace) ? p.slice(workspace.length).replace(/^\//, '') : p
  const lines = output.split('\n')
  for (const raw of lines) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '')
    let m = /^([ew]): file:\/\/([^:]+):(\d+):(\d+)\s+(.*)$/.exec(line)
    if (m) {
      push({
        severity: m[1] === 'e' ? 'error' : 'warning',
        file: rel(m[2]!),
        line: Number(m[3]),
        column: Number(m[4]),
        message: m[5]!.trim(),
        tool: 'kotlinc',
      })
      continue
    }
    m = /^([^\s:]+\.java):(\d+):\s+(error|warning):\s+(.*)$/.exec(line)
    if (m) {
      push({
        severity: m[3] === 'error' ? 'error' : 'warning',
        file: rel(m[1]!),
        line: Number(m[2]),
        message: m[4]!.trim(),
        tool: 'javac',
      })
      continue
    }
    m = /^([^\s:]+\.(xml|kts|gradle)):(\d+):(\d+)?:?\s*(error|Error|warning):?\s+(.*)$/.exec(line)
    if (m) {
      push({
        severity: /error/i.test(m[5]!) ? 'error' : 'warning',
        file: rel(m[1]!),
        line: Number(m[3]),
        message: m[6]!.trim(),
        tool: 'gradle',
      })
      continue
    }
    m = /^ERROR:\s*([^\s:]+):(\d+):(\d+)?-?\d*:?\s*(.*)$/.exec(line)
    if (m) {
      push({
        severity: 'error',
        file: rel(m[1]!),
        line: Number(m[2]),
        message: m[4]!.trim(),
        tool: 'aapt',
      })
      continue
    }
  }
  const wrong = /\* What went wrong:\n([\s\S]*?)(?:\n\* Try:|\n\n)/.exec(output)
  if (wrong?.[1]) {
    const message = wrong[1].trim().split('\n').slice(0, 6).join(' ').replace(/\s+/g, ' ')
    if (!out.some((d) => message.includes(d.message.slice(0, 40))))
      push({ severity: 'error', message, tool: 'gradle' })
  }
  if (out.length === 0 && /FAILURE|FAILED|error|not found|No such file/i.test(output)) {
    const tail = output.trim().split('\n').slice(-12).join(' ').replace(/\s+/g, ' ').slice(0, 800)
    push({ severity: 'error', message: `build failed: ${tail}`, tool: 'gradle' })
  }
  return out
}

/** A `--console=plain` invocation with a small, deterministic set of flags. */
export function gradleArgs(task: string, extra: string[] = []): string[] {
  return [task, '--console=plain', '--warning-mode=none', '-Dorg.gradle.jvmargs=-Xmx3g', ...extra]
}
