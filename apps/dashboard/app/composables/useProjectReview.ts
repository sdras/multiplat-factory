import type { ReviewContext, ReviewEntry, Run } from '@mpf/core/schemas'
export interface ProjectReviewState {
  entries: ReviewEntry[]
  run: Run
  chatCapUsd: number
  busy: boolean
  versions: { id: string; createdAt: string; status: string; targets: string[] }[]
  pending?: { stageId?: string; reason: string; choices: { id: string; label: string }[] }
}
export function useProjectReview() {
  const open = useState('review-open', () => false)
  const designOpen = useState('review-design-open', () => false)
  const designId = useState('review-design-id', () => '')
  const runId = useState('review-run-id', () => '')
  const state = useState<ProjectReviewState | undefined>('review-state')
  const error = useState('review-error', () => '')
  const contexts = useState<Record<string, ReviewContext>>('review-contexts', () => ({}))
  const drafts = useState<Record<string, string>>('review-drafts', () => ({}))
  const pending = useState<Record<string, boolean>>('review-pending', () => ({}))
  const context = computed({
    get: () => contexts.value[runId.value] ?? { page: 'project' as const, feedbackIds: [] },
    set: (value: ReviewContext) => {
      contexts.value[runId.value] = value
    },
  })
  const draft = computed({
    get: () => drafts.value[runId.value] ?? '',
    set: (value: string) => {
      drafts.value[runId.value] = value
    },
  })
  const sending = computed(() => pending.value[runId.value] ?? false)
  const api = useApi()
  async function refresh() {
    const id = runId.value
    if (!id) return
    try {
      const next = await api.get<ProjectReviewState>(`/runs/${id}/review/context`)
      if (!next?.run || !Array.isArray(next.entries))
        throw new Error(
          'Chat and feedback need the updated server. Restart it after the active ports finish.',
        )
      if (id === runId.value) {
        state.value = next
        error.value = ''
      }
    } catch (e) {
      if (id === runId.value) error.value = (e as Error).message
    }
  }
  function discuss(page: ReviewContext['page'], text = '', feedbackIds: string[] = []) {
    context.value = { page, feedbackIds }
    if (text) draft.value = text
    open.value = true
  }
  function showDesign(id = '') {
    designId.value = id
    designOpen.value = true
  }
  async function generateDesign(
    text: string,
    target: 'web' | 'ios' | 'android',
    requestId: string,
    impeccable: boolean,
  ) {
    const id = runId.value
    if (pending.value[id]) return
    pending.value[id] = true
    error.value = ''
    try {
      const result = await api.post<ProjectReviewState>(`/runs/${id}/review/designs`, {
        requestId,
        impeccable,
        text,
        context: { ...context.value, target },
      })
      if (runId.value === id) {
        state.value = result
        designId.value =
          result.entries.findLast((e) => e.kind === 'design' && e.requestId === requestId)?.id ?? ''
      }
    } catch (e) {
      if (id === runId.value) error.value = (e as Error).message
      throw e
    } finally {
      pending.value[id] = false
    }
  }
  async function action<T>(path: string, body: unknown = {}) {
    error.value = ''
    try {
      const result = await api.post<T>(`/runs/${runId.value}/review/${path}`, body)
      await refresh()
      return result
    } catch (e) {
      error.value = (e as Error).message
      throw e
    }
  }
  async function send() {
    if (!draft.value.trim() || sending.value) return
    const id = runId.value
    const text = draft.value
    const attached = { ...context.value, feedbackIds: [...context.value.feedbackIds] }
    pending.value[id] = true
    drafts.value[id] = ''
    error.value = ''
    try {
      await api.post(`/runs/${id}/review/chat`, {
        requestId: crypto.randomUUID(),
        text,
        context: attached,
      })
      contexts.value[id] = { ...attached, feedbackIds: [] }
      if (runId.value === id) await refresh()
    } catch (e) {
      drafts.value[id] = text
      if (runId.value === id) error.value = (e as Error).message
    } finally {
      pending.value[id] = false
    }
  }
  return {
    designOpen,
    designId,
    showDesign,
    generateDesign,
    open,
    runId,
    state,
    error,
    context,
    draft,
    sending,
    refresh,
    discuss,
    action,
    send,
  }
}
