import { mkdirSync } from 'node:fs'
import { join } from 'pathe'
import type { Browser, Locator, Page } from 'playwright'
import type { AppSpec, Behavior, Element, Screen } from '@mpf/core'

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
export function rawRouteUrl(baseUrl: string, spec: AppSpec, route: string): string {
  if (route.startsWith('#') || route.startsWith('/')) return routeUrl(baseUrl, { route } as Screen)
  const sample =
    spec.screens.find((s) => s.id === spec.navigation.root)?.route ??
    spec.screens.find((s) => s.route)?.route ??
    '#/'
  return routeUrl(baseUrl, { route: sample.startsWith('#') ? `#/${route}` : `/${route}` } as Screen)
}

export function routeUrl(baseUrl: string, screen: Screen | undefined): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const route = screen?.route ?? '/'
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
 * Find an AppSpec element on the page, most specific strategy first. With `text`, only candidates
 * whose text content contains it count: rows of a list share one test id, and the step names the
 * row by what it shows.
 */
export async function resolveElement(
  page: Page,
  spec: AppSpec,
  elementId: string,
  text?: string,
): Promise<Locator | undefined> {
  const el = spec.screens.flatMap((s) => s.elements).find((e) => e.id === elementId)
  if (!el) return undefined
  const candidates: Locator[] = []
  if (el.testId) {
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
  const role = ROLE_BY_KIND[el.kind]
  if (el.label) {
    const loose = looseText(el.label)
    if (role)
      candidates.push(page.getByRole(role as Parameters<Page['getByRole']>[0], { name: loose }))
    candidates.push(page.getByLabel(loose))
    candidates.push(page.getByPlaceholder(loose))
    candidates.push(page.getByText(loose))
  }
  for (const [i, candidate] of candidates.entries()) {
    const c = text === undefined ? candidate : candidate.filter({ hasText: text })
    try {
      if (i === 0)
        await c
          .first()
          .waitFor({ state: 'attached', timeout: 1500 })
          .catch(() => {})
      if ((await c.count()) > 0) return c.first()
    } catch {
      /* try next */
    }
  }
  return undefined
}

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
): Promise<StepResult> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const screenOf = (id: string) => spec.screens.find((s) => s.id === id)
  const deadline = new Promise<StepResult>((resolve) =>
    setTimeout(() => resolve({ ok: false, error: `timed out after ${timeoutMs} ms` }), timeoutMs),
  )
  const work = (async (): Promise<StepResult> => {
    let navigated = false
    const notes: string[] = []
    const goto = async (screenId: string) => {
      await page.goto(routeUrl(baseUrl, screenOf(screenId)), { waitUntil: 'load' })
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
      navigated = true
    }
    const first = behavior.steps[0]?.op
    if (first !== 'navigate' && first !== 'openRoute' && first !== 'seed')
      await goto(behavior.screen)
    for (const [i, step] of behavior.steps.entries()) {
      const at = `step ${i + 1} (${step.op})`
      try {
        switch (step.op) {
          case 'navigate':
            await goto(step.screen)
            break
          case 'openRoute':
            await page.goto(rawRouteUrl(baseUrl, spec, step.route), { waitUntil: 'load' })
            await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
            navigated = true
            break
          case 'seed': {
            if (!navigated) await goto(behavior.screen)
            await page.evaluate((state: Record<string, unknown>) => {
              for (const [k, v] of Object.entries(state))
                localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v))
            }, step.state)
            await page.reload({ waitUntil: 'load' })
            break
          }
          case 'tap': {
            const loc = await need(page, spec, step.element, at, step.text)
            await loc.click({ timeout: 5000 })
            break
          }
          case 'type': {
            const loc = await need(page, spec, step.element, at)
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
            try {
              await loc.fill(step.text, { timeout: 5000 })
            } catch {
              await loc.click({ timeout: 3000 })
              await page.keyboard.type(step.text)
            }
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
            const read = () => visibleText(loc)
            const ok = await poll(async () => {
              const text = (await read()).trim()
              return step.exact
                ? text === step.text
                : text.toLowerCase().includes(step.text.toLowerCase())
            })
            if (!ok) {
              const actual = await read().catch(() => '')
              throw new Error(
                `expected "${step.text}" on ${step.element}, saw "${actual.slice(0, 80)}"`,
              )
            }
            break
          }
          case 'expectCount': {
            // Either N elements carry the id, or one container carries it and holds N rows/items.
            const loc = await resolveElement(page, spec, step.element)
            let seen = 0
            const ok = await poll(async () => {
              const matches = loc ? await loc.count() : 0
              seen = matches
              if (matches === step.count) return true
              if (matches !== 1) return false
              const children = await loc!
                .evaluate((el) => {
                  const rows = el.querySelectorAll(
                    ':scope > tbody > tr, :scope > tr, :scope > li, :scope > *',
                  )
                  const trs = el.querySelectorAll(':scope > tbody > tr, :scope > tr')
                  const lis = el.querySelectorAll(':scope > li')
                  return trs.length || lis.length || rows.length
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
        return {
          ok: false,
          error: `${at}: ${(err as Error).message.split('\n')[0]}`,
          notes: notes.length ? notes : undefined,
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
async function visibleText(loc: Locator): Promise<string> {
  const tag = await loc
    .evaluate((el) => el.tagName.toLowerCase(), undefined, { timeout: 2000 })
    .catch(() => '')
  if (tag === 'input' || tag === 'textarea' || tag === 'select')
    return loc.inputValue({ timeout: 2000 }).catch(() => '')
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
