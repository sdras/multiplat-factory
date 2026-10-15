import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'pathe'
import type { TestCase } from '@mpf/core'

/** Where the adapters ask Maestro to write per-flow debug output, relative to the workspace. */
export const MAESTRO_DEBUG_DIR = 'maestro-debug'

export interface FlowEvidence {
  /** The 1-based BehaviorSpec step the failure belongs to, from the compiler's step markers. */
  failedStep?: number
  /** Workspace-relative paths a fix worker can open (screenshot first). */
  files: string[]
  /** One paragraph for the fix prompt: the failing step and what was on screen. */
  summary: string
}

interface HierarchyNode {
  attributes?: Record<string, string>
  children?: HierarchyNode[]
}

/**
 * Maestro writes `<debug dir>/<flow name>/{screenshots,screen-hierarchy,logs}` for each flow
 * that fails (and for optional assertions that warn). Pick the last failure of a flow and
 * describe the screen so the worker sees what the assertion saw.
 */
export function collectFlowEvidence(
  workspace: string,
  flowName: string,
  passDir?: string,
): FlowEvidence | undefined {
  // Only this pass's folder when the caller names it: an older pass's evidence for the same flow
  // would describe a different build and carry no step markers from the current compile.
  const root = passDir ?? join(workspace, MAESTRO_DEBUG_DIR)
  if (!existsSync(root)) return undefined
  const flowDir = findFlowDir(root, flowName)
  if (!flowDir) return undefined
  const hierarchyDir = join(flowDir, 'screen-hierarchy')
  const shotsDir = join(flowDir, 'screenshots')
  const hierarchies = existsSync(hierarchyDir)
    ? readdirSync(hierarchyDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : []
  const shots = existsSync(shotsDir)
    ? readdirSync(shotsDir)
        .filter((f) => /\.(png|jpg)$/i.test(f))
        .sort()
    : []
  const last = hierarchies.at(-1)
  const files: string[] = []
  const lines: string[] = []
  if (last) {
    const step = last.replace(/\.json$/, '').replace(/^step-\d+-/, '')
    lines.push(`Failing step: ${step}.`)
    files.push(relative(workspace, join(hierarchyDir, last)))
    try {
      lines.push(summarizeHierarchy(readFileSync(join(hierarchyDir, last), 'utf8')))
    } catch {
      lines.push('(hierarchy could not be parsed)')
    }
  }
  const shot = shots.at(-1)
  if (shot) files.unshift(relative(workspace, join(shotsDir, shot)))
  if (!files.length) return undefined
  const logs = join(flowDir, 'logs')
  let failedStep: number | undefined
  if (existsSync(logs)) {
    const log = readdirSync(logs).find((f) => f.endsWith('.log'))
    if (log) {
      const text = readFileSync(join(logs, log), 'utf8')
      const failure = text
        .split('\n')
        .filter((l) => /CommandFailed|Assertion is false|Element not found/.test(l))
        .at(-1)
      if (failure) lines.push(`Maestro: ${failure.replace(/^.*\] /, '').slice(0, 300)}`)
      // The compiler marks every BehaviorSpec step with `output.mpfStep = N`; the last marker that
      // completed is the step the failure belongs to.
      for (const m of text.matchAll(/output\.mpfStep = (\d+)\} COMPLETED/g))
        failedStep = Number(m[1])
      if (failedStep !== undefined) lines.push(`BehaviorSpec step: ${failedStep}.`)
    }
  }
  return { files, summary: lines.join('\n'), failedStep }
}

/**
 * With `--debug-output`, Maestro nests its files as `<root>/.maestro/tests/<timestamp>/<flow name>/`
 * (and the adapters add a per-pass folder above that). Search a few levels down, newest first.
 */
function findFlowDir(root: string, flowName: string): string | undefined {
  const first = flowName.split(' ')[0]!
  const matches = (name: string) =>
    name === flowName || name.startsWith(`${first} `) || name === first
  const walk = (dir: string, depth: number): string | undefined => {
    if (depth > 6 || !existsSync(dir)) return undefined
    const entries = readdirSync(dir)
      .filter((d) => statSync(join(dir, d)).isDirectory())
      .sort()
      .reverse()
    for (const d of entries) if (matches(d)) return join(dir, d)
    for (const d of entries) {
      const found = walk(join(dir, d), depth + 1)
      if (found) return found
    }
    return undefined
  }
  return walk(root, 0)
}

/** A screenshot a flow took by name (`takeScreenshot: <name>`), wherever Maestro filed it under the debug output. */
export function findNamedScreenshot(root: string, name: string): string | undefined {
  const walk = (dir: string, depth: number): string | undefined => {
    if (depth > 8 || !existsSync(dir)) return undefined
    const entries = readdirSync(dir).sort().reverse()
    for (const e of entries) {
      const p = join(dir, e)
      const st = statSync(p)
      if (st.isFile() && e === `${name}.png`) return p
      if (st.isDirectory()) {
        const found = walk(p, depth + 1)
        if (found) return found
      }
    }
    return undefined
  }
  return walk(root, 0)
}

/** Wording of the system dialogs that cover an app: ANR and crash dialogs, the "Open with" resolver, iOS "Open in". */
const DIALOG_TITLE =
  /isn'?t responding|Application Not Responding|keeps stopping|has stopped|^Open with\b|^Open in\b/i
