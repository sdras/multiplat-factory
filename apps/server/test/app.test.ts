import { describe, expect, it } from 'vitest'
import { MpfConfig, RunEventBus, SqliteRunStore } from '@mpf/core'
import { Orchestrator, fakeRegistry } from '@mpf/orchestrator'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'

function makeApp() {
  const store = new SqliteRunStore(':memory:')
  const bus = new RunEventBus(store)
  const config = MpfConfig.parse({})
  const orchestrator = new Orchestrator({
    store,
    bus,
    config,
    registry: fakeRegistry(0.02),
    dataDir: mkdtempSync(join(tmpdir(), 'mpf-app-')),
  })
  const app = createApp({
    orchestrator,
    store,
    bus,
    config,
    doctor: async () => ({
      generatedAt: 'x',
      host: { os: 'test', arch: 'x', node: 'x' },
      checks: [],
      availableTargets: ['web'],
      llmBackend: 'none',
    }),
    realPipeline: false,
    availableStages: [],
    version: 'test',
  })
  return { app, store, orchestrator }
}

describe('server API', () => {
  it('reports health and refuses real runs when no real pipeline exists', async () => {
    const { app } = makeApp()
    const health = await app.request('/api/v1/health')
    expect(health.status).toBe(200)
    expect(((await health.json()) as { realPipeline: boolean }).realPipeline).toBe(false)

    const res = await app.request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { locator: './x' }, targets: ['web'] }),
    })
    expect(res.status).toBe(501)
  })

  it('creates a fake run, streams its events over SSE, and answers the plan checkpoint', async () => {
    const { app, store } = makeApp()
    const created = await app.request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { locator: './x' },
        targets: ['web'],
        options: { fake: true, coreMode: 'never' },
      }),
    })
    expect(created.status).toBe(201)
    const run = (await created.json()) as { id: string }

    // wait until the plan checkpoint is reached
    for (let i = 0; i < 200 && store.getRun(run.id)?.status !== 'waiting_human'; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(store.getRun(run.id)?.status).toBe('waiting_human')

    const detail = (await (await app.request(`/api/v1/runs/${run.id}`)).json()) as {
      stages: { id: string; status: string }[]
    }
    expect(detail.stages.find((s) => s.id === 'plan')?.status).toBe('waiting_human')

    const answered = await app.request(`/api/v1/runs/${run.id}/stages/plan/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'approve' }),
    })
    expect(answered.status).toBe(200)
    for (let i = 0; i < 400 && store.getRun(run.id)?.status !== 'succeeded'; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(store.getRun(run.id)?.status).toBe('succeeded')

    // SSE replay from the start begins with the first run.status event
    const sse = await app.request(`/api/v1/runs/${run.id}/events?after=-1`)
    expect(sse.status).toBe(200)
    expect(sse.headers.get('content-type')).toContain('text/event-stream')
    const text = await readSome(sse, 300)
    expect(text).toContain('event: run.status')
    expect(text).toContain('id: 0')
  })
})

async function readSome(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ])
    if (chunk.done) break
    text += decoder.decode(chunk.value)
    if (text.includes('event: run.status')) break
  }
  await reader.cancel().catch(() => {})
  return text
}
