import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { resolveLlm, type OpenAiCompatibleLlm } from '@mpf/core'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentRunOptions } from '../src/agent.ts'
import { apiStructuredCall, runApiAgent } from '../src/api/index.ts'
import { COMPACTION_PLACEHOLDER } from '../src/api/loop.ts'
import type { ChatRequest, ChatResponse } from '../src/api/types.ts'

// --- A fake OpenAI-compatible server ------------------------------------------------------------

interface Reply {
  status?: number
  headers?: Record<string, string>
  body: unknown
  /** Send the headers and part of a body, then cut the connection. */
  truncate?: boolean
}

interface RecordedRequest {
  headers: Record<string, string | string[] | undefined>
  body: ChatRequest
}

interface FakeServer {
  url: string
  requests: RecordedRequest[]
  queue: Reply[]
  close(): Promise<void>
}

async function startServer(): Promise<FakeServer> {
  const requests: RecordedRequest[] = []
  const queue: Reply[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({ headers: req.headers, body: JSON.parse(raw) as ChatRequest })
      const reply = queue.shift() ?? { status: 500, body: { error: 'the test queue is empty' } }
      if (reply.truncate) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' })
        res.write('{"id":"chatcmpl-cut","choices":[')
        res.socket?.destroy()
        return
      }
      res.writeHead(reply.status ?? 200, {
        'Content-Type': 'application/json',
        ...reply.headers,
      })
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    queue,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }

function textReply(text: string, usage = USAGE): Reply {
  const body: ChatResponse = {
    id: 'chatcmpl-1',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage,
  }
  return { body }
}

let callCounter = 0

function toolReply(
  calls: Array<{ name: string; args: unknown; id?: string }>,
  options: { text?: string; usage?: typeof USAGE } = {},
): Reply {
  const body: ChatResponse = {
    id: 'chatcmpl-2',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: options.text ?? null,
          tool_calls: calls.map((c) => ({
            id: c.id ?? `call_${++callCounter}`,
            type: 'function',
            function: {
              name: c.name,
              arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args),
            },
          })),
        },
      },
    ],
    usage: options.usage ?? USAGE,
  }
  return { body }
}

function submitReply(args: unknown, usage = USAGE): Reply {
  return toolReply([{ name: 'submit_result', args }], { usage })
}

function errorReply(status: number, message: string, headers?: Record<string, string>): Reply {
  return { status, headers, body: { error: { message, type: 'invalid_request_error' } } }
}

// --- Fixtures -----------------------------------------------------------------------------------

let server: FakeServer
let home: string
let workspace: string
let llm: OpenAiCompatibleLlm
let events: AgentEvent[]

function backend(settings: Record<string, unknown> = {}): OpenAiCompatibleLlm {
  const resolved = resolveLlm(
    { provider: 'custom', baseUrl: server.url, reasoning: 'on', ...settings },
    { MPF_LLM_API_KEY: 'test-key', MPF_HOME: home } as NodeJS.ProcessEnv,
  )
  if (resolved.backend !== 'openai-compatible') throw new Error('expected the api backend')
  return resolved
}

function run(overrides: Partial<AgentRunOptions> = {}, which = llm) {
  return runApiAgent(
    {
      prompt: 'Do the task.',
      cwd: workspace,
      model: 'test-model',
      maxTurns: 10,
      env: { MPF_HOME: home },
      onEvent: (e) => events.push(e),
      ...overrides,
    },
    which,
  )
}

function toolMessages(req: RecordedRequest) {
  return req.body.messages.filter((m) => m.role === 'tool')
}

beforeEach(async () => {
  process.env.MPF_LLM_RETRY_DELAYS_MS = '1,1,1'
  server = await startServer()
  home = mkdtempSync(join(tmpdir(), 'mpf-api-home-'))
  workspace = mkdtempSync(join(tmpdir(), 'mpf-api-ws-'))
  llm = backend()
  events = []
})

afterEach(async () => {
  await server.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
  delete process.env.MPF_LLM_RETRY_DELAYS_MS
})

