/**
 * Green web scaffold: Vite + TypeScript, no framework beyond the one requested.
 * Conventions mirror the mobile scaffolds: routes = AppSpec screen ids behind a hash
 * router (`#/<screenId>` is the deep link; a web source's own route is the canonical hash), `data-testid` = AppSpec testId,
 * a `store.ts` over localStorage with the source app's keys, and a debug-only
 * `?mpf_seed=<json>` query parameter that loads a state snapshot before first paint.
 */

export const WEB_VERSIONS = {
  svelte: '^5.0.0',
  vitePluginSvelte: '^6.0.0',
  svelteCheck: '^4.0.0',
  vue: '^3.5.0',
  vitePluginVue: '^6.0.0',
  vueTsc: '^3.0.0',
  vueTestUtils: '^2.4.0',
  typesNode: '^24.0.0',
  vite: '^7.1.0',
  vitest: '^3.2.0',
  typescript: '^5.9.0',
  jsdom: '^26.1.0',
  react: '^19.1.0',
  reactDom: '^19.1.0',
  typesReact: '^19.1.0',
  typesReactDom: '^19.1.0',
  vitePluginReact: '^5.0.0',
}

export const WEB_SEED_PARAM = 'mpf_seed'

export type WebFramework = 'vanilla' | 'react' | 'vue' | 'svelte'

export interface WebScreen {
  id: string
  name: string
  /** The source app's own route (`#/active`, `/login`); a web port keeps it as the canonical URL. */
  route?: string
}

export interface WebProject {
  name: string
  appName: string
  framework: WebFramework
  screens: WebScreen[]
  rootScreen: string
  /** Embed the shared WebAssembly core (typed binding, parity test). */
  core?: boolean
}

/**
 * The hash a web port uses for a screen: the source's own hash route verbatim, a path route under
 * the hash (`/login` -> `#/login`), the bare `#/` for the root, and the screen id when the source has
 * no usable route (a mobile source, or a path with a parameter).
 */
export function canonicalHash(screen: WebScreen, rootId: string): string {
  const route = screen.route?.trim()
  const usable = route && !/[<>{}[\]|]/.test(route) && !/(^|\/):[A-Za-z_]/.test(route)
  if (usable) {
    const path = route.split('?')[0] ?? ''
    if (path.startsWith('#')) return path === '#' || path === '#/' ? '#/' : path
    if (path === '/' || path === '') return '#/'
    if (path.startsWith('/')) return `#${path}`
  }
  return screen.id === rootId ? '#/' : `#/${screen.id}`
}

export function webPackageNameFor(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'ported-app'
}

export function screenIdent(id: string, taken = new Set<string>()): string {
  let base = id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('')
  if (!base || /^[0-9]/.test(base)) base = `Screen${base}`
  let name = base
  let i = 2
  while (taken.has(name)) name = `${base}${i++}`
  taken.add(name)
  return name
}

