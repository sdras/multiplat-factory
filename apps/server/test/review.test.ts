import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DesignReply,
  MpfConfig,
  RunEventBus,
  SqliteRunStore,
  newId,
  type Artifact,
} from '@mpf/core'
import { Orchestrator, ProjectReview, fakeRegistry, type ReviewDeps } from '@mpf/orchestrator'
import { Hono } from 'hono'
import { reviewRoutes } from '../src/review.ts'
import { createReviewTools } from '../../dashboard/app/utils/reviewTools.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((fn) => fn()))
function fixture(agent?: ReviewDeps['agent']) {
  const dir = mkdtempSync(join(tmpdir(), 'mpf-review-test-'))
  const store = new SqliteRunStore(join(dir, 'store.sqlite'))
  const bus = new RunEventBus(store)
  const orchestrator = new Orchestrator({
    store,
    bus,
    config: MpfConfig.parse({}),
    registry: fakeRegistry(0.001),
    dataDir: dir,
  })
  const run = orchestrator.createRun({
    source: { locator: './review-example' },
    targets: ['web'],
    options: { fake: true, coreMode: 'never' },
  })
  const deps = { store, bus, orchestrator, agent }
  const review = new ProjectReview(deps)
  mkdirSync(join(run.runDir, 'source'), { recursive: true })
  writeFileSync(join(run.runDir, 'source', 'app.txt'), 'original source')
  writeFileSync(
    join(run.runDir, 'screen.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  const shot: Artifact = {
    id: newId(),
    runId: run.id,
    stageId: 'observe',
    kind: 'source-screenshot',
    mime: 'image/png',
    relPath: 'screen.png',
    createdAt: run.createdAt,
    meta: { screenId: 'home' },
  }
  store.addArtifact(shot)
  cleanup.push(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const app = new Hono().route('/api/v1', reviewRoutes(deps))
  const post = (path: string, body: unknown) =>
    app.request(`/api/v1/runs/${run.id}/review/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { dir, store, bus, orchestrator, run, review, shot, app, post, deps }
}
describe('project review', () => {
  it('freezes annotation evidence, validates geometry, deduplicates notes and persists across service instances', async () => {
    const f = fixture()
    const input = {
      requestId: 'note-1',
      artifactId: f.shot.id,
      text: 'Move this to the sidebar',
      marks: [
        {
          kind: 'arrow',
          points: [
            { x: 0.2, y: 0.3 },
            { x: 0.8, y: 0.3 },
          ],
        },
      ],
    }
    const saved = await f.post('feedback', input)
    expect(saved.status).toBe(201)
    const entry = (await saved.json()) as { id: string; snapshotId: string }
    expect((await (await f.post('feedback', input)).json()).id).toBe(entry.id)
    writeFileSync(join(f.run.runDir, 'screen.png'), 'changed')
    const snapshot = f.store.listArtifacts(f.run.id).find((a) => a.id === entry.snapshotId)!
    expect(readFileSync(join(f.run.runDir, snapshot.relPath)).subarray(0, 4).toString('hex')).toBe(
      '89504e47',
    )
    expect(
      new ProjectReview(f.deps).entries(f.run.id).filter((e) => e.kind === 'feedback'),
    ).toHaveLength(1)
    expect(
      (
        await f.post('feedback', {
          ...input,
          requestId: 'bad',
          marks: [{ kind: 'arrow', points: [{ x: 2, y: 0 }] }],
        })
      ).status,
    ).toBe(400)
    expect((await f.post(`feedback/${entry.id}`, { resolved: true })).status).toBe(200)
    expect(f.review.entries(f.run.id).find((e) => e.id === entry.id)).toMatchObject({
      status: 'resolved',
    })
  })
  it('keeps conversations scoped to the project, shares them with later versions and counts model costs', async () => {
    const agent = vi.fn(async () => ({
      ok: true,
      text: '',
      structured: { text: 'Here is what the plan means.', proposal: null },
      costUsd: 0.12,
      numTurns: 1,
      denials: 0,
    }))
    const f = fixture(agent)
    const body = { requestId: 'chat-1', text: 'Explain this plan', context: { page: 'plan' } }
    expect((await f.post('chat', body)).status).toBe(200)
    expect(f.store.getRun(f.run.id)?.costUsd).toBe(0.12)
    await f.post('chat', body)
    expect(agent).toHaveBeenCalledTimes(1)
    const next = f.orchestrator.createRun({
      source: f.run.source,
      targets: ['ios'],
      options: { fake: true },
    })
    expect(f.review.entries(next.id).filter((e) => e.kind === 'message')).toHaveLength(2)
    const other = f.orchestrator.createRun({
      source: { locator: './other-project' },
      targets: ['web'],
      options: { fake: true },
    })
    expect(f.review.entries(other.id)).toHaveLength(0)
    expect(agent.mock.calls[0]).toBeDefined()
  })
  it('refuses chat without remaining budget and concurrent replies', async () => {
    let done!: () => void
    const agent = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<NonNullable<ReviewDeps['agent']>>>>((resolve) => {
          done = () =>
            resolve({
              ok: true,
              text: '',
              structured: { text: 'Done', proposal: null },
              costUsd: 0.05,
              numTurns: 1,
              denials: 0,
            })
        }),
    )
    const f = fixture(agent)
    f.store.updateRun({
      ...f.run,
      options: { ...f.run.options, fake: false, budgetUsd: 1 },
      costUsd: 0.95,
    })
    expect((await f.post('chat', { requestId: 'low', text: 'Hello' })).status).toBe(409)
    expect(agent).not.toHaveBeenCalled()
    f.store.updateRun({ ...f.run, options: { ...f.run.options, fake: false, budgetUsd: 2 } })
    const pending = f.review.chat(f.run.id, { requestId: 'first', text: 'Hello' })
    expect(f.store.getRun(f.run.id)?.costUsd).toBe(1)
    await expect(f.review.chat(f.run.id, { requestId: 'second', text: 'Hello' })).rejects.toThrow(
      'already in progress',
    )
    done()
    await pending
    expect(f.store.getRun(f.run.id)?.costUsd).toBe(0.05)
  })
  it('creates an isolated, budgeted revision, reuses analysis, preserves the original and applies once', async () => {
    const f = fixture()
    await f.orchestrator.start(f.run.id)
    expect(f.store.getRun(f.run.id)?.status).toBe('waiting_human')
    const proposal = f.review.propose(f.run.id, {
      title: 'Wider layout',
      instructions: 'Use a sidebar',
      kind: 'plan',
      targets: ['web'],
    })
    const oldStages = f.store.listStages(f.run.id)
    const applied = f.review.apply(f.run.id, proposal.id, 8)
    await f.orchestrator.start(applied.runId!)
    expect(f.store.getRun(applied.runId!)?.options.budgetUsd).toBe(8)
    expect(f.store.getRun(applied.runId!)?.options.parentRunId).toBe(f.run.id)
    expect(f.store.getStage(applied.runId!, 'plan')?.status).toBe('waiting_human')
    expect(f.store.listStages(f.run.id)).toEqual(oldStages)
    expect(
      readFileSync(join(f.store.getRun(applied.runId!)!.runDir, 'source', 'app.txt'), 'utf8'),
    ).toBe('original source')
    expect(f.review.apply(f.run.id, proposal.id, 8)).toEqual({
      runId: applied.runId,
      alreadyApplied: true,
    })
  })
  it('validates decisions, origin, and checklist target and leaves no side effect on invalid input', async () => {
    const f = fixture()
    expect((await f.post('answer', { choice: 'invented', confirmed: true })).status).toBe(409)
    expect(
      (await f.post('checklist', { target: 'ios', item: 'review', checked: true })).status,
    ).toBe(400)
    const res = await f.app.request(`/api/v1/runs/${f.run.id}/review/direction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://other.example' },
      body: JSON.stringify({ value: 'adapt' }),
    })
    expect(res.status).toBe(403)
    await f.post('checklist', { target: 'web', item: 'review', checked: true })
    expect(new ProjectReview(f.deps).entries(f.run.id)).toContainEqual(
      expect.objectContaining({ kind: 'checklist', checked: true }),
    )
  })
})
describe('review budget and capability boundaries', () => {
  it('updates the budget without starting work and rejects invalid checklist items', async () => {
    const f = fixture()
    const before = f.store.getRun(f.run.id)?.status
    expect((await f.post('budget', { budgetUsd: 40 })).status).toBe(200)
    expect(f.store.getRun(f.run.id)?.options.budgetUsd).toBe(40)
    expect(f.store.getRun(f.run.id)?.status).toBe(before)
    expect((await f.post('budget', { budgetUsd: 101 })).status).toBe(400)
    expect(
      (await f.post('checklist', { target: 'web', item: 'invented', checked: true })).status,
    ).toBe(400)
  })
  it('charges reported failed-call cost and does not create a proposal', async () => {
    const f = fixture(async () => ({
      ok: false,
      text: '',
      costUsd: 0.08,
      numTurns: 1,
      denials: 0,
      error: 'Model unavailable',
    }))
    expect((await f.post('chat', { requestId: 'failure', text: 'Explain this' })).status).toBe(409)
    expect(f.store.getRun(f.run.id)?.costUsd).toBe(0.08)
    expect(f.review.entries(f.run.id).filter((e) => e.kind === 'proposal')).toHaveLength(0)
  })
  it('keeps a running parent untouched when applying a proposal', () => {
    const f = fixture()
    const proposal = f.review.propose(f.run.id, {
      title: 'Change layout',
      instructions: 'Use a sidebar',
      kind: 'revision',
      targets: ['web'],
    })
    f.store.updateRun({ ...f.run, status: 'running' })
    expect(() => f.review.apply(f.run.id, proposal.id, 10)).toThrow('Wait for this build')
    expect(f.store.listRuns()).toHaveLength(1)
  })
})
describe('WebMCP tools', () => {
  it('validates inputs, honors cancellation, and updates the UI after a successful action', async () => {
    const call = vi.fn(async () => ({ id: 'note', snapshotId: 'snapshot' }))
    const reveal = vi.fn(async () => {})
    const tools = createReviewTools({ currentRun: () => 'run-1', call, reveal, activity: vi.fn() })
    const add = tools.find((t) => t.name === 'add_preview_feedback')!
    const signal = new AbortController().signal
    expect(
      await add.execute(
        {
          artifactId: 'a',
          text: 'Move it',
          requestId: 'n',
          marks: [{ kind: 'pin', points: [{ x: 4, y: 0 }] }],
        },
        { signal },
      ),
    ).toHaveProperty('error')
    expect(call).not.toHaveBeenCalled()
    await add.execute({ artifactId: 'a', text: 'Move it', requestId: 'n' }, { signal })
    expect(call).toHaveBeenCalledWith(
      '/runs/run-1/review/feedback',
      signal,
      expect.objectContaining({ artifactId: 'a' }),
    )
    expect(reveal).toHaveBeenCalledWith('run-1', 'add_preview_feedback')
    const ac = new AbortController()
    ac.abort()
    await expect(
      add.execute({ artifactId: 'a', text: 'Move it', requestId: 'n' }, { signal: ac.signal }),
    ).rejects.toThrow()
    for (const t of tools) {
      expect(t.name.length).toBeLessThanOrEqual(30)
      expect(t.description.length).toBeLessThanOrEqual(500)
      expect(t.annotations).toHaveProperty('readOnlyHint')
    }
  })
  it('returns bounded, continuable read results and requires explicit application confirmation', async () => {
    const call = vi.fn(async () =>
      Array.from({ length: 50 }, (_, i) => ({
        id: String(i),
        source: { locator: './example' },
        status: 'succeeded',
        targets: ['web'],
      })),
    )
    const tools = createReviewTools({
      currentRun: () => 'run',
      call,
      reveal: vi.fn(),
      activity: vi.fn(),
    })
    const signal = new AbortController().signal
    const list = tools.find((t) => t.name === 'list_projects')!
    const result = await list.execute({}, { signal })
    expect(JSON.stringify(result).length).toBeLessThan(1500)
    expect(result).toHaveProperty('nextOffset', 1050)
    const apply = tools.find((t) => t.name === 'apply_revision')!
    expect(
      await apply.execute({ proposalId: 'p', budgetUsd: 10, confirmed: false }, { signal }),
    ).toHaveProperty('error')
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('three-option design review', () => {
  it('always begins with three distinct mockups, persists them and waits for selection', async () => {
    const f = fixture()
    const before = f.store.listRuns().length
    const body = {
      requestId: 'design-one',
      text: 'Make this app work well on desktop',
      context: { target: 'web' },
    }
    expect((await f.post('designs', body)).status).toBe(200)
    const entries = new ProjectReview(f.deps).entries(f.run.id)
    const design = entries.find((e) => e.kind === 'design')!
    expect(design.kind).toBe('design')
    if (design.kind !== 'design') throw new Error('Expected mockups')
    expect(design.options).toHaveLength(3)
    expect(new Set(design.options.map((o) => o.mockup.layout)).size).toBe(3)
    expect(entries.some((e) => e.kind === 'proposal')).toBe(false)
    expect(f.store.listRuns()).toHaveLength(before)
    await f.post('designs', body)
    expect(f.review.entries(f.run.id).filter((e) => e.kind === 'design')).toHaveLength(1)
    const selected = await f.post(`designs/${design.id}/choose`, { optionId: 'b' })
    expect(selected.status).toBe(200)
    const result = await selected.json()
    const proposal = f.review.entries(f.run.id).find((e) => e.id === result.proposalId)
    expect(proposal).toMatchObject({
      kind: 'proposal',
      status: 'proposed',
      proposal: { targets: ['web'], title: design.options[1]!.name },
    })
    if (proposal?.kind !== 'proposal') throw new Error('Expected proposal')
    expect(proposal.proposal.instructions).toContain('topbar')
    expect(proposal.proposal.instructions).not.toContain('sidebar')
    expect(f.store.listRuns()).toHaveLength(before)
    expect(await (await f.post(`designs/${design.id}/choose`, { optionId: 'b' })).json()).toEqual(
      result,
    )
    expect((await f.post(`designs/${design.id}/choose`, { optionId: 'c' })).status).toBe(409)
    expect(f.review.entries(f.run.id).filter((e) => e.kind === 'proposal')).toHaveLength(1)
  })
  it('rejects incomplete or duplicate choices and unsafe mockup styles', async () => {
    const f = fixture()
    const state = await f.review.chat(f.run.id, { requestId: 'd', text: 'Explore', mode: 'design' })
    const entry = state.entries.find((e) => e.kind === 'design')!
    if (entry.kind !== 'design') throw new Error('Expected mockups')
    expect(
      DesignReply.safeParse({ text: 'Options', options: entry.options.slice(0, 2) }).success,
    ).toBe(false)
    expect(
      DesignReply.safeParse({
        text: 'Options',
        options: [entry.options[0], entry.options[0], entry.options[2]],
      }).success,
    ).toBe(false)
    const bad = structuredClone(entry.options)
    bad[0]!.mockup.palette.background = 'url(https://example.com/tracker)'
    expect(DesignReply.safeParse({ text: 'Options', options: bad }).success).toBe(false)
    expect(
      (
        await f.post('designs', {
          requestId: 'wrong-target',
          text: 'Explore',
          context: { target: 'ios' },
        })
      ).status,
    ).toBe(400)
    expect((await f.post(`designs/${entry.id}/choose`, { optionId: 'd' })).status).toBe(400)
    const other = f.orchestrator.createRun({
      source: { locator: './another-project' },
      targets: ['web'],
    })
    expect(() => f.review.chooseDesign(other.id, entry.id, 'a')).toThrow('not found')
  })
  it('includes source screenshots and asks the model for three options under the existing budget', async () => {
    const demo = fixture()
    const state = await demo.review.chat(demo.run.id, {
      requestId: 'd',
      text: 'Explore',
      mode: 'design',
    })
    const entry = state.entries.find((e) => e.kind === 'design')!
    if (entry.kind !== 'design') throw new Error('Expected mockups')
    const agent = vi.fn(async () => ({
      ok: true,
      text: '',
      structured: { text: 'Three options', options: entry.options },
      costUsd: 0.2,
      numTurns: 1,
      denials: 0,
    }))
    const f = fixture(agent)
    expect(
      (await f.post('designs', { requestId: 'real-shape', text: 'Use the app context' })).status,
    ).toBe(200)
    const call = (
      agent.mock.calls as unknown as [
        NonNullable<Parameters<NonNullable<ReviewDeps['agent']>>[0]>,
      ][]
    )[0]![0]
    expect(call.systemPrompt).toContain('exactly three')
    expect(JSON.parse(call.prompt).screenshots[0].imagePath).toContain('screen.png')
    expect(call.maxBudgetUsd).toBeLessThanOrEqual(1)
    expect(f.store.getRun(f.run.id)?.costUsd).toBe(0.2)
    expect(f.review.entries(f.run.id).some((e) => e.kind === 'proposal')).toBe(false)
  })
  it('requires an explicit user choice through WebMCP and bounds its receipt', async () => {
    const call = vi.fn(async () => ({ designId: 'd', proposalId: 'p', runId: 'run' }))
    const tools = createReviewTools({
      currentRun: () => 'run',
      call,
      reveal: vi.fn(),
      activity: vi.fn(),
    })
    const choose = tools.find((t) => t.name === 'choose_design_direction')!
    const signal = new AbortController().signal
    expect(
      await choose.execute({ designId: 'd', optionId: 'b', confirmed: false }, { signal }),
    ).toHaveProperty('error')
    expect(call).not.toHaveBeenCalled()
    const receipt = await choose.execute(
      { designId: 'd', optionId: 'b', confirmed: true },
      { signal },
    )
    expect(call).toHaveBeenCalledWith('/runs/run/review/designs/d/choose', signal, {
      optionId: 'b',
    })
    expect(JSON.stringify(receipt).length).toBeLessThan(1500)
  })
})
