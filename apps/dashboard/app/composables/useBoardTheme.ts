export type BoardTheme = 'light' | 'dark'

/** The release board's light or dark palette. Light is the default; the choice is remembered per browser. */
export function useBoardTheme() {
  const theme = useState<BoardTheme>('board-theme', () => {
    if (import.meta.client) {
      try {
        const saved = localStorage.getItem('mpf.board-theme')
        if (saved === 'dark' || saved === 'light') return saved
      } catch {
        /* Storage may be unavailable. */
      }
    }
    return 'light'
  })
  function setTheme(value: BoardTheme) {
    theme.value = value
    try {
      localStorage.setItem('mpf.board-theme', value)
    } catch {
      /* Still switch in memory. */
    }
  }
  return { theme, isDark: computed(() => theme.value === 'dark'), setTheme }
}

/** The run a board page is showing, so the nav can name the project beside its tabs. */
export function useBoardProject() {
  return useState<{ id: string; name: string; status: string }>('board-project', () => ({
    id: '',
    name: '',
    status: '',
  }))
}
