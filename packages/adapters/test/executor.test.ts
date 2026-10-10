import { createServer, type Server } from 'node:http'
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
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(pageHtml)
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
})
