/** A ticking `now` for elapsed clocks and the timeline cursor. */
export function useClock(intervalMs = 1000) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    now.value = Date.now()
    timer = setInterval(() => (now.value = Date.now()), intervalMs)
  })
  onUnmounted(() => clearInterval(timer))
  return { now }
}
