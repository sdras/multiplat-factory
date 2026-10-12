import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'pathe'

import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import type { AppSpec, Behavior } from '@mpf/core'
import { executeBehavior, launchChromium, resolveElement } from '../src/target/web/executor.ts'

// Needs Playwright's Chromium (`pnpm --filter @mpf/analyzer exec playwright install chromium`);
// without it the suite is skipped, like the observe stage degrades to "unverified".
const browser: Browser | undefined = await launchChromium().catch(() => undefined)

/** A list whose rows share one test id, as a notes app exposes them; a tap opens the editor. */
const pageHtml = `<!doctype html>
<html>
  <body>
    <div data-testid="mpf-root">
      <ul data-testid="note-list">
        <li data-testid="note_row"><span data-testid="note_title">First note</span></li>
        <li data-testid="note_row"><span data-testid="note_title">Second note</span></li>
        <li data-testid="note_row"><span data-testid="note_title">Third note</span></li>
      </ul>
      <section data-testid="editor" hidden><h1 data-testid="editor_title"></h1></section>
    </div>
    <script>
      for (const row of document.querySelectorAll('[data-testid="note_row"]')) {
        row.addEventListener('click', () => {
          const editor = document.querySelector('[data-testid="editor"]')
          editor.hidden = false
          editor.querySelector('[data-testid="editor_title"]').textContent = row.textContent.trim()
        })
      }
    </script>
  </body>
</html>
`

/**
 * TodoMVC markup, served at /todo: no test hooks anywhere, only classes, one id, a placeholder, and
 * hrefs, as public web apps usually come. Clearing completed items removes the completed rows.
 */
const todoHtml = `<!doctype html>
<html>
  <body>
    <style>.destroy { display: none } li:hover .destroy { display: inline-block } .edit { display: none } li.editing .edit { display: inline-block }</style>
    <section class="todoapp" ondblclick="const li = event.target.closest('li'); if (li && event.target.tagName === 'LABEL') { li.classList.add('editing'); if (!li.querySelector('.edit')) { const i = document.createElement('input'); i.className = 'edit'; i.value = event.target.textContent; li.appendChild(i) } }" onclick="if (event.target.classList.contains('destroy')) event.target.closest('li').remove()">
      <header class="header">
        <h1>todos</h1>
        <input class="new-todo" placeholder="What needs to be done?" autofocus onkeydown="if (event.key === 'Enter' && this.value.trim()) { const li = document.createElement('li'); li.innerHTML = '<div class=&quot;view&quot;><input class=&quot;toggle&quot; type=&quot;checkbox&quot;><label>' + this.value.trim() + '</label><button class=&quot;destroy&quot;></button></div>'; document.querySelector('.todo-list').appendChild(li); this.value = '' }">
      </header>
      <main class="main">
        <div class="toggle-all-container">
          <input id="toggle-all" class="toggle-all" type="checkbox">
          <label for="toggle-all">Mark all as complete</label>
        </div>
        <ul class="todo-list">
          <li class="completed"><div class="view"><input class="toggle" type="checkbox" checked><label>First todo</label><button class="destroy"></button></div></li>
          <li><div class="view"><input class="toggle" type="checkbox"><label>Second todo</label><button class="destroy"></button></div></li>
          <li><div class="view"><input class="toggle" type="checkbox"><label>Third todo</label><button class="destroy"></button></div></li>
          <li hidden><div class="view"><input class="toggle" type="checkbox"><label>Filtered-out todo</label><button class="destroy"></button></div></li>
        </ul>
      </main>
      <footer class="footer">
        <label class="search" data-testid="search-field"><span>Search</span><input class="search-input" type="text"></label>
        <span class="todo-count"><strong>2</strong> items left</span>
        <ul class="filters">
          <li><a href="#/" class="selected">All</a></li>
          <li><a href="#/active">Active</a></li>
          <li><a href="#/completed">Completed</a></li>
        </ul>
        <button class="clear-completed">Clear completed</button>
      </footer>
    </section>
    <script>
      document.querySelector('.clear-completed').addEventListener('click', () => {
        for (const li of document.querySelectorAll('.todo-list li.completed')) li.remove()
      })
    </script>
  </body>
</html>
`