const DIALOG_BUTTON = /^(Close app|Wait|Just once|Always|Open|Cancel|OK|App info)$/i

interface DialogOnScreen {
  title: string
  buttons: string[]
}

/**
 * A system dialog in the dump, by its wording: app dialogs reuse the same `android:id/alertTitle`
 * and button ids, so ids alone never count. The buttons come from the dialog's own window (its
 * activity content view, else the top-level window node) so the app's controls stay out of the line.
 */
function systemDialogIn(root: HierarchyNode): DialogOnScreen | undefined {
  interface TextNode {
    node: HierarchyNode
    text: string
    id: string
    path: HierarchyNode[]
  }
  const nodes: TextNode[] = []
  const collect = (n: HierarchyNode, path: HierarchyNode[]) => {
    const a = n.attributes ?? {}
    const text = (a.text ?? '').replace(/\s+/g, ' ').trim()
    if (text) nodes.push({ node: n, text, id: a['resource-id'] ?? '', path })
    for (const c of n.children ?? []) collect(c, [...path, n])
  }
  collect(root, [])
  const titled = nodes.find((n) => DIALOG_TITLE.test(n.text))
  const anchor =
    titled ??
    nodes.find((n) => /^android:id\/aerr_/.test(n.id)) ??
    nodes.find((n) => /^(Just once|Always)$/i.test(n.text))
  if (!anchor) return undefined
  const scope =
    [...anchor.path]
      .reverse()
      .find((p) => p.attributes?.['resource-id'] === 'android:id/content') ??
    anchor.path[1] ??
    anchor.path[0] ??
    root
  const inScope = (n: TextNode) => n.node === scope || n.path.includes(scope)
  const title =
    titled?.text ??
    nodes.find((n) => inScope(n) && n.id === 'android:id/alertTitle')?.text ??
    anchor.text
  const buttons = nodes
    .filter(
      (n) =>
        inScope(n) &&
        n.text !== title &&
        (n.node.attributes?.clickable === 'true' ||
          /^android:id\/(button[1-3]|aerr_[a-z_]+)$/.test(n.id) ||
          DIALOG_BUTTON.test(n.text)),
    )
    .map((n) => n.text)
  return { title, buttons: [...new Set(buttons)].slice(0, 6) }
}

/**
 * Compact description of a Maestro screen hierarchy: every node with a resource id or text,
 * with bounds, plus which system windows overlap the app (an edge-to-edge app whose header
 * sits under the status bar looks exactly like a control that ignores taps). System views
 * (`android:id/*`, `com.android.systemui:id/*`) are kept when they carry text, so a dialog's
 * title and buttons show up instead of an empty screen, and the line that opens the summary
 * names a system dialog or chooser when one covers the app.
 */
export function summarizeHierarchy(jsonText: string, limit = 40): string {
  const root = JSON.parse(jsonText) as HierarchyNode
  const app: string[] = []
  const system: string[] = []
  const walk = (n: HierarchyNode, inBar: boolean) => {
    const a = n.attributes ?? {}
    const id = a['resource-id'] ?? ''
    const text = (a.text ?? '').replace(/\s+/g, ' ').trim()
    const bounds = a.bounds ?? ''
    const isBar = /^com\.android\.systemui:id\/(status_bar|navigation_bar)/.test(id)
    const bar = inBar || isBar
    if (id || text) {
      const label =
        `${id ? `#${id}` : ''}${text ? ` "${text.slice(0, 40)}"` : ''} ${bounds}${a.clickable === 'true' ? ' clickable' : ''}`.trim()
      if (isBar) {
        if (/status_bar$|navigation_bar$|status_bar_container$/.test(id)) system.push(label)
      } else if (bar) {
        // the clock, icons, and buttons inside the bars are never what a flow was looking for
      } else if (/^(android|com\.android\.systemui):id\//.test(id)) {
        if (text) app.push(label)
      } else {
        app.push(label)
      }
    }
    for (const c of n.children ?? []) walk(c, bar)
  }
  walk(root, false)
  const out: string[] = []
  const dialog = systemDialogIn(root)
  if (dialog)
    out.push(
      `A system dialog covers the app: "${dialog.title}"${dialog.buttons.length ? ` (buttons: ${dialog.buttons.join(', ')})` : ''}`,
    )
  out.push(
    `On screen (${app.length} tagged or text nodes${app.length > limit ? `, first ${limit}` : ''}): ${app.slice(0, limit).join('; ') || 'nothing tagged'}`,
  )
  if (system.length)
    out.push(
      `System windows over the app: ${system.join('; ')} (taps inside these bounds never reach the app).`,
    )
  return out.join('\n')
}

/** Append the evidence for a failing flow case (matched by its Maestro flow name) to the case. */
export function attachFlowEvidence(workspace: string, c: TestCase, passDir?: string): void {
  const evidence =
    collectFlowEvidence(workspace, c.name, passDir) ??
    (c.behaviorId ? collectFlowEvidence(workspace, c.behaviorId, passDir) : undefined)
  if (!evidence) {
    if (passDir)
      c.message = [c.message, 'Maestro wrote no debug output for this flow in this pass.']
        .filter(Boolean)
        .join('\n')
    return
  }
  c.evidence = evidence.files
  c.message = [c.message, evidence.summary].filter(Boolean).join('\n')
  if (evidence.failedStep !== undefined) c.failedStep = evidence.failedStep
}