// --- Tests --------------------------------------------------------------------------------------

describe('runApiAgent', () => {
  it('runs a Read, Edit, answer loop against the workspace', async () => {
    const file = join(workspace, 'src', 'app.ts')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(file, 'const greeting = "hello"\nexport default greeting\n')
    server.queue.push(
      toolReply([{ name: 'Read', args: { file_path: file }, id: 'call_read' }], {
        text: 'Let me look at the file.',
      }),
      toolReply([
        {
          name: 'Edit',
          args: { file_path: 'src/app.ts', old_string: '"hello"', new_string: '"hi there"' },
          id: 'call_edit',
        },
      ]),
      textReply('Changed the greeting.'),
    )

    const result = await run({ effort: 'medium' })

    expect(result.ok).toBe(true)
    expect(result.text).toBe('Changed the greeting.')
    expect(result.numTurns).toBe(3)
    expect(result.stopReason).toBe('stop')
    expect(result.denials).toBe(0)
    expect(result.usage).toEqual({
      input_tokens: 300,
      output_tokens: 60,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    expect(readFileSync(file, 'utf8')).toBe(
      'const greeting = "hi there"\nexport default greeting\n',
    )

    expect(events.map((e) => e.type)).toEqual([
      'session',
      'message',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'message',
    ])
    const read = events.find((e) => e.type === 'tool_result')
    expect(read).toMatchObject({ toolUseId: 'call_read', tool: 'Read', ok: true })
    expect((read as { summary: string }).summary).toContain('1\tconst greeting = "hello"')
    expect(events[0]).toEqual({ type: 'session', sessionId: result.sessionId })

    const first = server.requests[0]!
    expect(first.headers.authorization).toBe('Bearer test-key')
    expect(first.body.model).toBe('test-model')
    expect(first.body.reasoning_effort).toBe('medium')
    expect(first.body.tool_choice).toBe('auto')
    expect(first.body.tools?.map((t) => t.function.name)).toEqual([
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',
    ])
    expect(first.body.messages[0]).toMatchObject({ role: 'system' })
    expect((first.body.messages[0] as { content: string }).content).toContain(workspace)
    expect(first.body.messages[1]).toEqual({ role: 'user', content: 'Do the task.' })

    const second = server.requests[1]!
    const toolMsgs = toolMessages(second)
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_read' })
    expect((toolMsgs[0] as { content: string }).content).toContain('2\texport default greeting')
    const third = server.requests[2]!
    const editResult = toolMessages(third).find(
      (m) => 'tool_call_id' in m && m.tool_call_id === 'call_edit',
    )
    expect((editResult as { content: string }).content).toContain('has been updated')
  })

  it('offers only the requested tools and never the denied ones', async () => {
    server.queue.push(textReply('ok'))
    await run({
      tools: ['Read', 'Bash'],
      policy: {
        writeRoots: [],
        readRoots: [workspace],
        bashAllow: [],
        denyTools: ['Bash', 'Write', 'Edit'],
      },
    })
    expect(server.requests[0]!.body.tools?.map((t) => t.function.name)).toEqual(['Read'])
  })

  it('validates submit_result and returns the structured value', async () => {
    const schema = z.object({ summary: z.string(), count: z.number().int() })
    server.queue.push(
      submitReply({ summary: 'done', count: 'three' }),
      submitReply({ summary: 'done', count: 3 }),
    )

    const result = await run({ outputSchema: schema })

    expect(result.ok).toBe(true)
    expect(result.structured).toEqual({ summary: 'done', count: 3 })
    expect(result.numTurns).toBe(2)
    const first = server.requests[0]!
    const submit = first.body.tools?.find((t) => t.function.name === 'submit_result')
    expect(submit?.function.parameters).toMatchObject({ type: 'object' })
    expect((first.body.messages[0] as { content: string }).content).toContain('submit_result')
    const validation = toolMessages(server.requests[1]!)[0] as { content: string }
    expect(validation.content).toContain('did not match the schema')
    expect(validation.content).toContain('count')
    const rejected = events.find((e) => e.type === 'tool_result' && !e.ok)
    expect(rejected).toBeDefined()
  })

  it('nudges a model that stops without submitting, then fails', async () => {
    const schema = z.object({ summary: z.string() })
    server.queue.push(textReply('All done.'), textReply('Really done.'))
    const result = await run({ outputSchema: schema })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('worker finished without structured output')
    const nudge = server.requests[1]!.body.messages.at(-1)
    expect(nudge).toEqual({ role: 'user', content: 'Call submit_result with your result now.' })
  })

  it('fails after three invalid submissions', async () => {
    const schema = z.object({ summary: z.string() })
    server.queue.push(
      submitReply({ summary: 1 }),
      submitReply({ summary: 2 }),
      submitReply({ summary: 3 }),
    )
    const result = await run({ outputSchema: schema })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^structured output failed validation: summary/)
  })

  it('refuses a Write outside the workspace and tells the model why', async () => {
    const outside = join(home, 'escape.txt')
    server.queue.push(
      toolReply([{ name: 'Write', args: { file_path: outside, content: 'x' }, id: 'call_w' }]),
      textReply('I could not write there.'),
    )

    const result = await run()

    expect(result.denials).toBe(1)
    expect(events).toContainEqual({
      type: 'denied',
      tool: 'Write',
      reason: `write outside the workspace: ${outside}`,
    })
    const sent = toolMessages(server.requests[1]!)[0] as { tool_call_id: string; content: string }
    expect(sent.tool_call_id).toBe('call_w')
    expect(sent.content).toContain('write outside the workspace')
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false })
  })

  it('stops when the cumulative cost passes the budget', async () => {
    const priced = backend({ pricing: { 'test-model': { input: 1000, output: 1000 } } })
    server.queue.push(
      toolReply([{ name: 'Glob', args: { pattern: '*' } }], {
        usage: { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500 },
      }),
      textReply('never reached'),
    )

    const result = await run({ maxBudgetUsd: 1 }, priced)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('maximum budget')
    expect(result.costUsd).toBeCloseTo(1.5, 5)
    expect(result.numTurns).toBe(1)
    expect(server.requests).toHaveLength(1)
  })

  it('stops at maxTurns', async () => {
    server.queue.push(
      toolReply([{ name: 'Glob', args: { pattern: '*' } }]),
      toolReply([{ name: 'Glob', args: { pattern: '*' } }]),
      toolReply([{ name: 'Glob', args: { pattern: '*' } }]),
    )
    const result = await run({ maxTurns: 2 })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('maximum turns (2) reached')
    expect(result.numTurns).toBe(2)
    expect(server.requests).toHaveLength(2)
  })

  it('resumes a session with its transcript and cumulative cost', async () => {
    const priced = backend({ pricing: { 'test-model': { input: 10, output: 10 } } })
    writeFileSync(join(workspace, 'notes.txt'), 'first\n')
    server.queue.push(
      toolReply([{ name: 'Read', args: { file_path: 'notes.txt' }, id: 'call_r1' }]),
      textReply('Read it.'),
    )
    const first = await run({}, priced)
    expect(first.ok).toBe(true)
    expect(first.costUsd).toBeCloseTo(0.0024, 6)
    expect(first.sessionId).toBeTruthy()
    expect(readFileSync(join(home, 'sessions', `${first.sessionId}.json`), 'utf8')).toContain(
      'call_r1',
    )

    events = []
    server.queue.push(textReply('Still here.'))
    const second = await run({ prompt: 'Follow up.', resume: first.sessionId }, priced)

    expect(second.ok).toBe(true)
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.numTurns).toBe(1)
    expect(second.costUsd).toBeCloseTo(0.0036, 6)
    expect(second.sessionCostUsd).toBeCloseTo(0.0036, 6)
    const sent = server.requests[2]!.body.messages
    expect(sent.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ])
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'Follow up.' })
    expect(sent[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_r1' })

    const missing = await run({ resume: 'no-such-session' }, priced)
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('session no-such-session not found')
  })

  it('sends no reasoning_effort when reasoning is off, and drops it after a 400', async () => {
    const plain = backend({ reasoning: 'off' })
    server.queue.push(textReply('ok'))
    await run({ effort: 'high' }, plain)
    expect(server.requests[0]!.body).not.toHaveProperty('reasoning_effort')

    server.queue.push(
      errorReply(400, 'Unrecognized request argument supplied: reasoning_effort'),
      toolReply([{ name: 'Glob', args: { pattern: '*' } }]),
      textReply('done'),
    )
    const result = await run({ effort: 'high' })
    expect(result.ok).toBe(true)
    expect(server.requests[1]!.body.reasoning_effort).toBe('high')
    expect(server.requests[2]!.body).not.toHaveProperty('reasoning_effort')
    expect(server.requests[3]!.body).not.toHaveProperty('reasoning_effort')
  })

  it('fails at once on 401 and retries a 503', async () => {
    server.queue.push(errorReply(401, 'bad key'))
    const result = await run()
    expect(result.ok).toBe(false)
    expect(result.error).toBe(`authentication failed for ${llm.label}: set MPF_LLM_API_KEY`)
    expect(server.requests).toHaveLength(1)

    server.queue.push(
      errorReply(503, 'busy', { 'Retry-After': '0' }),
      errorReply(503, 'busy'),
      textReply('recovered'),
    )
    const retried = await run()
    expect(retried.ok).toBe(true)
    expect(retried.text).toBe('recovered')
    expect(server.requests).toHaveLength(4)

    server.queue.push(
      errorReply(503, 'busy'),
      errorReply(503, 'busy'),
      errorReply(503, 'busy'),
      errorReply(503, 'busy'),
    )
    const exhausted = await run()
    expect(exhausted.ok).toBe(false)
    expect(exhausted.error).toContain('503')
  })

  it('compacts older tool results when the context overflows', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'A\n')
    const calls = Array.from({ length: 10 }, (_, i) =>
      toolReply([{ name: 'Read', args: { file_path: 'a.txt' }, id: `call_${i}` }]),
    )
    server.queue.push(
      ...calls,
      errorReply(400, "This model's maximum context length is 8192 tokens."),
      textReply('fits now'),
    )

    const result = await run({ maxTurns: 20 })

    expect(result.ok).toBe(true)
    expect(result.text).toBe('fits now')
    const retried = server.requests.at(-1)!
    const tools = toolMessages(retried) as Array<{ content: string }>
    expect(tools).toHaveLength(10)
    expect(tools.slice(0, 2).map((t) => t.content)).toEqual([
      COMPACTION_PLACEHOLDER,
      COMPACTION_PLACEHOLDER,
    ])
    expect(tools.slice(2).every((t) => t.content.includes('A'))).toBe(true)

    server.queue.push(
      toolReply([{ name: 'Read', args: { file_path: 'a.txt' } }]),
      errorReply(400, 'maximum context length exceeded'),
      errorReply(400, 'maximum context length exceeded'),
    )
    const twice = await run({ maxTurns: 20 })
    expect(twice.ok).toBe(false)
    expect(twice.error).toContain('context window exceeded')
  })

  it('runs Bash only when the allowlist admits it, and answers Grep and Glob', async () => {
    mkdirSync(join(workspace, 'src', 'deep'), { recursive: true })
    mkdirSync(join(workspace, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'main.kt'), 'fun main() {\n  println("hello")\n}\n')
    writeFileSync(join(workspace, 'src', 'deep', 'util.kt'), 'fun helper() = "Hello"\n')
    writeFileSync(join(workspace, 'node_modules', 'dep', 'index.kt'), 'fun hello() {}\n')
    writeFileSync(join(workspace, 'README.md'), '# hello\n')

    server.queue.push(
      toolReply([{ name: 'Bash', args: { command: 'echo hi' }, id: 'call_denied' }]),
      textReply('denied'),
    )
    const denied = await run()
    expect(denied.denials).toBe(1)
    expect((toolMessages(server.requests[1]!)[0] as { content: string }).content).toContain(
      'not in this stage',
    )

    server.queue.push(
      toolReply([
        { name: 'Bash', args: { command: 'echo hi' }, id: 'call_bash' },
        { name: 'Bash', args: { command: 'ls no-such-file' }, id: 'call_bash_fail' },
        { name: 'Grep', args: { pattern: 'hello', '-i': true, glob: '*.kt' }, id: 'call_grep' },
        {
          name: 'Grep',
          args: { pattern: 'hello', output_mode: 'content', path: 'src' },
          id: 'call_grep_content',
        },
        { name: 'Grep', args: { pattern: 'hello', output_mode: 'count' }, id: 'call_grep_count' },
        { name: 'Glob', args: { pattern: '**/*.kt' }, id: 'call_glob' },
        { name: 'Glob', args: { pattern: '*.kt', path: 'src' }, id: 'call_glob_path' },
      ]),
      textReply('done'),
    )
    const result = await run({ bashAllow: [/^echo\b/, /^ls\b/] })
    expect(result.ok).toBe(true)
    expect(result.denials).toBe(0)
    const sent = toolMessages(server.requests[3]!) as Array<{
      tool_call_id: string
      content: string
    }>
    const by = (id: string) => sent.find((m) => m.tool_call_id === id)!.content
    expect(by('call_bash')).toBe('hi')
    expect(by('call_bash_fail')).toMatch(/\[stderr\]\n.*no-such-file/)
    expect(by('call_bash_fail')).toMatch(/\(exit code [12]\)$/)
    expect(
      events.find((e) => e.type === 'tool_result' && e.toolUseId === 'call_bash'),
    ).toMatchObject({ ok: true })
    expect(
      events.find((e) => e.type === 'tool_result' && e.toolUseId === 'call_bash_fail'),
    ).toMatchObject({ ok: false })
    expect(by('call_grep').split('\n').sort()).toEqual(['src/deep/util.kt', 'src/main.kt'])
    expect(by('call_grep_content')).toContain('src/main.kt:2:   println("hello")')
    expect(by('call_grep_content')).not.toContain('util.kt')
    expect(by('call_grep_count')).toContain('README.md: 1')
    expect(by('call_grep_count')).toContain('src/main.kt: 1')
    expect(by('call_grep_count')).not.toContain('node_modules')
    expect(by('call_glob').split('\n')).toEqual(['src/deep/util.kt', 'src/main.kt'])
    expect(by('call_glob_path')).toContain('main.kt')
    expect(by('call_glob_path')).not.toContain('util.kt')
  })

  it('turns malformed arguments and unknown tools into error results', async () => {
    server.queue.push(
      toolReply([
        { name: 'Read', args: '{not json', id: 'call_bad' },
        { name: 'Teleport', args: {}, id: 'call_unknown' },
      ]),
      textReply('ok'),
    )
    await run()
    const sent = toolMessages(server.requests[1]!) as Array<{
      tool_call_id: string
      content: string
    }>
    expect(sent.find((m) => m.tool_call_id === 'call_bad')!.content).toContain('Malformed JSON')
    expect(sent.find((m) => m.tool_call_id === 'call_unknown')!.content).toContain('Unknown tool')
  })

  it('attaches an image read with Read as a user message', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    writeFileSync(join(workspace, 'shot.png'), png)
    server.queue.push(
      toolReply([{ name: 'Read', args: { file_path: 'shot.png' }, id: 'call_img' }]),
      textReply('I see it.'),
    )
    const result = await run()
    expect(result.ok).toBe(true)
    const messages = server.requests[1]!.body.messages
    expect(messages.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'call_img' })
    const attached = messages.at(-1) as { role: string; content: Array<{ type: string }> }
    expect(attached.role).toBe('user')
    expect(attached.content[1]).toMatchObject({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
    })
  })

  it('reports an abort and kills a running command', async () => {
    const controller = new AbortController()
    server.queue.push(
      toolReply([{ name: 'Bash', args: { command: 'sleep 30; echo late' }, id: 'call_sleep' }]),
      textReply('never'),
    )
    const started = Date.now()
    const pending = run({ bashAllow: [/^sleep\b/, /^echo\b/], signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.error).toBe('aborted')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(server.requests).toHaveLength(1)
  })
})