/** The spec a worker writes for it: invented testIds the port will add, plus the source's own selectors. */
const todoSpec: AppSpec = {
  name: 'Todos',
  source: { platform: 'web', framework: 'vue', language: 'javascript', entry: 'index.html' },
  screens: [
    {
      id: 'todos',
      name: 'Todos',
      route: '/todo',
      purpose: 'p',
      elements: [
        // Found only through the selector: the label matches no placeholder or text on the page.
        {
          id: 'new-todo',
          kind: 'input',
          label: 'New todo',
          testId: 'new-todo-input',
          sourceSelector: '.new-todo',
        },
        // No selector and no accessible name: the class token equal to the testId is all there is.
        { id: 'destroy', kind: 'button', label: 'Delete', testId: 'destroy' },
        // Appears only on double click, the TodoMVC way.
        {
          id: 'edit-input',
          kind: 'input',
          label: 'Edit todo',
          testId: 'edit',
          sourceSelector: 'li.editing .edit',
        },
        // The test id sits on the field's wrapper, not on the input itself.
        { id: 'search', kind: 'input', label: 'Search', testId: 'search-field' },
        // A leaf control whose text lives on its row.
        {
          id: 'row-toggle',
          kind: 'toggle',
          label: 'Toggle todo',
          testId: 'todo-toggle',
          sourceSelector: 'ul.todo-list li input.toggle',
        },
        // The one real hook on the page, an HTML id.
        { id: 'toggle-all', kind: 'toggle', label: 'Toggle all', testId: 'toggle-all' },
        {
          id: 'todo-label',
          kind: 'text',
          label: 'Todo title',
          testId: 'todo-label',
          sourceSelector: '.todo-list li label',
        },
        {
          id: 'todo-list',
          kind: 'list',
          label: 'Todo list',
          testId: 'todo-list',
          sourceSelector: '.todo-list',
        },
        {
          id: 'filter-active',
          kind: 'link',
          label: 'Active',
          testId: 'filter-active',
          sourceSelector: 'a[href="#/active"]',
        },
        {
          id: 'clear-completed',
          kind: 'button',
          label: 'Clear completed',
          testId: 'clear-completed',
          sourceSelector: 'button.clear-completed',
        },
      ],
      navigatesTo: [],
    },
  ],
  navigation: { style: 'routes', root: 'todos', edges: [] },
  state: { entities: {}, storeStyle: 'x', persistence: [] },
  logic: [],
  integrations: [],
  assets: [],
  permissions: [],
  platformFeatures: [],
  unknowns: [],
}

const spec: AppSpec = {
  name: 'Notes',
  source: {
    platform: 'web',
    framework: 'static-html',
    language: 'javascript',
    entry: 'index.html',
  },
  screens: [
    {
      id: 'list',
      name: 'List',
      route: '/',
      purpose: 'p',
      elements: [
        { id: 'note-row', kind: 'link', label: 'Note row', testId: 'note_row' },
        { id: 'editor-title', kind: 'text', label: 'Editor title', testId: 'editor_title' },
      ],
      navigatesTo: [],
    },
  ],
  navigation: { style: 'routes', root: 'list', edges: [] },
  state: { entities: {}, storeStyle: 'x', persistence: [] },
  logic: [],
  integrations: [],
  assets: [],
  permissions: [],
  platformFeatures: [],
  unknowns: [],
}

const behavior = (steps: Behavior['steps']): Behavior => ({
  id: 'B-001',
  title: 'x',
  screen: 'list',
  priority: 'must',
  category: 'nav',
  evidence: [],
  verifiedOnSource: false,
  steps,
})

const log = () => {}

