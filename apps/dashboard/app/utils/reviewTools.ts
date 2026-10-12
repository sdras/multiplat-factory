/// <reference types="webmcp-types" />
import { FeedbackInput, RevisionProposal } from '@mpf/core/schemas'
type Schema = {
  type: string
  description?: string
  enum?: string[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
}
const str = (description: string): Schema => ({ type: 'string', description })
const bool = (description: string): Schema => ({ type: 'boolean', description })
const choice = (values: string[], description: string): Schema => ({
  ...str(description),
  enum: values,
})
const num = (description: string): Schema => ({ type: 'number', description })
const run = str('Version ID from list_projects, or omit to use the open project.')
const point: Schema = {
  type: 'object',
  description: 'Position within the captured image.',
  properties: {
    x: num('Horizontal position from 0 (left) to 1 (right).'),
    y: num('Vertical position from 0 (top) to 1 (bottom).'),
  },
  required: ['x', 'y'],
}
const marks: Schema = {
  type: 'array',
  description: 'Drawn marks in normalized screenshot coordinates.',
  items: {
    type: 'object',
    properties: {
      kind: choice(['pin', 'arrow', 'rectangle', 'pen'], 'Shape to draw.'),
      points: {
        type: 'array',
        description: 'One point for a pin, start/end for arrow or rectangle, path for pen.',
        items: point,
      },
    },
    required: ['kind', 'points'],
  },
}
export interface ReviewToolDeps {
  currentRun: () => string
  call: (path: string, signal: AbortSignal, body?: unknown) => Promise<unknown>
  reveal: (runId: string, tool: string) => Promise<void>
  activity: (text: string) => void
}
export function createReviewTools(deps: ReviewToolDeps): WebMCP.ModelContextTool[] {
  const tools: WebMCP.ModelContextTool[] = []
  const id = (input: Record<string, unknown>) => {
    const value = String(input.runId ?? deps.currentRun())
    if (!value || !/^[a-zA-Z0-9_-]+$/.test(value))
      throw new Error('Open a project or provide a version ID from list_projects.')
    return value
  }
  const page = (value: unknown, offset: unknown) => {
    const text = JSON.stringify(value)
    const start = offset === undefined ? 0 : Number(offset)
    if (!Number.isInteger(start) || start < 0 || start > text.length)
      throw new Error('Use a nonnegative offset no larger than totalCharacters.')
    let size = 1050
    while (JSON.stringify(text.slice(start, start + size)).length > 1300) size -= 100
    return {
      text: text.slice(start, start + size),
      nextOffset: start + size < text.length ? start + size : null,
      totalCharacters: text.length,
    }
  }
  function tool(
    name: string,
    description: string,
    props: Record<string, Schema>,
    required: string[],
    readOnly: boolean,
    consequential: boolean,
    fn: (i: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
  ) {
    const schema: Schema = { type: 'object', properties: props, required }
    tools.push({
      name,
      description,
      inputSchema: schema,
      annotations: {
        readOnlyHint: readOnly,
        consequentialHint: consequential,
        untrustedContentHint: true,
      },
      async execute(input, options) {
        const signal = options?.signal ?? new AbortController().signal
        try {
          signal.throwIfAborted()
          validate(schema, input, 'input')
          const result = await fn(input, signal)
          signal.throwIfAborted()
          if (!readOnly) {
            const resultRun =
              result && typeof result === 'object' && 'runId' in result
                ? String(result.runId)
                : id(input)
            await deps.reveal(resultRun, name)
            deps.activity(name.replaceAll('_', ' '))
          }
          return result
        } catch (e) {
          if (signal.aborted) throw e
          return {
            error: (e instanceof Error
              ? e.message
              : 'The action could not finish. Refresh the project before retrying.'
            ).slice(0, 1000),
            retryable: false,
          }
        }
      },
    })
  }
  tool(
    'list_projects',
    'List project versions, platforms and status. Results are paged text; use nextOffset to continue.',
    { offset: num('Character offset returned as nextOffset; defaults to zero.') },
    [],
    true,
    false,
    async (i, s) => {
      const runs = (await deps.call('/runs', s)) as {
        id: string
        source: { locator: string }
        status: string
        targets: string[]
      }[]
      return page(
        runs.map((r) => ({
          runId: r.id,
          project: r.source.locator,
          status: r.status,
          platforms: r.targets,
        })),
        i.offset,
      )
    },
  )
  tool(
    'read_project',
    'Read plans, status, tests, previews, feedback, proposals, conversation, checklist or designs. Returns paged text with IDs for follow-up actions.',
    {
      runId: run,
      section: choice(
        [
          'status',
          'plan',
          'tests',
          'previews',
          'feedback',
          'proposals',
          'conversation',
          'checklist',
          'designs',
        ],
        'Information to read.',
      ),
      offset: num('Character offset returned as nextOffset.'),
    },
    ['section'],
    true,
    false,
    async (i, s) => {
      const runId = id(i)
      const data = (await deps.call(`/runs/${runId}/review/context`, s)) as {
        run: unknown
        stages: unknown
        pending: unknown
        tests: unknown
        checklist: unknown
        entries: { kind: string }[]
        artifacts: { id: string; kind: string; meta: unknown }[]
      }
      let value: unknown
      if (i.section === 'status')
        value = { run: data.run, stages: data.stages, pending: data.pending }
      else if (i.section === 'tests') value = data.tests
      else if (i.section === 'checklist') value = data.checklist
      else if (i.section === 'previews')
        value = data.artifacts
          .filter((a) => ['source-screenshot', 'target-screenshot'].includes(a.kind))
          .map((a) => ({ ...a, url: `/api/v1/runs/${runId}/artifacts/${a.id}/content` }))
      else if (i.section === 'plan') {
        const a = data.artifacts.findLast((a) => a.kind === 'portplan')
        value = a
          ? await deps.call(`/runs/${runId}/artifacts/${a.id}/content`, s)
          : { message: 'The plan is not available yet.' }
      } else
        value = data.entries.filter(
          (e) =>
            e.kind ===
            ((
              { proposals: 'proposal', conversation: 'message', designs: 'design' } as Record<
                string,
                string
              >
            )[String(i.section)] ?? i.section),
        )
      return page(value, i.offset)
    },
  )
  tool(
    'start_design_review',
    'Create exactly three conceptual mockups from the project plan and screenshots. Uses model budget; requires user approval. No build starts. Read designs to compare the saved options.',
    {
      runId: run,
      text: str('Design brief: what to preserve and what to explore.'),
      target: choice(['web', 'ios', 'android'], 'Platform to design for.'),
      requestId: str('Stable unique request ID; reuse on retries.'),
      impeccable: bool(
        'Ask the user whether to add the Impeccable skill; true only for an explicit yes, false for no.',
      ),
      confirmed: bool('True when the user approved generating mockups using the project budget.'),
    },
    ['text', 'target', 'requestId', 'confirmed', 'impeccable'],
    false,
    true,
    async (i, s) => {
      if (i.confirmed !== true)
        throw new Error('Ask the user before spending budget on design options.')
      const result = (await deps.call(`/runs/${id(i)}/review/designs`, s, {
        text: i.text,
        impeccable: i.impeccable,
        requestId: i.requestId,
        context: { page: 'tests', target: i.target },
      })) as { entries: { id: string; kind: string; requestId?: string }[] }
      return {
        designId: result.entries.findLast((e) => e.kind === 'design' && e.requestId === i.requestId)
          ?.id,
        message: 'Three mockups are ready. Read designs and let the user choose.',
      }
    },
  )
  tool(
    'choose_design_direction',
    'Save the user’s choice of A, B, or C and prepare a revision proposal. Does not start a build; applying the proposal is separate.',
    {
      runId: run,
      designId: str('Review ID from read_project with section designs.'),
      optionId: choice(['a', 'b', 'c'], 'The option the user selected.'),
      confirmed: bool('True when the user selected this direction.'),
    },
    ['designId', 'optionId', 'confirmed'],
    false,
    false,
    async (i, s) => {
      if (i.confirmed !== true)
        throw new Error('Let the user choose among the three mockups first.')
      return deps.call(
        `/runs/${id(i)}/review/designs/${encodeURIComponent(String(i.designId))}/choose`,
        s,
        { optionId: i.optionId },
      )
    },
  )
  tool(
    'add_preview_feedback',
    'Save feedback on a captured screen, optionally with pins, arrows, rectangles or pen marks. It appears in project chat for review.',
    {
      runId: run,
      artifactId: str('Screenshot ID from read_project with section previews.'),
      text: str('Requested change in the user’s words.'),
      marks,
      requestId: str('Stable unique ID for this note; reuse on retries.'),
    },
    ['artifactId', 'text', 'requestId'],
    false,
    false,
    async (i, s) => {
      const data = FeedbackInput.parse({ ...i, marks: i.marks ?? [] })
      const result = (await deps.call(`/runs/${id(i)}/review/feedback`, s, data)) as {
        id: string
        snapshotId: string
      }
      return {
        feedbackId: result.id,
        snapshotId: result.snapshotId,
        message: 'Feedback saved. Review it in project chat.',
      }
    },
  )
  tool(
    'propose_revision',
    'Save a concrete plan or app revision for review. The user can edit its budget and apply it in project chat.',
    {
      runId: run,
      title: str('Short description of the proposed change.'),
      instructions: str('Concrete changes and behavior to preserve.'),
      kind: choice(['plan', 'revision'], 'Revise the plan, or rebuild selected app platforms.'),
      targets: {
        type: 'array',
        description: 'Platforms in this version that should change.',
        items: choice(['web', 'ios', 'android'], 'Platform.'),
      },
      feedbackIds: {
        type: 'array',
        description: 'Feedback IDs the proposal addresses.',
        items: str('Feedback ID.'),
      },
    },
    ['title', 'instructions', 'kind', 'targets'],
    false,
    false,
    async (i, s) => {
      const result = (await deps.call(`/runs/${id(i)}/review/proposals`, s, {
        proposal: RevisionProposal.parse(i),
        feedbackIds: i.feedbackIds ?? [],
      })) as { id: string }
      return {
        proposalId: result.id,
        message:
          'Proposal saved for review. Applying it creates a new version and incurs build costs.',
      }
    },
  )
  tool(
    'apply_revision',
    'Apply a reviewed proposal with the user’s approved budget. Creates a new version and starts work; returns the new version ID.',
    {
      runId: run,
      proposalId: str('Proposal ID from read_project or propose_revision.'),
      budgetUsd: num('User-approved budget, greater than 0 and at most 100 USD.'),
      confirmed: bool('True when the user approved this proposal and budget.'),
    },
    ['proposalId', 'budgetUsd', 'confirmed'],
    false,
    true,
    async (i, s) => {
      if (i.confirmed !== true)
        throw new Error(
          'Review the proposal and ask the user to approve its budget before applying.',
        )
      return deps.call(
        `/runs/${id(i)}/review/proposals/${encodeURIComponent(String(i.proposalId))}/apply`,
        s,
        { budgetUsd: i.budgetUsd, confirmed: true },
      )
    },
  )
  tool(
    'answer_build_decision',
    'Record the user’s choice for the currently waiting build decision. Read available choices in project status first.',
    {
      runId: run,
      choice: str('Choice ID from the pending decision in read_project.'),
      confirmed: bool('True when the user has chosen this action.'),
    },
    ['choice', 'confirmed'],
    false,
    true,
    async (i, s) =>
      deps.call(`/runs/${id(i)}/review/answer`, s, { choice: i.choice, confirmed: i.confirmed }),
  )
  tool(
    'resolve_feedback',
    'Mark reviewed feedback resolved, or reopen it. Use after comparing the revised preview with the original note.',
    {
      runId: run,
      feedbackId: str('Feedback ID from read_project.'),
      resolved: bool('True to resolve; false to reopen.'),
    },
    ['feedbackId', 'resolved'],
    false,
    false,
    async (i, s) => {
      await deps.call(
        `/runs/${id(i)}/review/feedback/${encodeURIComponent(String(i.feedbackId))}`,
        s,
        { resolved: i.resolved },
      )
      return { message: i.resolved ? 'Feedback resolved.' : 'Feedback reopened.' }
    },
  )
  tool(
    'set_visual_direction',
    'Save the project’s visual direction for future revisions.',
    {
      runId: run,
      value: choice(
        ['adapt', 'match', 'explore'],
        'Adapt to the platform, match the original, or explore a new design.',
      ),
      notes: str('User’s visual preferences and guidance.'),
    },
    ['value'],
    false,
    false,
    async (i, s) => {
      await deps.call(`/runs/${id(i)}/review/direction`, s, {
        value: i.value,
        notes: i.notes ?? '',
      })
      return { message: 'Visual direction saved.' }
    },
  )
  tool(
    'update_release_checklist',
    'Record completion of a manual release step. This updates the checklist; publishing remains a separate action.',
    {
      runId: run,
      target: choice(['web', 'ios', 'android'], 'Release platform.'),
      item: str('Checklist item ID from the release page or read_project.'),
      checked: bool('Whether the user completed the step.'),
    },
    ['target', 'item', 'checked'],
    false,
    false,
    async (i, s) => {
      await deps.call(`/runs/${id(i)}/review/checklist`, s, {
        target: i.target,
        item: i.item,
        checked: i.checked,
      })
      return { message: 'Release checklist updated.' }
    },
  )
  return tools
}
function validate(schema: Schema, value: unknown, path: string): void {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${path} must be an object.`)
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? [])
      if (record[key] === undefined) throw new Error(`Provide ${key}.`)
    for (const [key, item] of Object.entries(record)) {
      const prop = schema.properties?.[key]
      if (!prop) throw new Error(`Unknown parameter ${key}.`)
      validate(prop, item, key)
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 1000)
      throw new Error(`${path} must be a list with at most 1000 items.`)
    value.forEach((item) => validate(schema.items!, item, path))
  } else {
    if (typeof value !== schema.type || (typeof value === 'number' && !Number.isFinite(value)))
      throw new Error(`${path} must be a ${schema.type}.`)
    if (typeof value === 'string' && value.length > 20000) throw new Error(`${path} is too long.`)
    if (schema.enum && !schema.enum.includes(String(value)))
      throw new Error(`Choose ${schema.enum.join(', ')} for ${path}.`)
  }
}
