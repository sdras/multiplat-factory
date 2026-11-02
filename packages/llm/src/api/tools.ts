import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'pathe'
import type { ToolDefinition } from './types.ts'

/**
 * The worker tools of the OpenAI-compatible backend. They carry the names and input fields of the
 * Claude Code tools so the stage prompts, the sandbox policy (`decide`), and the dashboard's
 * transcript view work unchanged whichever backend runs a worker.
 */

export interface ToolResult {
  text: string
  isError: boolean
  /** An image the model should see (a `Read` of a screenshot); attached as a user message. */
  image?: { dataUrl: string; path: string; bytes: number }
}

export interface ToolContext {
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export const TOOL_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** Directories never searched: dependency and build output. */
export const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.gradle',
  'target',
  '.nuxt',
  '.output',
])

const READ_DEFAULT_LIMIT = 2000
const READ_LINE_MAX = 2000
const GLOB_MAX_ENTRIES = 500
const GREP_MAX_LINES = 200
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024
const WALK_MAX_ENTRIES = 200_000
const BASH_DEFAULT_TIMEOUT_MS = 120_000
/** How long after bash exits to wait for its pipes before settling without them. */
const BASH_STREAM_GRACE_MS = 1000
const BASH_MAX_TIMEOUT_MS = 600_000
export const BASH_OUTPUT_MAX_CHARS = 30_000

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  Read: {
    type: 'function',
    function: {
      name: 'Read',
      description:
        'Read a file from the workspace. Returns its lines numbered like `cat -n` (up to 2000 lines per call; use offset and limit for more). PNG, JPEG, GIF, and WebP files are returned as an image you can look at. Paths are absolute or relative to the working directory.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path of the file to read.' },
          offset: {
            type: 'integer',
            description: 'Line number (1-based) to start reading from; defaults to the first line.',
          },
          limit: {
            type: 'integer',
            description: 'Number of lines to read; defaults to 2000.',
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
    },
  },
  Write: {
    type: 'function',
    function: {
      name: 'Write',
      description:
        'Create or overwrite a file with the given content, creating parent directories as needed. Read an existing file before overwriting it; prefer Edit for changes to an existing file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path of the file to write.' },
          content: { type: 'string', description: 'The full new content of the file.' },
        },
        required: ['file_path', 'content'],
        additionalProperties: false,
      },
    },
  },
  Edit: {
    type: 'function',
    function: {
      name: 'Edit',
      description:
        'Replace text in an existing file. old_string must occur exactly once in the file (include enough surrounding lines to make it unique) unless replace_all is true, in which case every occurrence is replaced. Read the file first so old_string matches it exactly, indentation included.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path of the file to edit.' },
          old_string: { type: 'string', description: 'The exact text to replace.' },
          new_string: { type: 'string', description: 'The replacement text.' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence of old_string (default false).',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
  },
  Glob: {
    type: 'function',
    function: {
      name: 'Glob',
      description:
        'Find files by glob pattern (`**/*.swift`, `src/**/*.test.ts`, `*.kt`). Lists matching paths relative to the searched directory, skipping dependency and build folders; at most 500 results.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The glob pattern to match against.' },
          path: {
            type: 'string',
            description: 'Directory to search in; defaults to the working directory.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  Grep: {
    type: 'function',
    function: {
      name: 'Grep',
      description:
        'Search file contents with a regular expression (JavaScript syntax). By default lists the files that match; output_mode "content" prints each matching line as `file:line: text`, "count" prints the number of matches per file. Dependency and build folders, binary files, and files over 2 MB are skipped; output stops after 200 lines.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The regular expression to search for.' },
          path: {
            type: 'string',
            description: 'File or directory to search; defaults to the working directory.',
          },
          glob: {
            type: 'string',
            description: 'Only search files whose name matches this glob (for example `*.swift`).',
          },
          '-i': { type: 'boolean', description: 'Case-insensitive search.' },
          output_mode: {
            type: 'string',
            enum: ['files_with_matches', 'content', 'count'],
            description: 'What to print; defaults to files_with_matches.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  Bash: {
    type: 'function',
    function: {
      name: 'Bash',
      description:
        "Run a shell command in the working directory with bash and return its stdout, stderr, and exit code. Only commands on this worker's allowlist run; a refused command comes back with the reason. Output is cut to 30,000 characters (head and tail). Use relative paths and do not change directory outside the workspace.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run.' },
          timeout: {
            type: 'integer',
            description: 'Timeout in milliseconds (default 120000, at most 600000).',
          },
          description: {
            type: 'string',
            description: 'A few words saying what the command does, for the run log.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
}

/** Resolve the input's path fields against the worker's cwd so the policy judges absolute paths. */
export function normalizeInput(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  const out = { ...input }
  for (const key of ['file_path', 'path']) {
    const v = out[key]
    if (typeof v === 'string' && v.length && !isAbsolute(v)) out[key] = resolve(cwd, v)
  }
  // An absolute Glob pattern names its own root: move it into `path` so the policy judges it
  // (`Glob({ pattern: '/Users/x/.ssh/*' })` listed files outside the workspace before this).
  if (name === 'Glob' && typeof out.pattern === 'string' && isAbsolute(out.pattern)) {
    const split = splitGlobRoot(out.pattern)
    out.path = split.root
    out.pattern = split.rest || '**'
  }
  if (name === 'Bash' && typeof out.timeout === 'string') out.timeout = Number(out.timeout)
  return out
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'Read':
        return readTool(input)
      case 'Write':
        return writeTool(input)
      case 'Edit':
        return editTool(input)
      case 'Glob':
        return globTool(input, ctx)
      case 'Grep':
        return grepTool(input, ctx)
      case 'Bash':
        return await bashTool(input, ctx)
      default:
        return failure(`Unknown tool: ${name}`)
    }
  } catch (err) {
    return failure(`${name} failed: ${(err as Error).message ?? String(err)}`)
  }
}

function failure(text: string): ToolResult {
  return { text, isError: true }
}

function pathArg(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' && v.length ? v : undefined
}

// --- Read ---------------------------------------------------------------------------------------

function readTool(input: Record<string, unknown>): ToolResult {
  const file = pathArg(input, 'file_path')
  if (!file) return failure('Read needs a file_path')
  if (!existsSync(file)) return failure(`File does not exist: ${file}`)
  const st = statSync(file)
  if (st.isDirectory())
    return failure(`${file} is a directory; use Glob to list its files or Read a file inside it`)
  const mime = IMAGE_TYPES[extname(file).toLowerCase()]
  if (mime) {
    const data = readFileSync(file)
    return {
      text: `[image ${basename(file)}: ${mime}, ${data.length} bytes; the image is attached to the next message]`,
      isError: false,
      image: {
        dataUrl: `data:${mime};base64,${data.toString('base64')}`,
        path: file,
        bytes: data.length,
      },
    }
  }
  const buf = readFileSync(file)
  if (isBinary(buf))
    return failure(
      `${file} is a binary file (${buf.length} bytes); Read shows text files and images`,
    )
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (text.length === 0) return { text: '(empty file)', isError: false }
  const offset = Math.max(1, Math.floor(Number(input.offset ?? 1)) || 1)
  const limit = Math.max(
    1,
    Math.floor(Number(input.limit ?? READ_DEFAULT_LIMIT)) || READ_DEFAULT_LIMIT,
  )
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  if (!slice.length)
    return failure(`offset ${offset} is past the end of the file (${lines.length} lines)`)
  const body = slice
    .map((line, i) => {
      const cut = line.length > READ_LINE_MAX ? `${line.slice(0, READ_LINE_MAX)}… (line cut)` : line
      return `${String(offset + i).padStart(6)}\t${cut}`
    })
    .join('\n')
  const remaining = lines.length - (offset - 1 + slice.length)
  return {
    text:
      remaining > 0
        ? `${body}\n\n(${remaining} more lines; continue with offset ${offset + slice.length})`
        : body,
    isError: false,
  }
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

// --- Write / Edit -------------------------------------------------------------------------------

function writeTool(input: Record<string, unknown>): ToolResult {
  const file = pathArg(input, 'file_path')
  if (!file) return failure('Write needs a file_path')
  if (typeof input.content !== 'string') return failure('Write needs a string content')
  if (existsSync(file) && statSync(file).isDirectory()) return failure(`${file} is a directory`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, input.content)
  return { text: `Wrote ${Buffer.byteLength(input.content)} bytes to ${file}`, isError: false }
}

function editTool(input: Record<string, unknown>): ToolResult {
  const file = pathArg(input, 'file_path')
  if (!file) return failure('Edit needs a file_path')
  const oldString = input.old_string
  const newString = input.new_string
  if (typeof oldString !== 'string' || typeof newString !== 'string')
    return failure('Edit needs string old_string and new_string')
  if (!existsSync(file)) return failure(`File does not exist: ${file}`)
  if (statSync(file).isDirectory()) return failure(`${file} is a directory`)
  if (oldString === newString)
    return failure('No changes to make: old_string and new_string are exactly the same.')
  if (oldString === '') return failure('old_string must not be empty; use Write to create a file.')
  const text = readFileSync(file, 'utf8')
  const count = occurrences(text, oldString)
  if (count === 0) return failure(`String to replace not found in file: ${file}`)
  const replaceAll = input.replace_all === true
  if (count > 1 && !replaceAll)
    return failure(
      `Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.`,
    )
  const updated = replaceAll
    ? text.split(oldString).join(newString)
    : text.replace(oldString, () => newString)
  writeFileSync(file, updated)
  const at = updated.indexOf(newString)
  return {
    text: `The file ${file} has been updated (${count} replacement${count === 1 ? '' : 's'}).${
      replaceAll || at < 0 ? '' : `\n${snippetAround(updated, at, newString.length)}`
    }`,
    isError: false,
  }
}

function occurrences(text: string, needle: string): number {
  let count = 0
  let i = text.indexOf(needle)
  while (i >= 0) {
    count++
    i = text.indexOf(needle, i + needle.length)
  }
  return count
}

/** A `cat -n` view of the lines around a replacement so the model sees what landed. */
function snippetAround(text: string, start: number, length: number): string {
  const lines = text.split('\n')
  const firstLine = text.slice(0, start).split('\n').length
  const lastLine = text.slice(0, start + length).split('\n').length
  const from = Math.max(1, firstLine - 3)
  const to = Math.min(lines.length, lastLine + 3)
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(6)}\t${l}`)
    .join('\n')
}

// --- Glob / Grep --------------------------------------------------------------------------------

interface WalkEntry {
  /** Posix path relative to the walk root. */
  rel: string
  abs: string
  isDirectory: boolean
}

/** Every file and directory under `root` except the skipped folders and symlinks. */
function* walk(root: string): Generator<WalkEntry> {
  const stack: string[] = ['']
  let seen = 0
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (++seen > WALK_MAX_ENTRIES) return
      if (entry.isSymbolicLink()) continue
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue
        yield { rel, abs: join(root, rel), isDirectory: true }
        stack.push(rel)
      } else if (entry.isFile()) {
        yield { rel, abs: join(root, rel), isDirectory: false }
      }
    }
  }
}

/** A glob (`**`, `*`, `?`, `{a,b}`, `[...]`) as a regular expression over posix paths. */
export function globToRegExp(pattern: string): RegExp {
  let re = '^'
  let braces = 0
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else if (ch === '{') {
      braces++
      re += '(?:'
    } else if (ch === '}' && braces) {
      braces--
      re += ')'
    } else if (ch === ',' && braces) re += '|'
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end < 0) re += '\\['
      else {
        re += pattern.slice(i, end + 1).replace(/^\[!/, '[^')
        i = end
      }
    } else re += ch.replace(/[$()+.\\^|]/g, '\\$&')
  }
  return new RegExp(`${re}$`)
}

/** Split an absolute glob into its literal directory prefix and the pattern below it. */
function splitGlobRoot(pattern: string): { root: string; rest: string } {
  const parts = pattern.split('/')
  const fixed: string[] = []
  while (parts.length && !/[*?[{]/.test(parts[0]!)) fixed.push(parts.shift()!)
  return { root: fixed.join('/') || '/', rest: parts.join('/') }
}

function globTool(input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  let pattern = typeof input.pattern === 'string' ? input.pattern : ''
  if (!pattern) return failure('Glob needs a pattern')
  let root = pathArg(input, 'path') ?? ctx.cwd
  let absoluteOutput = false
  if (isAbsolute(pattern)) {
    const split = splitGlobRoot(pattern)
    root = split.root
    pattern = split.rest || '**'
    absoluteOutput = true
  }
  if (!existsSync(root) || !statSync(root).isDirectory())
    return failure(`No such directory: ${root}`)
  const re = globToRegExp(pattern.replace(/^\.\//, ''))
  const matches: string[] = []
  let more = false
  for (const entry of walk(root)) {
    if (!re.test(entry.rel)) continue
    if (matches.length >= GLOB_MAX_ENTRIES) {
      more = true
      break
    }
    matches.push(absoluteOutput ? entry.abs : entry.rel)
  }
  matches.sort()
  if (!matches.length)
    return { text: `No files found for ${pattern} under ${root}`, isError: false }
  const header =
    !absoluteOutput && resolve(root) !== resolve(ctx.cwd)
      ? `Matches under ${root} (paths relative to it):\n`
      : ''
  return {
    text: `${header}${matches.join('\n')}${more ? `\n… (more than ${GLOB_MAX_ENTRIES} matches; narrow the pattern)` : ''}`,
    isError: false,
  }
}

function grepTool(input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  if (!pattern) return failure('Grep needs a pattern')
  let re: RegExp
  try {
    re = new RegExp(pattern, input['-i'] === true ? 'i' : '')
  } catch (err) {
    return failure(`Invalid regular expression: ${(err as Error).message}`)
  }
  const root = pathArg(input, 'path') ?? ctx.cwd
  if (!existsSync(root)) return failure(`No such file or directory: ${root}`)
  const mode = (input.output_mode as string | undefined) ?? 'files_with_matches'
  if (!['files_with_matches', 'content', 'count'].includes(mode))
    return failure(`Unknown output_mode: ${mode}`)
  const nameFilter = typeof input.glob === 'string' && input.glob ? globToRegExp(input.glob) : null
  const nameFilterOnBasename = nameFilter !== null && !input.glob!.toString().includes('/')
  const single = statSync(root).isFile()
  const files: Array<{ rel: string; abs: string }> = single
    ? [{ rel: basename(root), abs: root }]
    : [...walk(root)].filter((e) => !e.isDirectory)
  const lines: string[] = []
  let truncated = false
  const push = (line: string): boolean => {
    if (lines.length >= GREP_MAX_LINES) {
      truncated = true
      return false
    }
    lines.push(line)
    return true
  }
  const label = (rel: string, abs: string) => (single ? abs : relativeToCwd(abs, ctx.cwd, rel))
  scan: for (const file of files) {
    if (nameFilter && !nameFilter.test(nameFilterOnBasename ? basename(file.rel) : file.rel))
      continue
    let buf: Buffer
    try {
      const st = statSync(file.abs)
      if (st.size > GREP_MAX_FILE_BYTES) continue
      buf = readFileSync(file.abs)
    } catch {
      continue
    }
    if (isBinary(buf)) continue
    const text = buf.toString('utf8').split('\n')
    let count = 0
    for (let i = 0; i < text.length; i++) {
      if (!re.test(text[i]!)) continue
      count++
      if (mode === 'files_with_matches') {
        if (!push(label(file.rel, file.abs))) break scan
        break
      }
      if (mode === 'content') {
        const line = text[i]!
        const shown = line.length > 500 ? `${line.slice(0, 500)}…` : line
        if (!push(`${label(file.rel, file.abs)}:${i + 1}: ${shown}`)) break scan
      }
    }
    if (mode === 'count' && count > 0 && !push(`${label(file.rel, file.abs)}: ${count}`)) break
  }
  if (!lines.length) return { text: 'No matches found', isError: false }
  return {
    text: `${lines.join('\n')}${truncated ? `\n… (output cut at ${GREP_MAX_LINES} lines; narrow the search)` : ''}`,
    isError: false,
  }
}

/** A path under the worker's cwd is shown relative to it (a Read of it resolves there); others stay absolute. */
function relativeToCwd(abs: string, cwd: string, fallbackRel: string): string {
  const rel = relative(resolve(cwd), resolve(abs))
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel
  return resolve(cwd) === resolve(abs) ? fallbackRel : abs
}

// --- Bash ---------------------------------------------------------------------------------------

/** Keeps the first and last `half` characters of a stream, with the dropped count in between. */
class HeadTail {
  private head = ''
  private tail = ''
  private dropped = 0
  constructor(private readonly half: number) {}

  push(chunk: string): void {
    if (this.head.length < this.half) {
      const take = Math.min(chunk.length, this.half - this.head.length)
      this.head += chunk.slice(0, take)
      chunk = chunk.slice(take)
      if (!chunk) return
    }
    this.tail += chunk
    if (this.tail.length > this.half) {
      this.dropped += this.tail.length - this.half
      this.tail = this.tail.slice(this.tail.length - this.half)
    }
  }

  toString(): string {
    if (!this.dropped) return this.head + this.tail
    return `${this.head}\n… [${this.dropped} characters omitted] …\n${this.tail}`
  }
}

function bashTool(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = typeof input.command === 'string' ? input.command : ''
  if (!command.trim()) return Promise.resolve(failure('Bash needs a command'))
  const requested = Number(input.timeout)
  const timeoutMs = Math.min(
    BASH_MAX_TIMEOUT_MS,
    Number.isFinite(requested) && requested > 0 ? requested : BASH_DEFAULT_TIMEOUT_MS,
  )
  if (ctx.signal?.aborted) return Promise.resolve(failure('(command not run: aborted)'))
  return new Promise((resolveResult) => {
    const half = Math.floor(BASH_OUTPUT_MAX_CHARS / 2)
    const stdout = new HeadTail(half)
    const stderr = new HeadTail(half)
    let killed: 'timeout' | 'abort' | undefined
    let child: ChildProcess
    try {
      child = spawn('bash', ['-c', command], {
        cwd: ctx.cwd,
        env: ctx.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      resolveResult(failure(`could not start bash: ${(err as Error).message}`))
      return
    }
    const timer = setTimeout(() => {
      killed = 'timeout'
      killTree(child)
    }, timeoutMs)
    const onAbort = () => {
      killed = 'abort'
      killTree(child)
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onAbort)
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk))
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk))
    child.on('error', (err) => {
      cleanup()
      resolveResult(failure(`could not start bash: ${err.message}`))
    })
    let settled = false
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      const out = stdout.toString()
      const err = stderr.toString()
      const parts: string[] = []
      if (out.trim()) parts.push(out.replace(/\n$/, ''))
      if (err.trim()) parts.push(`[stderr]\n${err.replace(/\n$/, '')}`)
      let isError = false
      if (killed === 'timeout') {
        parts.push(`(command killed after the ${timeoutMs} ms timeout)`)
        isError = true
      } else if (killed === 'abort') {
        parts.push('(command aborted)')
        isError = true
      } else if (code !== 0) {
        parts.push(`(exit code ${code ?? `signal ${signal}`})`)
        isError = true
      }
      if (!parts.length) parts.push('(no output)')
      resolveResult({ text: capOutput(parts.join('\n'), BASH_OUTPUT_MAX_CHARS), isError })
    }
    child.on('close', settle)
    // A grandchild that left the process group but kept the pipes open would hold `close` open
    // forever (a killed worker then never settles); once bash itself has exited, give the streams
    // a moment and settle with what arrived.
    child.on('exit', (code, signal) => {
      setTimeout(() => settle(code, signal), BASH_STREAM_GRACE_MS).unref()
    })
  })
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

/** Keep the head and the tail of a long text within `max` characters. */
export function capOutput(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 60) / 2)
  const dropped = text.length - 2 * half
  return `${text.slice(0, half)}\n… [${dropped} characters omitted] …\n${text.slice(text.length - half)}`
}

/** The dashboard's view of a tool result: the first 300 characters and the full length. */
export function summarize(text: string, max = 300): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}… (${t.length} chars)` : t
}
