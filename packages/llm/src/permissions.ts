import { isAbsolute, relative, resolve } from 'pathe'

export interface PermissionPolicy {
  /** Directories where Write/Edit/NotebookEdit may touch files. */
  writeRoots: string[]
  /** Directories readable in addition to writeRoots. */
  readRoots: string[]
  /** Bash commands must match at least one of these. Empty list denies all Bash. */
  bashAllow: RegExp[]
  /** Tools always denied (default: network). */
  denyTools: string[]
}

export function defaultPolicy(cwd: string, extraRead: string[] = []): PermissionPolicy {
  return {
    writeRoots: [cwd],
    readRoots: [cwd, ...extraRead],
    bashAllow: [],
    // Network is closed; multi-agent fan-out stays with the orchestrator so cost and scope remain predictable.
    denyTools: ['WebFetch', 'WebSearch', 'Workflow', 'Agent', 'Task'],
  }
}

export type Decision = { allow: true } | { allow: false; reason: string }

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS'])

/** Pure decision function so the gate is unit-testable without the SDK. */
export function decide(
  policy: PermissionPolicy,
  tool: string,
  input: Record<string, unknown>,
): Decision {
  if (policy.denyTools.includes(tool))
    return { allow: false, reason: `${tool} is disabled for factory workers` }
  if (WRITE_TOOLS.has(tool)) {
    const p = pathOf(input)
    if (!p) return { allow: false, reason: `${tool} without a file path` }
    return within(p, policy.writeRoots)
      ? { allow: true }
      : { allow: false, reason: `write outside the workspace: ${p}` }
  }
  if (READ_TOOLS.has(tool)) {
    const p = pathOf(input)
    if (!p) return { allow: true } // Glob/Grep without a path search the cwd
    return within(p, [...policy.writeRoots, ...policy.readRoots])
      ? { allow: true }
      : { allow: false, reason: `read outside the workspace: ${p}` }
  }
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '').trim()
    // `cd <inside workspace> && <command>` is common; judge the command after the cd.
    let rest = cmd
    const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/.exec(cmd)
    if (cd) {
      const raw = cd[1]!.replace(/^["']|["']$/g, '')
      // A relative target is relative to the worker's cwd (its first write root), not to this process.
      const dir = isAbsolute(raw) ? raw : resolve(policy.writeRoots[0] ?? '/', raw)
      if (!within(dir, [...policy.writeRoots, ...policy.readRoots])) {
        return { allow: false, reason: `cd outside the workspace: ${raw}` }
      }
      rest = cmd.slice(cd[0].length)
    }
    // Leading `NAME=value` assignments (`S=/path; ls $S`, `FOO=1 cargo test`) are not commands; judge what follows.
    // The path scan below still sees the whole line, so an assignment cannot smuggle a path in.
    rest = withoutLeadingAssignments(rest)
    // Every command in a `for … do … done` loop or a `;`/`&&`/`||` sequence must be allowed on its own;
    // workers read several files this way and the loop is only as safe as its body.
    const parts = commandsOf(rest)
    // The allowlist speaks in relative paths (`cp ../x` and `rm -rf /` never match). A worker that
    // names its own workspace or a read root by its absolute path is doing the same thing, so those
    // prefixes read as `.` for the match; the scan below still judges every absolute path.
    const roots = [...policy.writeRoots, ...policy.readRoots].map((r) => resolve(r))
    const relativized = (part: string): string =>
      roots.reduce((acc, root) => acc.split(`${root}/`).join('./').split(root).join('.'), part)
    const denied = parts.find((part) => !policy.bashAllow.some((re) => re.test(relativized(part))))
    if (denied !== undefined) {
      return {
        allow: false,
        reason: `command not in this stage's allowlist: ${denied.slice(0, 80)}`,
      }
    }
    if (/(^|[\s/'"])\.\.(\/|\s|$)/.test(cmd) || /~\//.test(cmd)) {
      return {
        allow: false,
        reason: `command must stay inside the workspace (no .. or ~ paths): ${cmd.slice(0, 80)}`,
      }
    }
    const escapes = absolutePaths(cmd).filter(
      (p) => !within(p, [...policy.writeRoots, ...policy.readRoots]),
    )
    if (escapes.length)
      return {
        allow: false,
        reason: `command references paths outside the workspace: ${escapes.join(', ')}`,
      }
    return { allow: true }
  }
  // MCP tools registered by the factory and everything else run unless denied above.
  return { allow: true }
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const v = input.file_path ?? input.path ?? input.notebook_path
  return typeof v === 'string' && v.length ? v : undefined
}

function within(p: string, roots: string[]): boolean {
  const abs = resolve(p)
  return roots.some((root) => {
    const rel = relative(resolve(root), abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

/**
 * Absolute filesystem paths mentioned in a command. URLs (`http://host/x`), query strings
 * (`/?seed=`), and regex fragments (`/g)`) are not paths; a path here has at least two
 * segments of plain characters and is not preceded by another slash or a colon.
 */
function absolutePaths(cmd: string): string[] {
  const found = cmd.match(/(?:^|[\s="'])(\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@-]+)+\/?)/g) ?? []
  return found
    .map((m) => m.replace(/^[\s="']+/, ''))
    .filter(
      (p) =>
        !p.startsWith('/dev/') &&
        !p.startsWith('/usr/') &&
        !p.startsWith('/bin/') &&
        !p.startsWith('/opt/') &&
        !p.startsWith('/tmp/'),
    )
}

/**
 * The simple commands a shell line runs: the body of a `for` loop (each statement in it), and the
 * statements of a `;`, `&&`, or `||` sequence. Pipelines stay whole (judged by their first command),
 * and anything this cannot read stays one opaque command that must match the allowlist as is.
 */
export function commandsOf(line: string): string[] {
  const out: string[] = []
  // Every `for … in …; do … done` block, wherever it sits in the line, contributes its body's
  // commands; the text around the blocks is an ordinary sequence.
  const rest = line.replace(
    /for\s+\w+\s+in\s[^;\n]*[;\n]\s*do\s([\s\S]*?)\bdone\b/g,
    (_m, body: string) => {
      out.push(...commandsOf(body.replace(/[;\s]+$/, '')))
      return ' '
    },
  )
  out.push(...splitSequence(rest))
  return out
}

/**
 * Split a shell sequence on `;`, `&&`, `||`, and newlines outside quotes, so a quoted separator
 * (`sed 's|a;b|c|'`, `grep 'x;y'`) stays inside its command.
 */
function splitSequence(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      current += ch
      if (ch === quote && line[i - 1] !== '\\') quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ';' || ch === '\n') {
      parts.push(current)
      current = ''
      continue
    }
    if ((ch === '&' || ch === '|') && line[i + 1] === ch) {
      parts.push(current)
      current = ''
      i++
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((c) => c.trim()).filter(Boolean)
}

/** `S=/path; ls $S` or `FOO=1 cargo test` without the leading `NAME=value` tokens (quoted values included). */
export function withoutLeadingAssignments(line: string): string {
  let rest = line
  for (;;) {
    const m = /^[A-Za-z_]\w*=/.exec(rest)
    if (!m) return rest
    let i = m[0].length
    const quote = rest[i]
    if (quote === '"' || quote === "'") {
      const end = rest.indexOf(quote, i + 1)
      i = end < 0 ? rest.length : end + 1
    } else {
      while (i < rest.length && !/\s/.test(rest[i]!)) i++
    }
    rest = rest.slice(i).trimStart()
    if (rest.startsWith(';')) rest = rest.slice(1).trimStart()
  }
}
