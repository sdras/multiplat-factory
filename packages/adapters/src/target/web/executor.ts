import { mkdirSync } from 'node:fs'
import { startScreenOf } from '../start-screen.ts'
import { join } from 'pathe'
import type { Browser, Locator, Page } from 'playwright'
import type { AppSpec, Behavior, Element, Screen } from '@mpf/core'
import { concreteRoute, routeParameter } from '@mpf/core'

export type Log = (message: string) => void

/** Launch headless Chromium; fails with an actionable message when the browser is not installed. */
export async function launchChromium(): Promise<Browser> {
  const { chromium } = await import('playwright')
  try {
    return await chromium.launch({ headless: true })
  } catch (err) {
    const msg = (err as Error).message
    if (/Executable doesn't exist|browserType.launch/.test(msg)) {
      throw new Error(
        'Playwright Chromium is not installed; run `npx playwright install chromium`',
        { cause: err },
      )
    }
    throw err
  }
}

/**
 * URL for a raw route id that may not be a screen (fallback tests). A literal hash or path is
 * used as is; a bare id follows the app's own route style (hash routes -> `#/<id>`, else `/<id>`).
 */
/** Placeholder a behavior writes where a value must differ on every run (a sign-up email). */
export const UNIQUE_PLACEHOLDER = '{{unique}}'

/** A short token no earlier run produced: time in base 36 plus two random characters. */
export function uniqueToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`
}

export function rawRouteUrl(baseUrl: string, spec: AppSpec, route: string): string {
  if (route.startsWith('#') || route.startsWith('/')) return routeUrl(baseUrl, { route } as Screen)
  const sample =
    spec.screens.find((s) => s.id === spec.navigation.root)?.route ??
    spec.screens.find((s) => s.route)?.route ??
    '#/'
  // Hash routing (`#/active`, or `/app#/active` under a sub-path) keeps the path and swaps the fragment.
  const hashAt = sample.indexOf('#')
  const raw = hashAt >= 0 ? `${sample.slice(0, hashAt)}#/${route}` : `/${route}`
  return routeUrl(baseUrl, { route: raw } as Screen)
}

export function routeUrl(baseUrl: string, screen: Screen | undefined): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  // A screen whose path varies (`/article/[slug]`) has no URL of its own: opening the pattern
  // literally lands on "Not found", so the behavior has to reach it through the UI instead.
  const param = routeParameter(screen?.route)
  if (param)
    throw new Error(
      `screen "${screen?.id}" has a parameterized route "${screen?.route}" (${param}); a behavior reaches it through the UI, not by navigating to it`,
    )
  const route = concreteRoute(screen?.route ?? '/')
  if (route.startsWith('#')) return `${base}${route}`
  if (route.startsWith('/')) return `${base}${route.slice(1)}`
  return `${base}${route}`
}

const ROLE_BY_KIND: Record<Element['kind'], string | undefined> = {
  button: 'button',
  link: 'link',
  input: 'textbox',
  toggle: 'checkbox',
  picker: 'combobox',
  slider: 'slider',
  list: 'list',
  image: 'img',
  text: undefined,
  chart: undefined,
  custom: undefined,
}

/**
 * Find an AppSpec element on the page, most specific strategy first: the test hooks, then the
 * spec's own mapping onto the original app's markup (`sourceSelector`, all a hookless web source
 * has), then the accessible name. With `text`, only candidates whose text content contains it
 * count: rows of a list share one test id, and the step names the row by what it shows.
 */
export async function resolveElement(
  page: Page,
  spec: AppSpec,
  elementId: string,
  text?: string,
): Promise<Locator | undefined> {
  const all = await resolveAll(page, spec, elementId, text)
  return all?.first()
}

