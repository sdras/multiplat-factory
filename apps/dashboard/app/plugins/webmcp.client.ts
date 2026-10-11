/// <reference types="webmcp-types" />
import { createReviewTools } from '../utils/reviewTools'
export default defineNuxtPlugin((app) => {
  const modelContext = document.modelContext
  if (!modelContext) return
  const controller = new AbortController()
  const base = useRuntimeConfig().public.apiBase as string
  const review = useProjectReview()
  const activity = useState('webmcp-activity', () => '')
  const tools = createReviewTools({
    currentRun: () => review.runId.value,
    async call(path, signal, body) {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok)
        throw new Error(
          result.error ?? 'The request could not finish. Refresh the project and try again.',
        )
      return result
    },
    async reveal(id) {
      if (review.runId.value !== id) await navigateTo(`/runs/${id}`)
      review.open.value = true
      await review.refresh()
      await nextTick()
    },
    activity: (text) => {
      activity.value = `Agent: ${text}`
    },
  })
  for (const tool of tools)
    Promise.resolve(modelContext.registerTool(tool, { signal: controller.signal })).catch(() => {
      activity.value = 'Agent tools could not register in this browser.'
    })
  app.vueApp.onUnmount(() => controller.abort())
  if (import.meta.hot) import.meta.hot.dispose(() => controller.abort())
})