export function webFiles(p: WebProject): Record<string, string> {
  const v = WEB_VERSIONS
  const taken = new Set<string>()
  const screens = p.screens.map((s) => ({ ...s, ident: screenIdent(s.id, taken) }))
  const root = screens.find((s) => s.id === p.rootScreen) ?? screens[0]
  if (!root) throw new Error('a web scaffold needs at least one screen')
  const react = p.framework === 'react'
  const vue = p.framework === 'vue'
  const svelte = p.framework === 'svelte'
  const files: Record<string, string> = {}

  files['package.json'] = `${JSON.stringify(
    {
      name: p.name,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: `${vue ? 'vue-tsc --noEmit -p tsconfig.json' : svelte ? 'svelte-check --tsconfig ./tsconfig.json' : 'tsc --noEmit -p tsconfig.json'} && vite build`,
        preview: 'vite preview',
        test: 'vitest run',
      },
      dependencies: react
        ? { react: v.react, 'react-dom': v.reactDom }
        : vue
          ? { vue: v.vue }
          : svelte
            ? { svelte: v.svelte }
            : {},
      devDependencies: {
        vite: v.vite,
        vitest: v.vitest,
        typescript: v.typescript,
        jsdom: v.jsdom,
        ...(react
          ? {
              '@types/react': v.typesReact,
              '@types/react-dom': v.typesReactDom,
              '@vitejs/plugin-react': v.vitePluginReact,
            }
          : {}),
        ...(vue
          ? {
              '@vitejs/plugin-vue': v.vitePluginVue,
              'vue-tsc': v.vueTsc,
              '@vue/test-utils': v.vueTestUtils,
            }
          : {}),
        ...(svelte
          ? { '@sveltejs/vite-plugin-svelte': v.vitePluginSvelte, 'svelte-check': v.svelteCheck }
          : {}),
        ...(p.core ? { '@types/node': v.typesNode } : {}),
      },
    },
    null,
    2,
  )}\n`

  files['tsconfig.json'] = `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        isolatedModules: true,
        resolveJsonModule: true,
        types: ['vite/client', ...(p.core ? ['node'] : [])],
        ...(react ? { jsx: 'react-jsx' } : {}),
      },
      include: vue ? ['src', 'src/**/*.vue'] : svelte ? ['src', 'src/**/*.svelte'] : ['src'],
    },
    null,
    2,
  )}\n`

  files['vite.config.ts'] = react
    ? `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
})
`
    : vue
      ? `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: { environment: 'jsdom', include: ['src/**/*.test.ts'] },
})
`
      : svelte
        ? `import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  // Tests mount components in jsdom, which needs Svelte's browser build.
  resolve: { conditions: ['browser'] },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts'] },
})
`
        : `import { defineConfig } from 'vite'

export default defineConfig({
  test: { environment: 'jsdom', include: ['src/**/*.test.ts'] },
})
`
  files['vitest.config.ts'] = `export { default } from './vite.config'\n`

  files['.gitignore'] =
    `node_modules/\ndist/\ntest-results/\n.netlify/\n.env\n.env.*\n!.env.example\n`

  files['netlify.toml'] = `[build]\n  command = "npm run build"\n  publish = "dist"\n`

  files['index.html'] = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${html(p.appName)}</title>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="app" data-testid="mpf-root"></div>
    <script type="module" src="/src/main.${react ? 'tsx' : 'ts'}"></script>
  </body>
</html>
`

  files['src/styles.css'] = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 24px; max-width: 640px; margin-inline: auto; }
`

  files['src/routes.ts'] = `/**
 * Routes are the AppSpec screen ids. The canonical hash of a screen is the source app's own route
 * when it has one (\`#/active\`, \`/login\` becomes \`#/login\`), so links and bookmarks from the original
 * keep working; \`#/<screenId>\` always resolves too and is the deep link the factory's flows use.
 */
export const Routes = {
${screens.map((s) => `  ${camel(s.id)}: '${s.id}',`).join('\n')}
  root: '${root.id}',
} as const

export const ALL_ROUTES: string[] = [${screens.map((s) => `'${s.id}'`).join(', ')}]

/** Canonical hash per screen id. */
export const ROUTE_HASH: Record<string, string> = {
${screens.map((s) => `  '${s.id}': '${canonicalHash(s, root.id)}',`).join('\n')}
}

const hashKey = (hash: string): string => hash.replace(/^#\\/?/, '').split(/[?#]/)[0] ?? ''

/** Current screen id from the hash; unknown or empty hashes resolve to the root. */
export function currentRoute(hash: string = location.hash): string {
  const key = hashKey(hash)
  if (ALL_ROUTES.includes(key)) return key
  const byRoute = Object.entries(ROUTE_HASH).find(([, h]) => hashKey(h) === key)
  return byRoute ? byRoute[0] : Routes.root
}

/** The href a link to a screen renders: its canonical hash. */
export function hrefFor(id: string): string {
  return ROUTE_HASH[id] ?? (id === Routes.root ? '#/' : \`#/\${id}\`)
}

export function navigate(id: string): void {
  location.hash = hrefFor(id)
}
`

  files['src/store.ts'] = `/**
 * Persistence with the same keys and JSON shapes as the source app. Values are stored
 * as strings; JSON documents go through \`readJson\`/\`writeJson\`.
 */
export const SEED_PARAM = '${WEB_SEED_PARAM}'

export function getString(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function setString(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = getString(key)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): void {
  setString(key, JSON.stringify(value))
}

/**
 * Replace all stored keys with a JSON object of key -> value (strings verbatim, others as JSON).
 * localStorage writes are synchronous, so the seed is persisted when this returns.
 */
export function seed(json: string): void {
  let object: Record<string, unknown>
  try {
    object = JSON.parse(json) as Record<string, unknown>
  } catch {
    return
  }
  try {
    localStorage.clear()
  } catch {
    return
  }
  for (const [key, value] of Object.entries(object)) setString(key, typeof value === 'string' ? value : JSON.stringify(value))
}

/** Development builds accept \`?${WEB_SEED_PARAM}=<json>\` and apply it before the first render. */
export function applySeedIfPresent(): void {
  if (!import.meta.env.DEV) return
  const url = new URL(location.href)
  const json = url.searchParams.get(SEED_PARAM)
  if (json === null) return
  seed(json)
  url.searchParams.delete(SEED_PARAM)
  history.replaceState(null, '', url.toString())
}
`

  if (react) {
    files['src/main.tsx'] = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applySeedIfPresent } from './store'

applySeedIfPresent()
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`
    files['src/App.tsx'] = `import { useEffect, useState } from 'react'
import { Routes, currentRoute } from './routes'
${screens.map((s) => `import { ${s.ident}Screen } from './screens/${s.ident}Screen'`).join('\n')}

export function useRoute(): string {
  const [route, setRoute] = useState(() => currentRoute())
  useEffect(() => {
    const onChange = () => setRoute(currentRoute())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function App() {
  const route = useRoute()
  switch (route) {
${screens.map((s) => `    case Routes.${camel(s.id)}:\n      return <${s.ident}Screen />`).join('\n')}
    default:
      return <${root.ident}Screen />
  }
}
`
    for (const s of screens) {
      files[`src/screens/${s.ident}Screen.tsx`] =
        `/** Placeholder for the "${s.name}" screen (AppSpec id "${s.id}"). Replace the body; keep the data-testid. */
export function ${s.ident}Screen() {
  return (
    <section data-testid="screen-${s.id}">
      <h1>${html(s.name)}</h1>
    </section>
  )
}
`
    }
    files['src/App.test.tsx'] = `import { describe, expect, it } from 'vitest'
import { ALL_ROUTES, currentRoute, hrefFor } from './routes'

describe('routes', () => {
  it('resolves the root for unknown hashes', () => {
    expect(currentRoute('#/nope')).toBe('${root.id}')
    expect(currentRoute('#/${root.id}')).toBe('${root.id}')
  })
  it('round-trips every screen through its canonical hash and its deep link', () => {
    for (const id of ALL_ROUTES) {
      expect(currentRoute(hrefFor(id))).toBe(id)
      expect(currentRoute(\`#/\${id}\`)).toBe(id)
    }
  })
})
`
  } else if (vue) {
    files['src/main.ts'] = `import { createApp } from 'vue'
import App from './App.vue'
import { applySeedIfPresent } from './store'

applySeedIfPresent()
createApp(App).mount('#app')
`
    files['src/env.d.ts'] = `/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
`
    files['src/useRoute.ts'] = `import { onBeforeUnmount, onMounted, ref } from 'vue'
import { currentRoute } from './routes'

/** The current AppSpec screen id, following the hash. */
export function useRoute() {
  const route = ref(currentRoute())
  const onChange = () => {
    route.value = currentRoute()
  }
  onMounted(() => window.addEventListener('hashchange', onChange))
  onBeforeUnmount(() => window.removeEventListener('hashchange', onChange))
  return route
}
`
    files['src/App.vue'] = `<script setup lang="ts">
import { Routes } from './routes'
import { useRoute } from './useRoute'
${screens.map((s) => `import ${s.ident}Screen from './screens/${s.ident}Screen.vue'`).join('\n')}

const route = useRoute()
</script>

<template>
${screens.map((s, i) => `  <${s.ident}Screen v-${i === 0 ? 'if' : 'else-if'}="route === Routes.${camel(s.id)}" />`).join('\n')}
  <${root.ident}Screen v-else />
</template>
`
    for (const s of screens) {
      files[`src/screens/${s.ident}Screen.vue`] =
        `<!-- Placeholder for the "${s.name}" screen (AppSpec id "${s.id}"). Replace the body; keep the data-testid. -->
<template>
  <section data-testid="screen-${s.id}">
    <h1>${html(s.name)}</h1>
  </section>
</template>
`
    }
    files['src/App.test.ts'] = `import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import App from './App.vue'
import { ALL_ROUTES, currentRoute, hrefFor } from './routes'

describe('routes', () => {
  it('resolves the root for unknown hashes', () => {
    expect(currentRoute('#/nope')).toBe('${root.id}')
    expect(currentRoute('#/${root.id}')).toBe('${root.id}')
  })
  it('renders the root screen', () => {
    const wrapper = mount(App)
    expect(wrapper.find('[data-testid="screen-${root.id}"]').exists()).toBe(true)
  })
})
`
  } else if (svelte) {
    files['src/main.ts'] = `import { mount } from 'svelte'
import App from './App.svelte'
import { applySeedIfPresent } from './store'

applySeedIfPresent()
mount(App, { target: document.getElementById('app')! })
`
    files['src/env.d.ts'] = `/// <reference types="vite/client" />
/// <reference types="svelte" />
declare module '*.svelte' {
  import type { Component } from 'svelte'
  const component: Component
  export default component
}
`
    files['src/useRoute.ts'] = `import { readable } from 'svelte/store'
import { currentRoute } from './routes'

/** The current AppSpec screen id, following the hash. */
export const route = readable(currentRoute(), (set) => {
  const onChange = () => set(currentRoute())
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
})
`
    files['src/App.svelte'] = `<script lang="ts">
  import { Routes } from './routes'
  import { route } from './useRoute'
${screens.map((s) => `  import ${s.ident}Screen from './screens/${s.ident}Screen.svelte'`).join('\n')}
</script>

${screens.map((s, i) => `{${i === 0 ? '#if' : ':else if'} $route === Routes.${camel(s.id)}}\n  <${s.ident}Screen />`).join('\n')}
{:else}
  <${root.ident}Screen />
{/if}
`
    for (const s of screens) {
      files[`src/screens/${s.ident}Screen.svelte`] =
        `<!-- Placeholder for the "${s.name}" screen (AppSpec id "${s.id}"). Replace the body; keep the data-testid. -->
<section data-testid="screen-${s.id}">
  <h1>${html(s.name)}</h1>
</section>
`
    }
    files['src/App.test.ts'] = `import { mount, unmount } from 'svelte'
import { describe, expect, it } from 'vitest'
import App from './App.svelte'
import { ALL_ROUTES, currentRoute, hrefFor } from './routes'

describe('routes', () => {
  it('resolves the root for unknown hashes', () => {
    expect(currentRoute('#/nope')).toBe('${root.id}')
    expect(currentRoute('#/${root.id}')).toBe('${root.id}')
  })
  it('renders the root screen', () => {
    const app = mount(App, { target: document.body })
    expect(document.querySelector('[data-testid="screen-${root.id}"]')).not.toBeNull()
    unmount(app)
  })
})
`
  } else {
    files['src/main.ts'] = `import { Routes, currentRoute } from './routes'
import { applySeedIfPresent } from './store'
${screens.map((s) => `import { render${s.ident} } from './screens/${s.ident}Screen'`).join('\n')}

applySeedIfPresent()
const app = document.getElementById('app')!

export function render(): void {
  const route = currentRoute()
  app.innerHTML = ''
  switch (route) {
${screens.map((s) => `    case Routes.${camel(s.id)}:\n      app.appendChild(render${s.ident}())\n      break`).join('\n')}
    default:
      app.appendChild(render${root.ident}())
  }
}

window.addEventListener('hashchange', render)
render()
`
    for (const s of screens) {
      files[`src/screens/${s.ident}Screen.ts`] =
        `/** Placeholder for the "${s.name}" screen (AppSpec id "${s.id}"). Replace the body; keep the data-testid. */
export function render${s.ident}(): HTMLElement {
  const section = document.createElement('section')
  section.dataset.testid = 'screen-${s.id}'
  const h1 = document.createElement('h1')
  h1.textContent = ${JSON.stringify(s.name)}
  section.appendChild(h1)
  return section
}
`
    }
    files['src/routes.test.ts'] = `import { describe, expect, it } from 'vitest'
import { ALL_ROUTES, currentRoute, hrefFor } from './routes'

describe('routes', () => {
  it('resolves the root for unknown hashes', () => {
    expect(currentRoute('#/nope')).toBe('${root.id}')
    expect(currentRoute('#/${root.id}')).toBe('${root.id}')
  })
  it('round-trips every screen through its canonical hash and its deep link', () => {
    for (const id of ALL_ROUTES) {
      expect(currentRoute(hrefFor(id))).toBe(id)
      expect(currentRoute(\`#/\${id}\`)).toBe(id)
    }
  })
})
`
  }

  files['MPF.md'] = `# Conventions for this generated web project

- Vite + TypeScript${react ? ' + React 19 (function components, hooks)' : vue ? ' + Vue 3 (script setup, composition API)' : svelte ? ' + Svelte 5 (runes; stores for the route)' : ' (framework-free DOM code)'}. Package name \`${p.name}\`.
- Build: \`npm run build\` (type check + vite build into \`dist/\`). Unit tests: \`npm test\` (vitest, jsdom). Keep both green.
- Routes are the AppSpec screen ids (\`src/routes.ts\`); the canonical hash of a screen is \`ROUTE_HASH[id]\`, the source app's own route when it has one, and links render \`hrefFor(id)\`, never a hand-written \`#/<screenId>\`. Every screen must stay reachable through the hash \`#/<screenId>\`; the factory's flows navigate that way. Add new screens to \`Routes\`, the switch in \`${react ? 'src/App.tsx' : vue ? 'src/App.vue' : svelte ? 'src/App.svelte' : 'src/main.ts'}\`, and \`src/screens/\`.
- Every AppSpec element gets \`data-testid="<testId>"\` on the element a user interacts with (the button, the input, the text). Keep \`data-testid="mpf-root"\` on the root and \`screen-<id>\` on each screen container.
- Every icon-only control (a \`<button>\` whose only content is an SVG, an icon-font glyph, or a character such as "+") carries \`aria-label="…"\` that says what it does ("Add item", "Increase count", "Close"), and an inline SVG inside it gets \`aria-hidden="true"\`. A screen reader must announce the action, never "plus". Buttons with visible text need no aria-label.
- Controls repeated per row (a row's toggle, delete, or edit control) carry an \`aria-label\` that includes the row's primary text (\`Delete Buy milk\`, not \`Delete\`), so screen readers and flows can tell one row's control from another's.
- A field the source submits on Enter must submit on a \`keydown\`/\`keyup\` of \`Enter\` (or be inside a \`<form>\` whose submit handles it): the flows type the text followed by a newline, which Playwright delivers as an Enter key press.
- Never change timings, durations, or the visibility of transient UI (a snackbar, a toast, a loading indicator) so that a flow can observe it; the port shows them for as long as the source does. A flow that cannot catch a transient element is reported as such, not accommodated.
- Tappable text (a filter pill, a "Clear completed" link, a title that navigates) is a \`<button>\` or an \`<a href>\`, never a \`<span>\` or \`<div>\` with a click handler, so it is focusable and announced as a control.
- Persist state through \`src/store.ts\` using the source app's key names and JSON shapes exactly (wire-format pins from the AppSpec).
- Development builds accept \`?${WEB_SEED_PARAM}=<json>\` (JSON object of key -> value) that replaces persisted state before the first render; do not remove it. A seed must be persisted before the first frame: \`applySeedIfPresent()\` runs before the app mounts and \`seed\` writes through \`localStorage\`, which is synchronous; keep it that way (no async storage for seeds), because a flow may reload the page as soon as the root is visible and read the stored state.
- Pure logic goes in \`src/logic/\` with vitest tests next to it. Do not add runtime dependencies that need the network unless the port plan ports that integration.
${p.core ? '- Shared core: see the "Shared core" section appended below; import `src/core/mpf-core.ts` for that logic instead of reimplementing it, and keep `src/core/parity.test.ts` green.\n' : ''}`
  return files
}

function camel(id: string): string {
  const parts = id.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const name = parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1)))
    .join('')
  return /^[a-zA-Z]/.test(name) ? name : `s${name}`
}

function html(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
