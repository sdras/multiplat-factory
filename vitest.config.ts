import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/cli', 'apps/server'],
    passWithNoTests: true,
  },
})
