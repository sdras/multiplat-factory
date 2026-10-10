import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'pathe'
import type { TestOutcome } from '../types.ts'

/** Parse JUnit XML files (Gradle test reports, Maestro --format junit) into a TestOutcome. */
export function parseJUnitDir(dir: string, kind: TestOutcome['kind']): TestOutcome {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.xml')) : []
  return parseJUnitXml(
    files.map((f) => readFileSync(join(dir, f), 'utf8')),
    kind,
    dir,
  )
}

export function parseJUnitFile(file: string, kind: TestOutcome['kind']): TestOutcome {
  if (!existsSync(file) || !statSync(file).isFile()) return empty(kind, 'no report produced')
  return parseJUnitXml([readFileSync(file, 'utf8')], kind, file)
}

export function parseJUnitXml(
  documents: string[],
  kind: TestOutcome['kind'],
  reportPath?: string,
): TestOutcome {
  const cases: TestOutcome['cases'] = []
  for (const xml of documents) {
    const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(xml))) {
      const attrs = m[1] ?? ''
      const body = m[3] ?? ''
      const name = attr(attrs, 'name') ?? 'test'
      const cls = attr(attrs, 'classname') ?? ''
      const time = Number(attr(attrs, 'time') ?? 0)
      let status: TestOutcome['cases'][number]['status'] = 'pass'
      let message: string | undefined
      const failure =
        /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(body)
      if (failure) {
        status = 'fail'
        message = (attr(failure[2] ?? failure[5] ?? '', 'message') ?? decode(failure[3] ?? ''))
          .trim()
          .slice(0, 1000)
      } else if (/<skipped\b/.test(body)) status = 'skip'
      cases.push({
        id: cls ? `${cls}.${name}` : name,
        name,
        status,
        durationMs: Math.round(time * 1000),
        message,
        artifacts: [],
      })
    }
  }
  if (!cases.length)
    return empty(kind, documents.length ? 'report contained no test cases' : 'no report produced')
  const passed = cases.filter((c) => c.status === 'pass').length
  const failed = cases.filter((c) => c.status === 'fail').length
  const skipped = cases.filter((c) => c.status === 'skip').length
  return {
    kind,
    status: failed ? 'fail' : passed ? 'pass' : 'skip',
    cases,
    summary: { total: cases.length, passed, failed, skipped, flaky: 0 },
    reportPath,
  }
}

function empty(kind: TestOutcome['kind'], reason: string): TestOutcome {
  return {
    kind,
    status: 'skip',
    skipReason: reason,
    cases: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
  }
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
  return m ? decode(m[1] ?? '') : undefined
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&')
}