/** Every element on the page that the spec element matches (repeated rows match many); undefined when none. */
export async function resolveAll(
  page: Page,
  spec: AppSpec,
  elementId: string,
  text?: string,
): Promise<Locator | undefined> {
  const all = spec.screens.flatMap((s) => s.elements)
  const el = all.find((e) => e.id === elementId)
  if (!el) return undefined
  const candidates: Locator[] = []
  // A mobile source's `sourceSelector` is the caption or content description its observe flows
  // match on the source app, never CSS: "Title" as a selector lands on the document's <title>.
  const selector = spec.source.platform === 'web' ? el.sourceSelector?.trim() : undefined
  // A hook the source reuses for several controls (TodoMVC React's `text-input` on both the new-todo
  // field and the inline editor) cannot identify one of them: when the spec scoped the element with
  // a selector, that selector is the only way to it, and a miss means the element is not there.
  const sharedHook = all.some((e) => e !== el && e.testId === el.testId)
  if (el.testId && !(selector && sharedHook)) {
    candidates.push(page.locator(`[data-testid="${css(el.testId)}"]`))
    candidates.push(page.locator(`[data-test="${css(el.testId)}"]`))
    candidates.push(page.locator(`#${css(el.testId)}`))
    candidates.push(page.locator(`[aria-label="${css(el.testId)}"]`))
    // Repeated rows get templated ids in specs (`line-total-<SKU>`); match the literal prefix.
    const prefix = testIdPrefix(el.testId)
    if (prefix) {
      candidates.push(page.locator(`[data-testid^="${css(prefix)}"]`))
      candidates.push(page.locator(`[data-test^="${css(prefix)}"]`))
    }
  }
  // Scoped to the body, so a type selector such as `title` cannot match inside <head>.
  if (selector) candidates.push(page.locator('body').locator(selector))
  const role = ROLE_BY_KIND[el.kind]
  if (el.label) {
    const loose = looseText(el.label)
    if (role)
      candidates.push(page.getByRole(role as Parameters<Page['getByRole']>[0], { name: loose }))
    candidates.push(page.getByLabel(loose))
    candidates.push(page.getByPlaceholder(loose))
    candidates.push(page.getByText(loose))
  }
  // Hookless apps: specs often lift a class name into the id (`.new-todo` becomes `new-todo`).
  if (el.testId) candidates.push(page.locator(`[class~="${css(el.testId)}"]`))
  for (const [i, candidate] of candidates.entries()) {
    const c = text === undefined ? candidate : candidate.filter({ hasText: text })
    try {
      if (i === 0)
        await c
          .first()
          .waitFor({ state: 'attached', timeout: 1500 })
          .catch(() => {})
      if ((await c.count()) > 0) return c
    } catch {
      /* try next */
    }
  }
  // A text qualifier on a leaf control (a row's checkbox or delete button) names the row, not the
  // control. The row is the tightest scope that carries the text, so it is tried first with the
  // selector's own last segment: `ul.todo-list button.destroy` narrowed by the list would match the
  // whole list's text and hand back its first button.
  if (text !== undefined) {
    const last = selector
      ?.split(/\s+(?![^[]*\])/)
      .filter(Boolean)
      .at(-1)
    for (const inner of [last ? page.locator(last) : undefined, ...candidates]) {
      if (!inner) continue
      const scoped = page.locator(ROW_SELECTOR, { hasText: text }).locator(inner)
      try {
        if ((await scoped.count()) > 0) return scoped
      } catch {
        /* try next */
      }
    }
  }
  // Then the ancestor part of a descendant selector, narrowed by the text.
  if (text !== undefined && selector) {
    const parts = selector.split(/\s+(?![^[]*\])/).filter(Boolean)
    for (let i = parts.length - 1; i >= 1; i--) {
      const scoped = page
        .locator(parts.slice(0, i).join(' '), { hasText: text })
        .locator(parts.slice(i).join(' '))
      try {
        if ((await scoped.count()) > 0) return scoped
      } catch {
        /* try a shorter ancestor */
      }
    }
  }
  return undefined
}

/** What a repeated row looks like in markup, for scoping a leaf control by the row's text. */
const ROW_SELECTOR = 'li, tr, [role="listitem"], [role="row"], article'

