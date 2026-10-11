export function useDashboardStyle() {
  const style = useState<'flight' | 'board'>('dashboard-style', () => {
    if (import.meta.client) {
      try {
        return localStorage.getItem('mpf.dashboard-style') === 'board' ? 'board' : 'flight'
      } catch {
        /* Storage may be unavailable. */
      }
    }
    return 'flight'
  })
  function setStyle(value: string) {
    style.value = value === 'board' ? 'board' : 'flight'
    try {
      localStorage.setItem('mpf.dashboard-style', style.value)
    } catch {
      /* Still switch in memory. */
    }
  }
  return { style, isBoard: computed(() => style.value === 'board'), setStyle }
}