describe('apiStructuredCall', () => {
  const schema = z.object({ verdict: z.enum(['pass', 'fail']), score: z.number() })

  it('forces submit_result and returns the parsed data', async () => {
    server.queue.push(submitReply({ verdict: 'pass', score: 4.5 }))
    const result = await apiStructuredCall(
      {
        model: 'test-model',
        system: 'You judge ports.',
        user: [
          { type: 'text', text: 'Judge this.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
        schema,
        effort: 'low',
      },
      llm,
    )
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ verdict: 'pass', score: 4.5 })
    expect(result.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    const req = server.requests[0]!.body
    expect(req.tool_choice).toEqual({ type: 'function', function: { name: 'submit_result' } })
    expect(req.tools?.map((t) => t.function.name)).toEqual(['submit_result'])
    expect(req.reasoning_effort).toBe('low')
    expect(req.messages[0]).toEqual({ role: 'system', content: 'You judge ports.' })
    expect(req.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Judge this.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    })
  })

  it('repairs once on a validation failure, then gives up', async () => {
    server.queue.push(
      submitReply({ verdict: 'maybe', score: 1 }),
      submitReply({ verdict: 'fail', score: 1 }),
    )
    const repaired = await apiStructuredCall(
      { model: 'test-model', system: 's', user: 'u', schema },
      llm,
    )
    expect(repaired.ok).toBe(true)
    expect(repaired.data).toEqual({ verdict: 'fail', score: 1 })
    const second = server.requests[1]!.body.messages
    expect(second.at(-1)).toMatchObject({ role: 'tool' })
    expect((second.at(-1) as { content: string }).content).toContain('verdict')

    server.queue.push(submitReply({ verdict: 'maybe' }), submitReply({ verdict: 'maybe' }))
    const failed = await apiStructuredCall(
      { model: 'test-model', system: 's', user: 'u', schema },
      llm,
    )
    expect(failed.ok).toBe(false)
    expect(failed.error).toMatch(/^structured output failed validation/)
  })

  it('falls back to response_format when tool_choice is rejected', async () => {
    server.queue.push(
      errorReply(400, 'tool_choice is not supported by this model'),
      textReply('```json\n{"verdict":"pass","score":5}\n```'),
    )
    const result = await apiStructuredCall(
      { model: 'test-model', system: 's', user: 'u', schema },
      llm,
    )
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ verdict: 'pass', score: 5 })
    const fallback = server.requests[1]!.body
    expect(fallback.tools).toBeUndefined()
    expect(fallback.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'result' },
    })
  })

  it('reports a refusal and an authentication failure', async () => {
    server.queue.push({
      body: {
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', refusal: 'No.' } },
        ],
        usage: USAGE,
      },
    })
    const refused = await apiStructuredCall(
      { model: 'test-model', system: 's', user: 'u', schema },
      llm,
    )
    expect(refused.ok).toBe(false)
    expect(refused.error).toBe('model refused')
    expect(refused.refusal).toEqual({ category: null, explanation: 'No.' })

    server.queue.push(errorReply(403, 'forbidden'))
    const auth = await apiStructuredCall(
      { model: 'test-model', system: 's', user: 'u', schema },
      llm,
    )
    expect(auth.ok).toBe(false)
    expect(auth.error).toContain('set MPF_LLM_API_KEY')
  })
})

