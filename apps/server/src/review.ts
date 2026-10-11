import { Hono } from 'hono'
import { z } from 'zod'
import { applyEvents, emptyView } from '@mpf/core/reducer'
import { ReviewContext, RevisionProposal, RELEASE_STEPS } from '@mpf/core'
import { ProjectReview, ReviewError, allEvents, type ReviewDeps } from '@mpf/orchestrator'

export function reviewRoutes(deps: ReviewDeps) {
  const api = new Hono()
  const review = new ProjectReview(deps)
  api.use('*', async (c, next) => {
    if (c.req.method !== 'GET') {
      const origin = c.req.header('origin')
      const host = c.req.header('host')
      if (origin && new URL(origin).host !== host)
        return c.json({ error: 'Use the dashboard on this server to make changes.' }, 403)
      if (!c.req.header('content-type')?.includes('application/json'))
        return c.json({ error: 'Send JSON input.' }, 415)
    }
    await next()
  })
  api.onError((err, c) => {
    if (err instanceof z.ZodError)
      return c.json(
        { error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        400,
      )
    if (err instanceof ReviewError)
      return c.json({ error: err.message }, err.status as 400 | 404 | 409)
    return c.json(
      { error: err instanceof Error ? err.message : 'The request could not finish.' },
      500,
    )
  })
  api.get('/runs/:id/review', (c) => c.json(review.state(c.req.param('id'))))
  api.get('/runs/:id/review/context', (c) => {
    const id = c.req.param('id')
    const state = review.state(id)
    const view = applyEvents(emptyView(), allEvents(deps.store, id))
    return c.json({
      ...state,
      checklist: state.run.targets.map((target) => ({
        target,
        steps: RELEASE_STEPS[target].map((step) => ({
          ...step,
          checked: state.entries.some(
            (e) =>
              e.kind === 'checklist' &&
              e.runId === id &&
              e.target === target &&
              e.item === step.id &&
              e.checked,
          ),
        })),
      })),
      stages: deps.store.listStages(id),
      artifacts: deps.store.listArtifacts(id),
      tests: view.tests,
      pending: view.pending,
      verdicts: view.verdicts,
    })
  })
  api.post('/runs/:id/review/answer', async (c) => {
    const { choice } = z
      .object({ choice: z.string(), confirmed: z.literal(true) })
      .parse(await c.req.json())
    const id = c.req.param('id')
    const view = applyEvents(emptyView(), allEvents(deps.store, id))
    const pending = view.pending
    if (
      !pending?.stageId ||
      !pending.choices.some((v) => v.id === choice) ||
      deps.store.getStage(id, pending.stageId)?.status !== 'waiting_human'
    )
      return c.json({ error: 'This decision is no longer waiting. Refresh the project.' }, 409)
    void deps.orchestrator
      .answer(id, pending.stageId, choice)
      .catch((err) =>
        deps.bus.emit(id, undefined, { type: 'log', level: 'error', message: String(err) }),
      )
    return c.json({ ok: true, message: 'Decision recorded.' })
  })
  api.post('/runs/:id/review/designs', async (c) => {
    const data = z
      .object({
        requestId: z.string().min(1),
        text: z.string().min(1),
        context: ReviewContext.optional(),
      })
      .parse(await c.req.json())
    return c.json(
      await review.chat(c.req.param('id'), { ...data, mode: 'design' }, c.req.raw.signal),
    )
  })
  api.post('/runs/:id/review/designs/:did/choose', async (c) => {
    const { optionId } = z.object({ optionId: z.enum(['a', 'b', 'c']) }).parse(await c.req.json())
    return c.json(review.chooseDesign(c.req.param('id'), c.req.param('did'), optionId))
  })
  api.post('/runs/:id/review/chat', async (c) =>
    c.json(await review.chat(c.req.param('id'), await c.req.json(), c.req.raw.signal)),
  )
  api.post('/runs/:id/review/feedback', async (c) =>
    c.json(review.feedback(c.req.param('id'), await c.req.json()), 201),
  )
  api.post('/runs/:id/review/feedback/:fid', async (c) => {
    const { resolved } = z.object({ resolved: z.boolean() }).parse(await c.req.json())
    return c.json(review.resolve(c.req.param('id'), c.req.param('fid'), resolved))
  })
  api.post('/runs/:id/review/proposals', async (c) => {
    const data = z
      .object({ proposal: RevisionProposal, feedbackIds: ReviewContext.shape.feedbackIds })
      .parse(await c.req.json())
    return c.json(review.propose(c.req.param('id'), data.proposal, data.feedbackIds), 201)
  })
  api.post('/runs/:id/review/proposals/:pid/apply', async (c) => {
    const { budgetUsd, confirmed } = z
      .object({ budgetUsd: z.number().positive().max(100), confirmed: z.literal(true) })
      .parse(await c.req.json())
    if (!confirmed)
      return c.json({ error: 'Review the proposal and its budget before applying.' }, 400)
    return c.json(review.apply(c.req.param('id'), c.req.param('pid'), budgetUsd))
  })
  api.post('/runs/:id/review/proposals/:pid/dismiss', (c) =>
    c.json(review.dismiss(c.req.param('id'), c.req.param('pid'))),
  )
  api.post('/runs/:id/review/budget', async (c) => {
    const { budgetUsd } = z
      .object({ budgetUsd: z.number().positive().max(100) })
      .parse(await c.req.json())
    return c.json(review.budget(c.req.param('id'), budgetUsd))
  })
  api.post('/runs/:id/review/direction', async (c) => {
    const { value, notes } = z
      .object({
        value: z.enum(['adapt', 'match', 'explore']),
        notes: z.string().max(6000).default(''),
      })
      .parse(await c.req.json())
    return c.json(review.direction(c.req.param('id'), value, notes))
  })
  api.post('/runs/:id/review/checklist', async (c) => {
    const { target, item, checked } = z
      .object({
        target: z.enum(['web', 'ios', 'android']),
        item: z.string().regex(/^[a-z-]{1,50}$/),
        checked: z.boolean(),
      })
      .parse(await c.req.json())
    return c.json(review.checklist(c.req.param('id'), target, item, checked))
  })
  return api
}
