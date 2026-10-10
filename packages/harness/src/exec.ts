import { execa, type Options as ExecaOptions } from 'execa'

export interface RunProcessOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** Cap on captured output per stream, in characters. Streaming callbacks still see everything. */
  captureLimit?: number
}

export interface ProcessResult {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  cancelled: boolean
}

/**
 * Runs a child process with a timeout, kill-tree on abort, and streaming output.
 * Never throws for a non-zero exit; inspect `exitCode`.
 */
export async function runProcess(opts: RunProcessOptions): Promise<ProcessResult> {
  const started = Date.now()
  const limit = opts.captureLimit ?? 2_000_000
  let out = ''
  let err = ''
  const execaOpts: ExecaOptions = {
    cwd: opts.cwd,
    env: opts.env,
    reject: false,
    timeout: opts.timeoutMs,
    cancelSignal: opts.signal,
    killSignal: 'SIGTERM',
    forceKillAfterDelay: 5000,
    cleanup: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  }
  const child = execa(opts.command, opts.args ?? [], execaOpts)
  child.stdout?.on('data', (b: Buffer) => {
    const s = b.toString()
    opts.onStdout?.(s)
    if (out.length < limit) out += s
  })
  child.stderr?.on('data', (b: Buffer) => {
    const s = b.toString()
    opts.onStderr?.(s)
    if (err.length < limit) err += s
  })
  const result = await child
  return {
    command: [opts.command, ...(opts.args ?? [])].join(' '),
    exitCode: result.exitCode ?? null,
    stdout: out,
    stderr: err,
    durationMs: Date.now() - started,
    timedOut: Boolean(result.timedOut),
    cancelled: Boolean(result.isCanceled),
  }
}

/** Resolve a binary on PATH; returns undefined when absent. */
export async function which(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  const r = await runProcess({ command: cmd, args: [bin], env, timeoutMs: 5000 })
  if (r.exitCode !== 0) return undefined
  const first = r.stdout.split(/\r?\n/).find((l) => l.trim().length > 0)
  return first?.trim()
}

/** Run a command and return trimmed stdout, or undefined on any failure. */
export async function tryOutput(
  command: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 15_000,
): Promise<string | undefined> {
  try {
    const r = await runProcess({ command, args, env, timeoutMs })
    if (r.exitCode !== 0) return undefined
    return r.stdout.trim()
  } catch {
    return undefined
  }
}
