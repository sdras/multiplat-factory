import { applyEvent, emptyView, type RunView } from '@mpf/core/reducer'
import type { Artifact, Event, Run, Stage } from '@mpf/core/schemas'

/**
 * Loads a run snapshot, then keeps it live over SSE. The view is derived purely
 * from the event log with the same reducer the server tests use.
 */
export function useRunView(runId: string) {
  const api = useApi()
  const view = ref<RunView>(emptyView())
  const connected = ref(false)
  const error = ref<string | undefined>()
  let source: EventSource | undefined

  async function load() {
    try {
      const snap = await api.get<{ run: Run; stages: Stage[]; artifacts: Artifact[] }>(
        `/runs/${runId}`,
      )
      view.value = { ...emptyView(), run: snap.run, stages: snap.stages, artifacts: snap.artifacts }
    } catch (e) {
      error.value = (e as Error).message
      return
    }
    connect()
  }

  function connect() {
    source?.close()
    source = new EventSource(`${api.base}/runs/${runId}/events?after=-1`)
    source.onopen = () => (connected.value = true)
    source.onerror = () => (connected.value = false)
    const handle = (msg: MessageEvent) => {
      const e = JSON.parse(msg.data) as Event
      view.value = applyEvent(view.value, e)
    }
    for (const t of [
      'run.status',
      'stage.status',
      'agent.message',
      'agent.tool_use',
      'agent.tool_result',
      'proc.started',
      'proc.stdout',
      'proc.stderr',
      'proc.exited',
      'build.result',
      'test.result',
      'critic.verdict',
      'cost.update',
      'artifact.added',
      'control',
      'human.required',
      'log',
    ])
      source.addEventListener(t, handle as EventListener)
  }

  onMounted(load)
  onUnmounted(() => source?.close())

  return { view, connected, error, reload: load }
}