function css(v: string): string {
  return v.replace(/["\\]/g, '\\$&')
}

/** The literal part before a `<placeholder>` or `{placeholder}` in a templated test id, if any. */
export function testIdPrefix(testId: string): string | undefined {
  const i = testId.search(/[<{]/)
  if (i <= 0) return undefined
  return testId.slice(0, i)
}

/**
 * Case-insensitive matcher that tolerates the ways a spec worker normalizes text:
 * dash and quote variants, collapsed whitespace, and trailing punctuation.
 */
export function looseText(label: string): RegExp {
  const core = label
    .trim()
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/[.:!]+$/, '')
  const pattern = core
    .split(/\s+/)
    .map((word) =>
      word
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/[\u2013\u2014-]/g, '[\\u2013\\u2014-]')
        .replace(/[\u2018\u2019']/g, "[\\u2018\\u2019']")
        .replace(/[\u201C\u201D"]/g, '[\\u201C\\u201D"]'),
    )
    .join('\\s+')
  return new RegExp(pattern || label, 'i')
}

export interface StepResult {
  ok: boolean
  error?: string
  /** True when the behavior contains a step that cannot be checked automatically. */
  unverifiable?: boolean
  /** Custom steps that were skipped; the typed steps around them still ran and passed. */
  notes?: string[]
  /** What the page looked like at the failing step: the element's state and what covered it. */
  evidence?: string[]
  /** Files written for a failure (a screenshot), absolute paths. */
  artifacts?: string[]
}

/** Run one behavior in a fresh browser context against the source app. */
export async function executeBehavior(
  browser: Browser,
  baseUrl: string,
  spec: AppSpec,
  behavior: Behavior,
  screenshotPath: string | undefined,
  log: Log,
  timeoutMs = 45_000,
  opts: { failureDir?: string } = {},
): Promise<StepResult> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  // What a person would check first when a step fails: the browser's own errors.
  const browserErrors: string[] = []
  page.on('pageerror', (e) => browserErrors.push(`page error: ${firstLine(e.message)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') browserErrors.push(`console error: ${firstLine(m.text())}`)
  })
  const screenOf = (id: string) => spec.screens.find((s) => s.id === id)
  // `{{unique}}` in a typed or expected text becomes one fresh token for this flow run, so a flow
  // can sign up and then sign in with an identity no earlier run has taken on a shared backend.
  const unique = uniqueToken()
  const fill = (text: string) => text.replaceAll(UNIQUE_PLACEHOLDER, unique)
  const deadline = new Promise<StepResult>((resolve) =>
    setTimeout(() => resolve({ ok: false, error: `timed out after ${timeoutMs} ms` }), timeoutMs),
  )
  const work = (async (): Promise<StepResult> => {
    let navigated = false
    const notes: string[] = []
    /**
     * Open a URL the way a user reaches it: a change of hash on the page already open is a fragment
     * change (hash routing keeps in-memory state), anything else is a full navigation.
     */
    const open = async (url: string) => {
      const target = new URL(url)
      let here: URL | undefined
      try {
        here = new URL(page.url())
      } catch {
        here = undefined
      }
      const sameDocument =
        here !== undefined &&
        here.origin === target.origin &&
        here.pathname === target.pathname &&
        here.search === target.search &&
        (target.hash !== '' || here.hash !== '')
      if (sameDocument) {
        await page.evaluate((hash: string) => {
          // The page's window; this package compiles without the DOM lib.
          ;(globalThis as unknown as { location: { hash: string } }).location.hash = hash || '#'
        }, target.hash)
        await page.waitForTimeout(150)
        return
      }
      await page.goto(url, { waitUntil: 'load' })
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
    }
    const goto = async (screenId: string) => {
      await open(routeUrl(baseUrl, screenOf(screenId)))
      navigated = true
    }
    const first = behavior.steps[0]?.op
    const { screen: start, corrected } = startScreenOf(spec, behavior)
    if (corrected)
      log(
        `${behavior.id}: opens on ${start}; the behavior says ${corrected}, but its first step belongs there`,
      )
    if (first !== 'navigate' && first !== 'openRoute' && first !== 'seed') {
      try {
        await goto(start)
      } catch (err) {
        return {
          ok: false,
          error: `opening screen "${start}": ${(err as Error).message}`,
        }
      }
    }
    for (const [i, step] of behavior.steps.entries()) {
      const at = `step ${i + 1} (${step.op})`
      try {
        switch (step.op) {
          case 'navigate':
            await goto(step.screen)
            break
          case 'openRoute':
            await open(rawRouteUrl(baseUrl, spec, step.route))
            navigated = true
            break
          case 'seed': {
            if (!navigated) await goto(start)
            await page.evaluate((state: Record<string, unknown>) => {
              for (const [k, v] of Object.entries(state))
                localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v))
            }, step.state)
            await page.reload({ waitUntil: 'load' })
            break
          }
          case 'tap':
          case 'doubleTap':
          case 'longPress': {
            const loc = await need(page, spec, step.element, at, step.text && fill(step.text))
            await robustClick(page, loc, {
              clickCount: step.op === 'doubleTap' ? 2 : 1,
              // A held click is the web's press-and-hold: mouse down, a pause, mouse up.
              delay: step.op === 'longPress' ? 650 : undefined,
            })
            break
          }
          case 'type': {
            const loc = editableIn(await need(page, spec, step.element, at))
            const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
            if (tag === 'select') {
              // A select takes a choice, not keystrokes: match by value first, then by visible label.
              try {
                await loc.selectOption({ value: step.text }, { timeout: 5000 })
              } catch {
                await loc.selectOption({ label: step.text }, { timeout: 5000 })
              }
              break
            }
            // A trailing newline means "submit": fill the text, then press Enter (the way a user adds a todo).
            const submit = step.text.endsWith('\n')
            const typed = fill(submit ? step.text.replace(/\n$/, '') : step.text)
            try {
              await loc.fill(typed, { timeout: 5000 })
            } catch (fillErr) {
              // Say why the fill failed: the fallback click's timeout alone hides the real cause.
              try {
                await loc.click({ timeout: 3000 })
              } catch (clickErr) {
                throw new Error(
                  `could not type into ${step.element}: fill: ${firstLine((fillErr as Error).message)}; click: ${firstLine((clickErr as Error).message)}`,
                  { cause: clickErr },
                )
              }
              await page.keyboard.type(typed)
            }
            if (submit) await loc.press('Enter', { timeout: 3000 })
            break
          }
          case 'select': {
            const loc = await need(page, spec, step.element, at)
            const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
            if (tag === 'select') {
              try {
                await loc.selectOption({ value: step.option }, { timeout: 5000 })
              } catch {
                await loc.selectOption({ label: step.option }, { timeout: 5000 })
              }
            } else {
              // A custom picker: open it, then pick the option whose text or value matches.
              await loc.click({ timeout: 5000 })
              const option = page
                .getByRole('option', { name: looseText(step.option) })
                .or(page.getByText(looseText(step.option)))
                .or(page.locator(`[value="${css(step.option)}"]`))
              await option.first().click({ timeout: 5000 })
            }
            break
          }
          case 'expectVisible': {
            const loc = await need(page, spec, step.element, at)
            await loc.waitFor({ state: 'visible', timeout: 5000 })
            break
          }
          case 'expectHidden': {
            const loc = await resolveElement(page, spec, step.element)
            if (loc) await loc.waitFor({ state: 'hidden', timeout: 5000 })
            break
          }
          case 'expectText': {
            const loc = await need(page, spec, step.element, at)
            const want = fill(step.text)
            const read = () => visibleText(loc)
            const ok = await poll(async () => {
              const text = (await read()).trim()
              if (step.exact ? text === want : text.toLowerCase().includes(want.toLowerCase()))
                return true
              // Repeated elements (list rows): any one of them carrying the text satisfies the step,
              // the way the Maestro side matches a descendant.
              const any = await resolveElement(page, spec, step.element, want)
              if (!any) return false
              const candidate = (await visibleText(any)).trim()
              return step.exact ? candidate === want : true
            })
            if (!ok) {
              const actual = await read().catch(() => '')
              throw new Error(`expected "${want}" on ${step.element}, saw "${actual.slice(0, 80)}"`)
            }
            break
          }
          case 'expectCount': {
            // Either N elements carry the id, or one container carries it and holds N rows/items.
            let loc = await resolveAll(page, spec, step.element)
            let seen = 0
            const ok = await poll(async () => {
              // Rows that render a moment after the previous step are not on the page at resolve time.
              loc ??= await resolveAll(page, spec, step.element)
              // A user counts what is on screen: rows a filter hides with `hidden` or CSS stay in
              // the DOM (Svelte's TodoMVC keeps every todo mounted) but are not there to count.
              const matches = loc ? await loc.filter({ visible: true }).count() : 0
              seen = matches
              if (matches === step.count) return true
              if (matches !== 1) return false
              const children = await loc!
                .first()
                .evaluate((el) => {
                  // Structural types only: this package compiles without the DOM lib.
                  const shown = (nodes: ArrayLike<unknown>) =>
                    Array.from(nodes as ArrayLike<{ offsetParent: unknown }>).filter(
                      (n) => n.offsetParent !== null,
                    ).length
                  const rows = el.querySelectorAll(
                    ':scope > tbody > tr, :scope > tr, :scope > li, :scope > *',
                  )
                  const trs = el.querySelectorAll(':scope > tbody > tr, :scope > tr')
                  const lis = el.querySelectorAll(':scope > li')
                  return shown(trs) || shown(lis) || shown(rows)
                })
                .catch(() => 0)
              seen = children
              return children === step.count
            })
            if (!ok) throw new Error(`expected ${step.count} of ${step.element}, saw ${seen}`)
            break
          }
          case 'restart':
            await page.reload({ waitUntil: 'load' })
            await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
            break
          case 'wait':
            await page.waitForTimeout(step.ms)
            break
          case 'swipe':
            // No pointer gesture on the web; the port exposes the same action as a control the following steps use.
            notes.push(
              `${at} skipped: swipe ${step.direction} on ${step.element} has no web gesture`,
            )
            break
          case 'custom':
            // Not checkable here; the typed steps before and after it still count.
            notes.push(`${at} skipped: ${step.description}`)
            break
        }
      } catch (err) {
        // The fix worker gets what a person would look at: the page and the element's state.
        const failure = await failureEvidence(page, spec, {
          element: 'element' in step ? step.element : undefined,
          qualifier: step.op === 'tap' && step.text ? fill(step.text) : undefined,
          file: `${behavior.id}-step-${i + 1}.png`,
          failureDir: opts.failureDir,
          browserErrors,
        })
        return {
          ok: false,
          error: `${at}: ${(err as Error).message.split('\n')[0]}`,
          notes: notes.length ? notes : undefined,
          ...failure,
        }
      }
    }
    return { ok: true, notes: notes.length ? notes : undefined }
  })()
  try {
    const result = await Promise.race([work, deadline])
    if (screenshotPath) {
      mkdirSync(join(screenshotPath, '..'), { recursive: true })
      await page
        .screenshot({ path: screenshotPath, fullPage: false })
        .catch((e) => log(`screenshot failed: ${(e as Error).message}`))
    }
    return result
  } finally {
    await context.close().catch(() => {})
  }
}

/** Text a user sees: the value for form controls, the rendered text otherwise. */
/**
 * Click the way a user manages to: a control that only appears while its row is hovered (a row's
 * delete button) gets the row hovered first, a checkbox hidden behind its label gets the label
 * clicked, and as a last resort the click is forced at the element's position.
 */
async function robustClick(
  page: Page,
  loc: Locator,
  opts: { clickCount: number; delay?: number },
): Promise<void> {
  const click = (timeout: number, force = false) =>
    loc.click({ timeout, force, clickCount: opts.clickCount, delay: opts.delay })
  try {
    await click(2500)
    return
  } catch {
    /* fall through to the recovery steps */
  }
  const row = loc.locator(
    'xpath=ancestor::*[self::li or self::tr or @role="row" or @role="listitem"][1]',
  )
  if ((await row.count().catch(() => 0)) > 0) {
    await row
      .first()
      .hover({ timeout: 1500 })
      .catch(() => {})
    try {
      await click(2000)
      return
    } catch {
      /* next */
    }
  }
  const id = await loc.getAttribute('id', { timeout: 1000 }).catch(() => null)
  if (id && opts.clickCount === 1 && opts.delay === undefined) {
    const label = page.locator(`label[for="${css(id)}"]`)
    if ((await label.count().catch(() => 0)) > 0) {
      try {
        await label.first().click({ timeout: 2000 })
        return
      } catch {
        /* next */
      }
    }
  }
  await click(3000, true)
}

/**
 * The control to type into: the resolved element itself when it is one, else the first input,
 * textarea, select, or contenteditable inside it. Ports often carry the test id on a field's
 * wrapper (label, outlined box) rather than on the input, and filling a wrapper never works.
 */
function editableIn(loc: Locator): Locator {
  return loc
    .locator(
      'xpath=self::input | self::textarea | self::select | self::*[@contenteditable="true"] | .//input | .//textarea | .//select | .//*[@contenteditable="true"]',
    )
    .first()
}

/**
 * What the page looked like when a step failed: a screenshot, the browser's own errors, and for
 * the step's element how many nodes matched, whether the first is visible, enabled, and editable,
 * what sits at its center when something covers it, and whether the node was replaced between two
 * looks (a screen that re-renders on every tick defeats every fill and click). Mirrors the
 * hierarchy summary mobile flows get.
 */
async function failureEvidence(
  page: Page,
  spec: AppSpec,
  f: {
    element: string | undefined
    qualifier: string | undefined
    file: string
    failureDir: string | undefined
    browserErrors: string[]
  },
): Promise<{ evidence?: string[]; artifacts?: string[] }> {
  const evidence: string[] = []
  const artifacts: string[] = []
  if (f.failureDir) {
    try {
      mkdirSync(f.failureDir, { recursive: true })
      const file = join(f.failureDir, f.file)
      await page.screenshot({ path: file, timeout: 5000 })
      artifacts.push(file)
    } catch {
      /* a screenshot is a bonus */
    }
  }
  try {
    evidence.push(`url: ${page.url()}`)
    if (f.element) {
      const all = await resolveAll(page, spec, f.element, f.qualifier)
      const count = all ? await all.count() : 0
      if (!count) evidence.push(`${f.element}: no element on the page matches it`)
      else {
        const first = all!.first()
        const a = await first.evaluate(inspectElement)
        await page.waitForTimeout(300)
        const b = await all!
          .first()
          .evaluate(inspectElement)
          .catch(() => undefined)
        const visible = await first.isVisible().catch(() => false)
        evidence.push(
          `${f.element}: ${count} match(es); first is <${a.tag}> ${a.box}, ${visible ? 'visible' : 'not visible'}${a.disabled ? ', disabled' : ''}${a.readOnly ? ', read-only' : ''}${a.coveredBy ? `, covered by ${a.coveredBy}` : ''}${b && !b.seenBefore ? '; the node was replaced between two looks 300 ms apart (the screen re-renders)' : ''}`,
        )
      }
    }
    if (f.browserErrors.length) {
      const last = f.browserErrors.slice(-5)
      evidence.push(
        `browser errors (${f.browserErrors.length}${f.browserErrors.length > last.length ? ', last 5 shown' : ''}): ${last.join(' | ')}`,
      )
    }
  } catch (err) {
    evidence.push(`could not inspect the page: ${firstLine((err as Error).message)}`)
  }
  return {
    ...(evidence.length ? { evidence } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  }
}

/**
 * Runs in the page. Written without any inner function: `tsx` compiles with esbuild's keepNames,
 * which wraps nested functions in a `__name(...)` helper that does not exist inside the browser.
 */
function inspectElement(el: unknown): {
  tag: string
  box: string
  disabled: boolean
  readOnly: boolean
  coveredBy: string
  seenBefore: boolean
} {
  const h = el as ElementLike
  const r = h.getBoundingClientRect()
  const doc = (globalThis as unknown as { document: DocumentLike }).document
  const top = doc.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  let coveredBy = ''
  if (top && top !== h && !h.contains(top)) {
    const cls =
      typeof top.className === 'string'
        ? top.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
        : ''
    const testId = top.getAttribute('data-testid')
    coveredBy = `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}${testId ? `[data-testid=${testId}]` : ''}${cls ? `.${cls}` : ''}`
  }
  const seenBefore = h.__mpf === 1
  h.__mpf = 1
  return {
    tag: h.tagName.toLowerCase(),
    box: `${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.x)},${Math.round(r.y)}`,
    disabled: h.disabled === true,
    readOnly: h.readOnly === true,
    coveredBy,
    seenBefore,
  }
}

/** The handful of DOM shapes the evidence code touches; this package compiles without the DOM lib. */
interface DOMRectLike {
  x: number
  y: number
  width: number
  height: number
}
interface NodeLike {
  tagName: string
  id: string
  className: unknown
  getAttribute(name: string): string | null
  contains(other: NodeLike | null): boolean
}
interface ElementLike extends NodeLike {
  getBoundingClientRect(): DOMRectLike
  disabled?: boolean
  readOnly?: boolean
  __mpf?: number
}
interface DocumentLike {
  elementFromPoint(x: number, y: number): NodeLike | null
}

const firstLine = (m: string): string => m.split('\n')[0]?.slice(0, 160) ?? ''

async function visibleText(loc: Locator): Promise<string> {
  const tag = await loc
    .evaluate((el) => el.tagName.toLowerCase(), undefined, { timeout: 2000 })
    .catch(() => '')
  if (tag === 'input' || tag === 'textarea' || tag === 'select')
    return loc.inputValue({ timeout: 2000 }).catch(() => '')
  // A field whose test id sits on its wrapper: what the user reads there is the control's value.
  const inner = loc.locator('input, textarea, select').first()
  if ((await inner.count().catch(() => 0)) > 0)
    return inner.inputValue({ timeout: 2000 }).catch(() => '')
  return loc.innerText({ timeout: 2000 }).catch(() => '')
}

async function need(
  page: Page,
  spec: AppSpec,
  elementId: string,
  at: string,
  text?: string,
): Promise<Locator> {
  const loc = await resolveElement(page, spec, elementId, text)
  if (!loc) {
    const which = text === undefined ? '' : ` with text "${text}"`
    throw new Error(`${at}: element "${elementId}"${which} not found on the page`)
  }
  return loc
}

async function poll(check: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/** One screenshot per screen, in a fresh context. */
export async function screenshotScreens(
  browser: Browser,
  baseUrl: string,
  spec: AppSpec,
  outDir: string,
  log: Log,
): Promise<{ screenId: string; file: string }[]> {
  mkdirSync(outDir, { recursive: true })
  const out: { screenId: string; file: string }[] = []
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  try {
    for (const screen of spec.screens) {
      const file = join(outDir, `${screen.id}.png`)
      try {
        await page.goto(routeUrl(baseUrl, screen), { waitUntil: 'load', timeout: 15_000 })
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
        await page.screenshot({ path: file })
        out.push({ screenId: screen.id, file })
      } catch (err) {
        log(`screenshot of ${screen.id} failed: ${(err as Error).message.split('\n')[0]}`)
      }
    }
  } finally {
    await context.close().catch(() => {})
  }
  return out
}
