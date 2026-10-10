/** Polls the server health endpoint so the shell can show whether the daemon is reachable. */
export function useHealth(intervalMs = 15_000) {
  const api = useApi()
  const ok = ref(false)
  const checked = ref(false)
  const health = ref<{
    ok: boolean
    version: string
    realPipeline: boolean
    availableStages?: string[]
  }>()
  let timer: ReturnType<typeof setInterval> | undefined

  async function check() {
    try {
      health.value = await api.get('/health')
      ok.value = !!health.value?.ok
    } catch {
      ok.value = false
    } finally {
      checked.value = true
    }
  }

  onMounted(() => {
    void check()
    timer = setInterval(check, intervalMs)
  })
  onUnmounted(() => clearInterval(timer))

  return { ok, checked, health, check }
}