describe('review regressions', () => {
  it('judges an absolute Glob pattern, a Read, and a Grep root by the read roots', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mpf-api-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    server.queue.push(
      toolReply([
        { name: 'Glob', args: { pattern: `${outside}/*` }, id: 'call_glob' },
        { name: 'Read', args: { file_path: join(outside, 'secret.txt') }, id: 'call_read' },
        { name: 'Grep', args: { pattern: 'secret', path: outside }, id: 'call_grep' },
      ]),
      textReply('done'),
    )
    try {
      const result = await run()
      expect(result.denials).toBe(3)
      const sent = toolMessages(server.requests[1]!) as { content: string }[]
      expect(sent).toHaveLength(3)
      for (const m of sent) {
        expect(m.content).toContain('read outside the workspace')
        expect(m.content).not.toContain('top secret')
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('settles a killed command even when a grandchild keeps the pipes open', async () => {
    const command =
      "node -e \"require('child_process').spawn('sleep',['20'],{detached:true,stdio:'inherit'}).unref()\"; echo started; sleep 20"
    server.queue.push(
      toolReply([{ name: 'Bash', args: { command, timeout: 500 }, id: 'call_b' }]),
      textReply('ok'),
    )
    const started = Date.now()
    const result = await run({ bashAllow: [/^node\b/, /^echo\b/, /^sleep\b/] })
    expect(Date.now() - started).toBeLessThan(6_000)
    const sent = toolMessages(server.requests[1]!)[0] as { content: string }
    expect(sent.content).toContain('started')
    expect(sent.content).toContain('killed after the 500 ms timeout')
    expect(result.ok).toBe(true)
  })

  it('retries when the body is cut off after the headers', async () => {
    server.queue.push({ truncate: true, body: null }, textReply('after retry'))
    const result = await run()
    expect(result.ok).toBe(true)
    expect(result.text).toBe('after retry')
    expect(server.requests).toHaveLength(2)
  })

  it('answers every tool call in a structured repair round and passes maxTokens on', async () => {
    const schema = z.object({ verdict: z.enum(['pass', 'fail']), score: z.number() })
    server.queue.push(
      toolReply([
        { name: 'submit_result', args: { verdict: 'maybe' }, id: 'call_a' },
        { name: 'submit_result', args: { verdict: 'maybe' }, id: 'call_b' },
      ]),
      submitReply({ verdict: 'pass', score: 2 }),
    )
    const result = await apiStructuredCall(
      { model: 'test-model', system: 's', user: 'u', schema, maxTokens: 500 },
      llm,
    )
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ verdict: 'pass', score: 2 })
    expect(server.requests[0]!.body.max_tokens).toBe(500)
    const ids = toolMessages(server.requests[1]!).map(
      (m) => (m as { tool_call_id: string }).tool_call_id,
    )
    expect(ids).toEqual(['call_a', 'call_b'])
  })
  it('runs tool calls a model wrote as text and answers them as user messages', async () => {
    writeFileSync(join(workspace, 'notes.txt'), 'first line\nsecond\n')
    const schema = z.object({ firstLine: z.string() })
    server.queue.push(
      textReply('```json\n{"name": "Read", "arguments": {"file_path": "notes.txt"}}\n```'),
      textReply('{"name": "submit_result", "arguments": {"firstLine": "first line"}}'),
    )
    const result = await run({ outputSchema: schema })
    expect(result.ok).toBe(true)
    expect(result.structured).toEqual({ firstLine: 'first line' })
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
    ])
    const second = server.requests[1]!.body.messages
    expect(second.filter((m) => m.role === 'tool')).toHaveLength(0)
    expect(second.at(-2)).toMatchObject({ role: 'assistant' })
    expect(second.at(-1)).toMatchObject({ role: 'user' })
    expect((second.at(-1) as { content: string }).content).toContain('Result of Read')
    expect((second.at(-1) as { content: string }).content).toContain('first line')
  })

  it('reads a structured answer written as text and repairs with a response format', async () => {
    const schema = z.object({ verdict: z.enum(['pass', 'fail']), score: z.number() })
    server.queue.push(
      textReply('{"name": "submit_result", "arguments": {"verdict": "pass"}}'),
      textReply('{"verdict": "pass", "score": 3}'),
    )
    const result = await apiStructuredCall(
      { model: 'test-model', system: 's', user: 'u', schema },
      llm,
    )
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ verdict: 'pass', score: 3 })
    expect(server.requests[0]!.body.tool_choice).toBeDefined()
    expect(server.requests[1]!.body.response_format?.type).toBe('json_schema')
    expect(server.requests[1]!.body.tools).toBeUndefined()
  })
})
