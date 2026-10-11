import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildInventory, classify, summarizeInventory } from '../src/inventory.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', '..', '..', 'fixtures', 'inhouse', 'web-vanilla-counter')

describe('buildInventory', () => {
  it('parses the counter fixture with tree-sitter and finds its symbols and hints', async () => {
    const inv = await buildInventory(fixture, { framework: 'static-html' })
    expect(inv.totals.files).toBeGreaterThanOrEqual(4)
    const main = inv.files.find((f) => f.path === 'main.js')
    expect(main?.parsed).toBe(true)
    expect(main?.role).toBe('entry')
    const names = main?.symbols.map((s) => s.name) ?? []
    expect(names).toEqual(
      expect.arrayContaining(['loadState', 'clampCount', 'increment', 'parity', 'render']),
    )
    expect(main?.symbols.find((s) => s.name === 'clampCount')?.exported).toBe(true)
    expect(main?.symbols.find((s) => s.name === 'render')?.exported).toBe(false)
    expect(inv.hints.persistenceHints.some((h) => h.startsWith('localStorage'))).toBe(true)
    expect(inv.hints.routeHints.some((h) => h.startsWith('hash-routing'))).toBe(true)
    const summary = summarizeInventory(inv)
    expect(summary).toContain('main.js')
    expect(summary).toContain('export function clampCount')
  })
})

describe('classify', () => {
  it('assigns roles from paths and languages', () => {
    expect(classify('src/pages/Home.tsx', 'tsx')).toBe('route')
    expect(classify('app/dashboard/page.tsx', 'tsx')).toBe('route')
    expect(classify('src/routes/about/+page.svelte', 'svelte')).toBe('route')
    expect(classify('src/store/cart.ts', 'typescript')).toBe('state')
    expect(classify('App/ViewModels/HomeViewModel.swift', 'swift')).toBe('state')
    expect(classify('src/lib/pricing.ts', 'typescript')).toBe('logic')
    expect(classify('src/components/Button.vue', 'vue')).toBe('component')
    expect(classify('App/Views/ContentView.swift', 'swift')).toBe('route')
    expect(classify('app/src/main/java/x/MainActivity.kt', 'kotlin')).toBe('entry')
    expect(classify('src/App.test.tsx', 'tsx')).toBe('test')
    expect(classify('package.json', 'json')).toBe('config')
    // Content decides for files whose path says nothing: UI-free source is logic.
    expect(
      classify('pricing.js', 'javascript', 'export function total(a, b) { return a + b }'),
    ).toBe('logic')
    expect(
      classify('widget.js', 'javascript', 'export function mount() { document.body.append(el) }'),
    ).toBe('other')
    expect(classify('Money.swift', 'swift', 'struct Money { let cents: Int }')).toBe('logic')
    expect(
      classify(
        'Shell.swift',
        'swift',
        'import SwiftUI\nstruct Shell: View { var body: some View { Text("x") } }',
      ),
    ).toBe('other')
    expect(classify('styles.css', 'css')).toBe('style')
    expect(classify('logo.png', 'asset')).toBe('asset')
  })
})

describe('test hooks', () => {
  it('collects the hooks a source already exposes', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'mpf-hooks-'))
    mkdirSync(join(root, 'app'), { recursive: true })
    writeFileSync(
      join(root, 'index.html'),
      '<main data-testid="mpf-root"><button data-testid="add-MUG-01">Add</button></main>',
    )
    writeFileSync(
      join(root, 'main.js'),
      'const x = `<section data-testid="screen-cart">${y}</section>`; el.dataset.testid = "dyn"',
    )
    writeFileSync(join(root, 'app/View.swift'), 'Text("x").accessibilityIdentifier("count-value")')
    writeFileSync(
      join(root, 'app/Screen.kt'),
      'Modifier.testTag("increment"); semantics { testTag = "row" }; Modifier.testTag("nav-${screen.id}"); NavItem(testId = "nav-counter")',
    )
    writeFileSync(
      join(root, 'app/Cell.swift'),
      'cell.accessibilityIdentifier = "note-row-\\(indexPath.row)"\nadd.accessibilityIdentifier = "add-note"',
    )
    writeFileSync(
      join(root, 'app/List.m'),
      'cell.accessibilityIdentifier = @"objc-row";\n[button setAccessibilityIdentifier:@"objc-add"];\ncell.accessibilityIdentifier = [NSString stringWithFormat:@"objc-row-%ld", (long)indexPath.row];',
    )
    const inv = await buildInventory(root, {})
    expect(inv.hints.testHooks).toEqual([
      'add-MUG-01',
      'add-note',
      'count-value',
      'increment',
      'mpf-root',
      'nav-<screen.id>',
      'nav-counter',
      'note-row-<indexPath.row>',
      'objc-add',
      'objc-row',
      'objc-row-<arg>',
      'row',
      'screen-cart',
    ])
  })

  it('collects HTML ids from web markup, not placeholders, bound ids, or storyboard object ids', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'mpf-ids-'))
    mkdirSync(join(root, 'src/components'), { recursive: true })
    mkdirSync(join(root, 'app/res/layout'), { recursive: true })
    writeFileSync(
      join(root, 'index.html'),
      '<section class="todoapp"><input class="new-todo" placeholder="What needs to be done?"></section><footer id="info" class="info"></footer>',
    )
    writeFileSync(
      join(root, 'src/components/Todos.vue'),
      '<template><input id="toggle-all" class="toggle-all" type="checkbox" /><li v-for="todo in todos" :id="todo.id" :key="todo.id">{{ todo.title }}</li></template>',
    )
    writeFileSync(join(root, 'src/main.js'), 'el.id="dynamic"; const t = `<b id="${x}">`')
    writeFileSync(
      join(root, 'app/Main.storyboard'),
      '<view id="Ab3-fG-9xZ"><label id="q1-22-abc"/></view>',
    )
    writeFileSync(join(root, 'app/res/layout/main.xml'), '<Button android:id="@+id/save" />')
    const inv = await buildInventory(root, {})
    expect(inv.hints.testHooks).toEqual(['info', 'save', 'toggle-all'])
  })
})

describe('android view ids as test hooks', () => {
  it('keeps layout ids and drops menu item and navigation destination ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mpf-inv-'))
    const res = join(dir, 'app', 'src', 'main', 'res')
    for (const sub of ['layout', 'menu', 'navigation'])
      mkdirSync(join(res, sub), { recursive: true })
    writeFileSync(
      join(res, 'layout', 'tasks_frag.xml'),
      '<LinearLayout android:id="@+id/tasks_list" />',
    )
    writeFileSync(
      join(res, 'menu', 'tasks_menu.xml'),
      '<menu><item android:id="@+id/menu_clear" /></menu>',
    )
    writeFileSync(
      join(res, 'navigation', 'nav_graph.xml'),
      '<navigation><fragment android:id="@+id/tasks_fragment_dest" /></navigation>',
    )
    writeFileSync(join(dir, 'app', 'build.gradle'), "plugins { id 'com.android.application' }")
    const inv = await buildInventory(dir, { framework: 'views' })
    expect(inv.hints.testHooks).toContain('tasks_list')
    expect(inv.hints.testHooks).not.toContain('menu_clear')
    expect(inv.hints.testHooks).not.toContain('tasks_fragment_dest')
  })
})
