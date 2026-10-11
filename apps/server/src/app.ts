import { reviewRoutes } from './review.ts'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'pathe'
import { serveStatic } from '@hono/node-server/serve-static'
import {
  CreateRunInput,
  STAGE_CATALOG,
  type MpfConfig,
  type RunEventBus,
  type RunStore,
  type ToolchainReport,
} from '@mpf/core'
import type { Orchestrator } from '@mpf/orchestrator'
import { z } from 'zod'

export interface AppDeps {
  orchestrator: Orchestrator
  store: RunStore
  bus: RunEventBus
  config: MpfConfig
  doctor: () => Promise<ToolchainReport>
  /** Whether non-fake runs can execute in this build. */
  realPipeline: boolean
  /** Stage kinds the real pipeline can run in this build. */
  availableStages: string[]
  /** Directory of the built dashboard (index.html + assets), if available. */
  dashboardDir?: string
  version: string
}

const Answer = z.object({ choice: z.string().min(1), note: z.string().optional() })
const Instruct = z.object({ text: z.string().min(1) })

export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  const api = new Hono()

  let doctorCache: { at: number; report: ToolchainReport } | undefined
  const doctor = async (force = false) => {
    if (!force && doctorCache && Date.now() - doctorCache.at < 60_000) return doctorCache.report
    const report = await deps.doctor()
    doctorCache = { at: Date.now(), report }
    return report
  }

  api.get('/health', (c) =>
    c.json({
      ok: true,
      version: deps.version,
      realPipeline: deps.realPipeline,
      availableStages: deps.availableStages,
      pid: process.pid,
    }),
  )

  api.get('/runs/:id/artifacts/:aid/content', (c) => {
    const run = deps.store.getRun(c.req.param('id'))
    if (!run) return c.json({ error: 'not found' }, 404)
    const artifact = deps.store.listArtifacts(run.id).find((a) => a.id === c.req.param('aid'))
    if (!artifact) return c.json({ error: 'artifact not found' }, 404)
    const abs = join(run.runDir, artifact.relPath)
    if (!existsSync(abs)) return c.json({ error: 'artifact file missing on disk' }, 410)
    return c.body(readFileSync(abs), 200, {
      'content-type': artifact.mime,
      'cache-control': 'private, max-age=60',
    })
  })

  api.get('/doctor', async (c) => c.json(await doctor(c.req.query('refresh') === '1')))

  api.get('/stages/catalog', (c) => c.json(STAGE_CATALOG))

  api.get('/runs', (c) => c.json(deps.store.listRuns(Number(c.req.query('limit') ?? 100))))

  api.post('/runs', async (c) => {
    const parsed = CreateRunInput.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success)
      return c.json({ error: 'invalid run input', issues: parsed.error.issues }, 400)
    const fake = parsed.data.options?.fake ?? false
    if (!fake && !deps.realPipeline) {
      return c.json(
        {
          error:
            'The real pipeline is not available in this build yet. Start a fake run to exercise the dashboard.',
        },
        501,
      )
    }
    const run = deps.orchestrator.createRun(parsed.data)
    void deps.orchestrator.start(run.id).catch((err) => {
      deps.bus.emit(run.id, undefined, {
        type: 'log',
        level: 'error',
        message: `scheduler crashed: ${(err as Error).message}`,
      })
    })
    return c.json(run, 201)
  })

  api.get('/runs/:id', (c) => {
    const run = deps.store.getRun(c.req.param('id'))
    if (!run) return c.json({ error: 'not found' }, 404)
    return c.json({
      run,
      stages: deps.store.listStages(run.id),
      artifacts: deps.store.listArtifacts(run.id),
    })
  })

  api.get('/runs/:id/events', (c) => {
    const id = c.req.param('id')
    if (!deps.store.getRun(id)) return c.json({ error: 'not found' }, 404)
    const lastEventId = c.req.header('Last-Event-ID')
    const after = Number(c.req.query('after') ?? lastEventId ?? -1)
    return streamSSE(c, async (stream) => {
      let lastSeq = Number.isFinite(after) ? after : -1
      const send = async (e: { seq: number; type: string }) => {
        if (e.seq <= lastSeq) return
        lastSeq = e.seq
        await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) })
      }
      // A long run has more events than one page; replay all of them before streaming live ones.
      for (const e of deps.store.listAllEvents(id, lastSeq)) await send(e)
      const queue: Promise<void>[] = []
      const unsubscribe = deps.bus.subscribe(id, (e) => {
        queue.push(send(e))
      })
      const ping = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: String(Date.now()) })
      }, 15_000)
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve())
      })
      clearInterval(ping)
      unsubscribe()
      await Promise.allSettled(queue)
    })
  })

  const control = (action: 'pause' | 'resume' | 'cancel') =>
    api.post(`/runs/:id/${action}`, async (c) => {
      const id = c.req.param('id')
      if (!deps.store.getRun(id)) return c.json({ error: 'not found' }, 404)
      try {
        if (action === 'pause') deps.orchestrator.pause(id)
        else if (action === 'cancel') deps.orchestrator.cancel(id)
        else void deps.orchestrator.resume(id)
        return c.json({ ok: true, run: deps.store.getRun(id) })
      } catch (err) {
        return c.json({ error: (err as Error).message }, 409)
      }
    })
  control('pause')
  control('resume')
  control('cancel')

  api.post('/runs/:id/stages/:sid/answer', async (c) => {
    const parsed = Answer.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'choice required' }, 400)
    try {
      void deps.orchestrator.answer(
        c.req.param('id'),
        c.req.param('sid'),
        parsed.data.choice,
        parsed.data.note,
      )
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409)
    }
  })

  api.post('/runs/:id/stages/:sid/instruct', async (c) => {
    const parsed = Instruct.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'text required' }, 400)
    deps.orchestrator.instruct(c.req.param('id'), c.req.param('sid'), parsed.data.text)
    return c.json({ ok: true })
  })

  api.post('/runs/:id/stages/:sid/rerun', (c) => {
    try {
      void deps.orchestrator.rerun(c.req.param('id'), c.req.param('sid'))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409)
    }
  })

  api.route('/', reviewRoutes(deps))
  app.route('/api/v1', api)

  if (deps.dashboardDir && existsSync(join(deps.dashboardDir, 'index.html'))) {
    const dir = deps.dashboardDir
    app.use('/*', serveStatic({ root: dir }))
    // Read per request so a rebuilt dashboard shows up without restarting the daemon.
    app.get('*', (c) => c.html(readFileSync(join(dir, 'index.html'), 'utf8')))
  } else {
    app.get('/', (c) =>
      c.text(
        'multiplat-factory server is running. The dashboard is not built in this location; run `pnpm dev` for the live dashboard on :4311 or build it with `pnpm --filter @mpf/dashboard build`.',
      ),
    )
  }

  return app
}
