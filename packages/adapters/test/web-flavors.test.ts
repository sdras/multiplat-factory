import { describe, expect, it } from 'vitest'
import { supportedFramework } from '../src/target/web/index.ts'
import { webFiles } from '../src/target/web/template.ts'

const project = {
  name: 'counter',
  appName: 'Counter',
  screens: [
    { id: 'counter', name: 'Counter' },
    { id: 'settings', name: 'Settings' },
  ],
  rootScreen: 'counter',
}

describe('web scaffold flavors', () => {
  it('picks the flavor from the plan and falls back to vanilla', () => {
    expect(supportedFramework('Vue 3 + Vite')).toBe('vue')
    expect(supportedFramework('Nuxt')).toBe('vue')
    expect(supportedFramework('React')).toBe('react')
    expect(supportedFramework('SvelteKit')).toBe('svelte')
    expect(supportedFramework('Angular')).toBe('vanilla')
  })

  it('writes a Vue 3 project with the same conventions as the other flavors', () => {
    const files = webFiles({ ...project, framework: 'vue' })
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'src/main.ts',
        'src/App.vue',
        'src/useRoute.ts',
        'src/env.d.ts',
        'src/screens/CounterScreen.vue',
        'src/screens/SettingsScreen.vue',
        'src/App.test.ts',
      ]),
    )
    const pkg = JSON.parse(files['package.json']!) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.dependencies.vue).toBeDefined()
    expect(pkg.devDependencies['@vitejs/plugin-vue']).toBeDefined()
    expect(pkg.devDependencies['vue-tsc']).toBeDefined()
    expect(pkg.scripts.build).toContain('vue-tsc --noEmit')
    expect(files['vite.config.ts']).toContain("import vue from '@vitejs/plugin-vue'")
    expect(files['src/App.vue']).toContain('<CounterScreen v-if="route === Routes.counter" />')
    expect(files['src/App.vue']).toContain(
      '<SettingsScreen v-else-if="route === Routes.settings" />',
    )
    expect(files['src/App.vue']).toContain('<CounterScreen v-else />')
    expect(files['src/screens/SettingsScreen.vue']).toContain('data-testid="screen-settings"')
    expect(files['src/main.ts']).toContain('applySeedIfPresent()')
    expect(files['MPF.md']).toContain('Vue 3')
    expect(files['MPF.md']).toContain('src/App.vue')
  })

  it('writes a Svelte 5 project with a store-backed route and a mount test', () => {
    const files = webFiles({ ...project, framework: 'svelte' })
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'src/App.svelte',
        'src/useRoute.ts',
        'src/env.d.ts',
        'src/screens/CounterScreen.svelte',
        'src/App.test.ts',
      ]),
    )
    const pkg = JSON.parse(files['package.json']!) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.dependencies.svelte).toBeDefined()
    expect(pkg.devDependencies['@sveltejs/vite-plugin-svelte']).toBeDefined()
    expect(pkg.scripts.build).toContain('svelte-check')
    expect(files['vite.config.ts']).toContain("resolve: { conditions: ['browser'] }")
    expect(files['src/App.svelte']).toContain('{#if $route === Routes.counter}')
    expect(files['src/App.svelte']).toContain('{:else if $route === Routes.settings}')
    expect(files['src/env.d.ts']).toContain("declare module '*.svelte'")
    expect(files['src/main.ts']).toContain(
      "mount(App, { target: document.getElementById('app')! })",
    )
    expect(files['MPF.md']).toContain('Svelte 5')
  })

  it('keeps the vanilla flavor free of framework files', () => {
    const files = webFiles({ ...project, framework: 'vanilla' })
    expect(files['src/App.vue']).toBeUndefined()
    expect(JSON.parse(files['package.json']!).dependencies).toEqual({})
  })

  it('asks every flavor for an aria-label on icon-only controls', () => {
    for (const framework of ['vanilla', 'react', 'vue', 'svelte'] as const) {
      const md = webFiles({ ...project, framework })['MPF.md']!
      expect(md).toContain('icon-only control')
      expect(md).toContain('aria-label')
    }
  })
})