describe.skipIf(!browser)('web executor', () => {
  let server: Server
  let baseUrl: string
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(req.url?.startsWith('/todo') ? todoHtml : pageHtml)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterAll(async () => {
    server?.close()
    await browser?.close()
  })

  it('resolves a shared test id to the row whose text contains the qualifier', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    try {
      await page.goto(baseUrl)
      const first = await resolveElement(page, spec, 'note-row')
      expect(await first?.textContent()).toContain('First note')
      const second = await resolveElement(page, spec, 'note-row', 'second')
      expect(await second?.textContent()).toContain('Second note')
      expect(await resolveElement(page, spec, 'note-row', 'Fourth')).toBeUndefined()
    } finally {
      await context.close()
    }
  }, 30_000)

  it('taps the qualified row, and fails clearly when no row matches', async () => {
    const opened = await executeBehavior(
      browser!,
      baseUrl,
      spec,
      behavior([
        { op: 'tap', element: 'note-row', text: 'Third' },
        { op: 'expectText', element: 'editor-title', text: 'Third note', exact: true },
      ]),
      undefined,
      log,
    )
    expect(opened).toEqual({ ok: true })
    const missing = await executeBehavior(
      browser!,
      baseUrl,
      spec,
      behavior([{ op: 'tap', element: 'note-row', text: 'Fourth' }]),
      undefined,
      log,
    )
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('element "note-row" with text "Fourth" not found')
  }, 30_000)

  it('finds hookless elements by sourceSelector, class token, and HTML id', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    try {
      await page.goto(`${baseUrl}todo`)
      const attr = async (elementId: string, name: string, text?: string) => {
        const loc = await resolveElement(page, todoSpec, elementId, text)
        return loc ? loc.getAttribute(name) : undefined
      }
      // `.new-todo` by selector: nothing on the page carries the spec's label or testId.
      expect(await attr('new-todo', 'placeholder')).toBe('What needs to be done?')
      // `[class~="destroy"]`: a label-less button whose class the spec reused as its testId.
      expect(await attr('destroy', 'class')).toBe('destroy')
      // `#toggle-all`: the one id on the page.
      expect(await attr('toggle-all', 'type')).toBe('checkbox')
      // The text qualifier still narrows a selector that matches several rows.
      const second = await resolveElement(page, todoSpec, 'todo-label', 'Second')
      expect(await second?.textContent()).toBe('Second todo')
      expect(await resolveElement(page, todoSpec, 'todo-label', 'Fourth')).toBeUndefined()
      expect(await attr('filter-active', 'href')).toBe('#/active')
    } finally {
      await context.close()
    }
  }, 30_000)

  it('changes the hash in place on a hash-routed app so in-memory state survives', async () => {
    // The same page under hash routes: the added row lives only in the DOM, so a reload would lose it.
    const hashSpec: AppSpec = {
      ...todoSpec,
      screens: [
        { ...todoSpec.screens[0]!, route: '/todo#/' },
        {
          ...todoSpec.screens[0]!,
          id: 'todos-active',
          name: 'Active',
          route: '/todo#/active',
          elements: [],
        },
      ],
      navigation: { style: 'routes', root: 'todos', edges: [] },
    }
    const r = await executeBehavior(
      browser!,
      baseUrl,
      hashSpec,
      {
        ...behavior([
          { op: 'type', element: 'new-todo', text: 'Fourth todo\n' },
          { op: 'navigate', screen: 'todos-active' },
          { op: 'expectCount', element: 'todo-label', count: 4 },
          { op: 'openRoute', route: 'nope' },
          { op: 'expectCount', element: 'todo-label', count: 4 },
        ]),
        screen: 'todos',
      },
      undefined,
      () => {},
    )
    expect(r.ok, r.error).toBe(true)
  }, 30_000)

  it('does not fall back from a scoped selector to a test id another element shares', async () => {
    // Two spec elements share the source hook `new-todo-input`; the second is scoped to an editor
    // that is not open, so it must resolve to nothing rather than to the header field.
    const shared: AppSpec = {
      ...todoSpec,
      screens: [
        {
          ...todoSpec.screens[0]!,
          elements: [
            ...todoSpec.screens[0]!.elements,
            {
              id: 'edit-field',
              kind: 'input',
              label: 'Edit field',
              testId: 'new-todo-input',
              sourceSelector: 'li.editing input.edit',
            },
          ],
        },
      ],
    }
    const page = await browser!.newPage()
    await page.goto(`${baseUrl}todo`)
    expect(await resolveElement(page, shared, 'new-todo')).toBeDefined()
    expect(await resolveElement(page, shared, 'edit-field')).toBeUndefined()
    await page.close()
  }, 30_000)

  it('counts only visible rows: a filter that hides a row with `hidden` keeps it in the DOM', async () => {
    // The page carries a fourth, hidden row; both ways of counting see three.
    const r = await executeBehavior(
      browser!,
      baseUrl,
      todoSpec,
      {
        ...behavior([
          { op: 'expectCount', element: 'todo-label', count: 3 },
          { op: 'expectCount', element: 'todo-list', count: 3 },
        ]),
        screen: 'todos',
      },
      undefined,
      () => {},
    )
    expect(r.ok, r.error).toBe(true)
  }, 30_000)

  it('opens a screen by its concrete path, dropping a query pattern, and refuses a parameterized one', async () => {
    const routed: AppSpec = {
      ...todoSpec,
      screens: [
        { ...todoSpec.screens[0]!, route: '/todo?tab=all|active&tag=<tag>&page=<n>' },
        {
          ...todoSpec.screens[0]!,
          id: 'detail',
          name: 'Detail',
          route: '/todo/[id]',
          elements: [],
        },
      ],
    }
    const ok = await executeBehavior(
      browser!,
      baseUrl,
      routed,
      { ...behavior([{ op: 'expectCount', element: 'todo-label', count: 3 }]), screen: 'todos' },
      undefined,
      () => {},
    )
    expect(ok.ok, ok.error).toBe(true)
    const direct = await executeBehavior(
      browser!,
      baseUrl,
      routed,
      { ...behavior([{ op: 'expectCount', element: 'todo-label', count: 3 }]), screen: 'detail' },
      undefined,
      () => {},
    )
    expect(direct.ok).toBe(false)
    expect(direct.error).toMatch(/parameterized route "\/todo\/\[id\]"/)
  }, 30_000)

  it('replaces {{unique}} with one fresh token per flow in typed and expected text', async () => {
    const r = await executeBehavior(
      browser!,
      baseUrl,
      todoSpec,
      {
        ...behavior([
          { op: 'type', element: 'new-todo', text: 'user-{{unique}}@example.com\n' },
          {
            op: 'expectText',
            element: 'todo-label',
            text: 'user-{{unique}}@example.com',
            exact: true,
          },
          { op: 'expectText', element: 'todo-list', text: '{{unique}}', exact: false },
        ]),
        screen: 'todos',
      },
      undefined,
      () => {},
    )
    expect(r.ok, r.error).toBe(true)
  }, 30_000)

  it('scopes a leaf control by its row even when the selector skips the row element', async () => {
    const skipping: AppSpec = {
      ...todoSpec,
      screens: [
        {
          ...todoSpec.screens[0]!,
          elements: todoSpec.screens[0]!.elements.map((e) =>
            e.id === 'destroy' ? { ...e, sourceSelector: 'ul.todo-list button.destroy' } : e,
          ),
        },
      ],
    }
    const r = await executeBehavior(
      browser!,
      baseUrl,
      skipping,
      {
        ...behavior([
          { op: 'tap', element: 'destroy', text: 'Second todo' },
          { op: 'expectCount', element: 'todo-label', count: 2 },
          { op: 'expectText', element: 'todo-label', text: 'First todo', exact: true },
          { op: 'expectText', element: 'todo-list', text: 'Third todo', exact: false },
        ]),
        screen: 'todos',
      },
      undefined,
      () => {},
    )
    expect(r.ok, r.error).toBe(true)
  }, 30_000)

  it('types into the input inside a wrapper that carries the test id', async () => {
    const r = await executeBehavior(
      browser!,
      baseUrl,
      todoSpec,
      {
        ...behavior([
          { op: 'type', element: 'search', text: 'milk' },
          { op: 'expectText', element: 'search', text: 'milk', exact: true },
        ]),
        screen: 'todos',
      },
      undefined,
      () => {},
    )
    expect(r.ok, r.error).toBe(true)
  }, 30_000)

  it('leaves a screenshot and an element summary behind when a step fails', async () => {
    const failureDir = mkdtempSync(join(tmpdir(), 'mpf-failures-'))
    const r = await executeBehavior(
      browser!,
      baseUrl,
      todoSpec,
      {
        ...behavior([
          { op: 'expectCount', element: 'todo-label', count: 3 },
          { op: 'tap', element: 'todo-label', text: 'Nowhere todo' },
        ]),
        screen: 'todos',
      },
      undefined,
      () => {},
      45_000,
      { failureDir },
    )
    expect(r.ok).toBe(false)
    expect(r.evidence?.join('\n')).toMatch(/todo-label: no element on the page matches it/)
    expect(r.artifacts?.[0]).toMatch(/B-\d+-step-2\.png$/)
    expect(existsSync(r.artifacts![0]!)).toBe(true)
    const shown = await executeBehavior(
      browser!,
      baseUrl,
      todoSpec,
      { ...behavior([{ op: 'expectHidden', element: 'new-todo' }]), screen: 'todos' },
      undefined,
      () => {},
      45_000,
      { failureDir },
    )
    expect(shown.ok).toBe(false)
    expect(shown.evidence?.join('\n')).toMatch(
      /new-todo: 1 match\(es\); first is <input> \d+x\d+ at \d+,\d+, visible/,
    )
    expect(readdirSync(failureDir).length).toBeGreaterThanOrEqual(2)
  }, 30_000)

  it('counts every element a repeated selector matches, not only the first', async () => {
    const r = await executeBehavior(
      browser!,
      baseUrl,
      todoSpec,
      { ...behavior([{ op: 'expectCount', element: 'todo-label', count: 3 }]), screen: 'todos' },
      undefined,
      () => {},
    )
    expect(r.ok, r.error).toBe(true)
  }, 30_000)

  it('clicks a hover-only row control and opens an editor with a double tap', async () => {
    const r = await executeBehavior(
      browser!,
      baseUrl,
      todoSpec,
      {
        ...behavior([
          { op: 'tap', element: 'destroy', text: 'Second todo' },
          { op: 'expectCount', element: 'todo-label', count: 2 },
          { op: 'doubleTap', element: 'todo-label', text: 'Third todo' },
          { op: 'expectVisible', element: 'edit-input' },
          { op: 'expectText', element: 'edit-input', text: 'Third todo', exact: true },
        ]),
        screen: 'todos',
      },
      undefined,
      () => {},
    )
    expect(r.ok, r.error).toBe(true)
  }, 30_000)

  it('narrows a descendant selector by the row text when the control itself has none', async () => {
    const page = await browser!.newPage()
    await page.goto(`${baseUrl}todo`)
    const second = await resolveElement(page, todoSpec, 'row-toggle', 'Second todo')
    expect(second).toBeDefined()
    await second!.check()
    expect(await page.locator('ul.todo-list li').nth(1).locator('input.toggle').isChecked()).toBe(
      true,
    )
    expect(await page.locator('ul.todo-list li').nth(2).locator('input.toggle').isChecked()).toBe(
      false,
    )
    await page.close()
  }, 30_000)

  it('submits a typed text that ends with a newline by pressing Enter', async () => {
    const r = await executeBehavior(
      browser!,
      baseUrl,
      todoSpec,
      {
        ...behavior([
          { op: 'type', element: 'new-todo', text: 'Fourth todo\n' },
          { op: 'expectText', element: 'todo-label', text: 'Fourth todo', exact: true },
          { op: 'expectCount', element: 'todo-list', count: 4 },
        ]),
        screen: 'todos',
      },
      undefined,
      () => {},
    )
    expect(r.ok, r.error).toBe(true)
  }, 30_000)

  it('runs a behavior on a hookless app through its selectors', async () => {
    const result = await executeBehavior(
      browser!,
      baseUrl,
      todoSpec,
      {
        ...behavior([
          { op: 'type', element: 'new-todo', text: 'Buy milk' },
          { op: 'expectText', element: 'new-todo', text: 'Buy milk', exact: true },
          { op: 'expectCount', element: 'todo-list', count: 3 },
          { op: 'tap', element: 'clear-completed' },
          { op: 'expectCount', element: 'todo-list', count: 2 },
          // The completed first row is gone; the selector now lands on the second.
          { op: 'expectText', element: 'todo-label', text: 'Second todo', exact: true },
        ]),
        screen: 'todos',
      },
      undefined,
      log,
    )
    expect(result).toEqual({ ok: true })
  }, 30_000)
})
