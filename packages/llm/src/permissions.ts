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
      const dir = cd[1]!.replace(/^["']|["']$/g, '')
      if (!within(dir, [...policy.writeRoots, ...policy.readRoots])) {
        return { allow: false, reason: `cd outside the workspace: ${dir}` }
      }
      rest = cmd.slice(cd[0].length)
    }
    // Every command in a `for … do … done` loop or a `;`/`&&`/`||` sequence must be allowed on its own;
    // workers read several files this way and the loop is only as safe as its body.
    const parts = commandsOf(rest)
    const denied = parts.find((part) => !policy.bashAllow.some((re) => re.test(part)))
    if (denied !== undefined) {
      return {
        allow: false,
        reason: `command not in this stage's allowlist: ${denied.slice(0, 80)}`,
      }
    }
    if (/(^|[\s/'"])\.\.(\/|\s|$)/.test(cmd) || /~\//.test(cmd)) {
      return { allow: false, reason: 'command must stay inside the workspace (no .. or ~ paths)' }
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
  const trimmed = line.trim()
  const loop = /^for\s+\w+\s+in\s[^;]*;\s*do\s/.exec(trimmed)
  if (loop) {
    const after = trimmed.slice(loop[0].length)
    const end = after.lastIndexOf('done')
    if (end >= 0 && /^[;\s]*$/.test(after.slice(end + 4))) {
      return commandsOf(after.slice(0, end).replace(/[;\s]+$/, ''))
    }
  }
  return trimmed
    .split(/\s*(?:;|&&|\|\|)\s*/)
    .map((c) => c.trim())
    .filter(Boolean)
}
