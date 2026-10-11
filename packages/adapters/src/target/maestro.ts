import type { AppSpec, Behavior, Element } from '@mpf/core'

/** Test id every scaffold puts on its root view (`AppRoot` on iOS and Android, `#app` on the web). */
export const ROOT_TEST_ID = 'mpf-root'

export interface MaestroOptions {
  /** Android application id or iOS bundle id. */
  appId: string
  /** Base for deep links to screens: `<base>/<screenId>` (e.g. `mpf://app.mpf.counter`). */
  deepLinkBase: string
  /** Intent-extra / launch-argument name that seeds persisted state in debug builds. */
  seedArgument: string
  /**
   * How flows reach a screen. `deep-link` opens `<scheme>://<id>` (Android). `launch-argument`
   * relaunches the app with `routeArgument=<id>` (iOS, where external URL opens show a system prompt).
   */
  navigation?: 'deep-link' | 'launch-argument' | 'none'
  routeArgument?: string
  /** Screenshot name (Maestro writes `<name>.png` in its working directory) taken when the flow ends. */
  screenshotPath?: string
  /**
   * Test hooks the source app exposes (from the inventory). In `none` mode an element whose
   * testId matches none of them is matched by its text where the step allows it, otherwise the
   * behavior is unverifiable on the source.
   */
  sourceHooks?: string[]
  /** The app's platform, for the system back affordance when an edge is "back" and nothing is hooked. */
  platform?: 'ios' | 'android'
}

export interface CompiledMaestro {
  yaml: string
  unverifiable?: string
}

/**
 * Compile one behavior into a Maestro flow. Elements are matched by their AppSpec
 * testId, which the generated app exposes as a resource id (Compose testTag with
 * testTagsAsResourceId, or accessibilityIdentifier on iOS).
 */
/** Maestro's pointer gestures; a behavior's tap, doubleTap, and longPress steps map onto them one to one. */
type Gesture = 'tapOn' | 'doubleTapOn' | 'longPressOn'

export function compileMaestroFlow(
  spec: AppSpec,
  behavior: Behavior,
  opts: MaestroOptions,
): CompiledMaestro {
  const elements = new Map<string, Element>(
    spec.screens.flatMap((s) => s.elements.map((e) => [e.id, e] as const)),
  )
  const lines: string[] = [
    `appId: ${opts.appId}`,
    `name: ${yamlString(`${behavior.id} ${behavior.title}`)}`,
    '---',
  ]
  const unverifiable: string[] = []
  const firstOp = behavior.steps[0]?.op
  // Maestro matches ids as regular expressions; a templated id (`line-total-<SKU>`) becomes a prefix match.
  const idOf = (elementId: string): string => {
    const el = elements.get(elementId)
    if (!el) throw new Error(`unknown element ${elementId}`)
    return el.testId.replace(/[<{][^>}]*[>}]/g, '.*')
  }
  const kindOf = (elementId: string): Element['kind'] | undefined => elements.get(elementId)?.kind
  const unhooked = (elementId: string): CompiledMaestro => {
    unverifiable.push(`${elementId} has no test hook in the source app`)
    return { yaml: '', unverifiable: unverifiable.join('; ') }
  }
  /**
   * Selector lines for an element by id. With a text qualifier the match is the node whose
   * descendants carry that text: rows of a list share one id and the text sits on a child.
   */
  const selector = (id: string, text: string | undefined, indent: string): string[] => [
    `${indent}id: ${yamlString(id)}`,
    ...(text === undefined
      ? []
      : [
          `${indent}containsDescendants:`,
          `${indent}  - text: ${yamlString(`.*${escapeRegex(text)}.*`)}`,
        ]),
  ]
  /**
   * Put the keyboard away after typing. On Android Maestro's hideKeyboard is an unconditional BACK
   * key press, which leaves a single-activity app when the keyboard is already closed (an Enter
   * that committed the field closes it), so it runs only while an input method is on screen. iOS
   * often has no standard dismiss action (number pads have no Return key); a keyboard that stays
   * up is not a failure there, the next tap or assertion decides.
   */
  const dismissKeyboard = (): string[] =>
    opts.platform === 'android'
      ? [
          '- runFlow:',
          '    when:',
          '      visible:',
          '        id: ".*inputmethod.*"',
          '    commands:',
          '      - hideKeyboard',
        ]
      : ['- hideKeyboard:', '    optional: true']
  /** Lists and forms scroll; bring the target on screen first (a no-op when it is already visible). */
  const reveal = (id: string, text?: string): string[] => [
    `- scrollUntilVisible:`,
    `    element:`,
    ...selector(id, text, '      '),
    `    direction: DOWN`,
    `    timeout: 4000`,
    `    optional: true`,
  ]
  /** Reveal and tap an element by id, narrowed to the one whose text matches when the step says so. */
  /**
   * Tap by id, or by id plus visible text when rows share the id. iOS flattens a row's labels onto
   * the row node while Android keeps them on children, so a qualified tap tries the direct match
   * first and the descendant match when the direct one is not on screen (the same pair the text
   * assertions use).
   */
  const tapById = (id: string, text?: string, gesture: Gesture = 'tapOn'): string[] => {
    if (text === undefined) return [...reveal(id), `- ${gesture}:`, `    id: ${yamlString(id)}`]
    const pattern = yamlString(`.*${escapeRegex(text)}.*`)
    const q = yamlString(id)
    // Probe first, act once. The shapes, nearest match first: the node that carries the text
    // itself (iOS flattens a row's labels onto the row), the node with the text on a descendant (an
    // Android row container), and the control nearest to the text on its left or right (a Compose
    // checkbox or delete button sits beside the row's label). The probes run before any tap
    // because a tap changes the screen (a double tap swaps a label for an editor), and a chain of
    // "if visible then tap" branches evaluated in sequence would fire a second time afterwards.
    const probe = (shape: string, selector: string[]): string[] => [
      `- runFlow:`,
      `    when:`,
      `      true: "\${output.mpfTap == ''}"`,
      `      visible:`,
      ...selector.map((l) => `        ${l}`),
      `    commands:`,
      `      - evalScript: \${output.mpfTap = '${shape}'}`,
    ]
    const act = (shape: string, selector: string[]): string[] => [
      `- runFlow:`,
      `    when:`,
      `      true: "\${output.mpfTap == '${shape}'}"`,
      `    commands:`,
      `      - ${gesture}:`,
      ...selector.map((l) => `          ${l}`),
    ]
    const direct = [`id: ${q}`, `text: ${pattern}`]
    const descendant = [`id: ${q}`, `containsDescendants:`, `  - text: ${pattern}`]
    const left = [`id: ${q}`, `leftOf:`, `  text: ${pattern}`]
    const right = [`id: ${q}`, `rightOf:`, `  text: ${pattern}`]
    return [
      // The row's text is what has to be on screen; the scroll looks for it, not for the control.
      ...revealText(`.*${escapeRegex(text)}.*`),
      `- evalScript: \${output.mpfTap = ''}`,
      ...probe('text', direct),
      ...probe('descendant', descendant),
      ...probe('left', left),
      ...act('text', direct),
      ...act('descendant', descendant),
      ...act('left', left),
      ...act('', right),
    ]
  }
  const byArgument = opts.navigation === 'launch-argument'
  // A source app has no factory conventions: no deep links, no route argument, no seed extra.
  const sourceApp = opts.navigation === 'none'
  const routeArg = opts.routeArgument ?? 'mpf_route'
  /** Open a screen: via deep link, or by relaunching with the route argument (state kept). */
  const goto = (screenId: string, extra: string[] = [], clearState = false): string[] =>
    byArgument
      ? [
          '- launchApp:',
          `    clearState: ${clearState}`,
          '    arguments:',
          `      ${routeArg}: ${yamlString(screenId)}`,
          ...extra,
        ]
      : [
          ...(clearState ? ['- launchApp:', '    clearState: true'] : []),
          `- openLink: ${opts.deepLinkBase}/${screenId}`,
        ]
  // The screen the user is on, kept in step with every navigation and with taps that trigger an
  // AppSpec edge, so a restart relaunches where the user was. A target app opens on the behavior's
  // screen. Source apps have no factory hooks: screens are reached by tapping along the edges from
  // the root, an empty seed is a clean launch, and anything else stays unverifiable.
  let current = sourceApp ? rootScreenOf(spec) : behavior.screen
  const hooked = sourceApp && opts.sourceHooks ? hookMatcher(opts.sourceHooks) : () => true
  const isHooked = (elementId: string): boolean => {
    const el = elements.get(elementId)
    return !!el && hooked(el.testId)
  }
  /**
   * A literal text a matcher can find on screen: the spec's sourceSelector when it is plain text
   * (the visible label a mobile spec gives an unhooked element; a CSS selector means nothing to
   * Maestro), else a short label (no prose, no parentheticals).
   */
  const labelText = (elementId: string): string | undefined => {
    const el = elements.get(elementId)
    const selector = el?.sourceSelector?.trim()
    if (selector && !/[.#[\]>:=]/.test(selector)) return selector
    const label = el?.label?.trim()
    return label && label.length <= 40 && !/[()[\]{}:;]/.test(label) ? label : undefined
  }
  const revealText = (text: string): string[] => [
    `- scrollUntilVisible:`,
    `    element:`,
    `      text: ${yamlString(text)}`,
    `    direction: DOWN`,
    `    timeout: 4000`,
    `    optional: true`,
  ]
  /**
   * Tap an element on the source app: by hook when it has one (narrowed by the step's text, as on
   * a target), else by the text the step names, else by a literal label.
   */
  const sourceTap = (
    elementId: string,
    text?: string,
    gesture: Gesture = 'tapOn',
  ): string[] | undefined => {
    if (isHooked(elementId)) return tapById(idOf(elementId), text, gesture)
    let pattern: string | undefined
    if (text !== undefined) pattern = `(?i).*${escapeRegex(text)}.*`
    else {
      const label = labelText(elementId)
      if (label) pattern = `(?i)${escapeRegex(label)}`
    }
    if (!pattern) return undefined
    return [...revealText(pattern), `- ${gesture}:`, `    text: ${yamlString(pattern)}`]
  }
  /** Screens visited so far, so a return trip prefers the back affordance over a forward edge. */
  const history: string[] = []
  /** A back affordance, not a forward action that happens to "pop back": the word back as a control, or an element named or labelled back. */
  const backLike = (trigger: string, elementId?: string): boolean =>
    trigger === 'back' ||
    /\bback\s+(button|arrow|chevron|affordance|gesture|item|control)\b/i.test(trigger) ||
    /\b(navigation|nav|system|hardware)\s+back\b/i.test(trigger) ||
    /\b(swipe|swipes|go|goes|tap|taps|press|presses)\s+back\b/i.test(trigger) ||
    (!!elementId &&
      /\bback\b/i.test(
        `${elementId.replace(/[-_]/g, ' ')} ${elements.get(elementId)?.label ?? ''}`,
      ))
  /** The platform's own back affordance: the Android back action, the iOS navigation-bar back button. */
  const platformBack = (): string[] | undefined =>
    opts.platform === 'android'
      ? ['- back']
      : opts.platform === 'ios'
        ? ['- tapOn:', '    id: "BackButton"']
        : undefined
  const hopTaps = (hop: NavigationHop): string[] | undefined => {
    const elementId = triggerElement(spec, elements, hop.from, hop.trigger)
    if (elementId) {
      const tap = sourceTap(elementId)
      if (tap) return tap
      if (backLike(hop.trigger, elementId)) return platformBack()
      unverifiable.push(
        `${elementId} (edge ${hop.from} -> ${hop.to}) has no test hook in the source`,
      )
      return undefined
    }
    if (backLike(hop.trigger)) return platformBack()
    unverifiable.push(
      `the edge ${hop.from} -> ${hop.to} names no element (trigger: ${hop.trigger.slice(0, 60)})`,
    )
    return undefined
  }
  const walkTo = (target: string): string[] | undefined => {
    if (target === current) return []
    let hops = navigationHops(spec, current, target)
    if (!hops) return undefined
    // Going back to where we came from: take the back edge when the spec has one, not a forward edge that may commit state.
    if (history.at(-1) === target) {
      const backEdge = spec.navigation.edges.find(
        (e) =>
          e.from === current &&
          e.to === target &&
          backLike(e.trigger, triggerElement(spec, elements, current, e.trigger)),
      )
      if (backEdge) hops = [{ from: current, to: target, trigger: backEdge.trigger }]
    }
    const taps: string[] = []
    for (const hop of hops) {
      const tap = hopTaps(hop)
      if (!tap) return undefined
      taps.push(...tap)
    }
    history.push(current)
    current = target
    return taps
  }
  /**
   * A tap on an element that triggers an edge moves the user; keep the tracker in step. Works in
   * every navigation mode, since it only needs the AppSpec edges.
   */
  const advance = (elementId: string): void => {
    const edge = spec.navigation.edges.find(
      (e) => e.from === current && triggerElement(spec, elements, current, e.trigger) === elementId,
    )
    if (edge && edge.to !== current) {
      history.push(current)
      current = edge.to
    }
  }
  if (sourceApp) {
    const blockers: string[] = []
    for (const [i, st] of behavior.steps.entries()) {
      if (st.op === 'openRoute') blockers.push('openRoute needs deep links')
      if (st.op === 'seed' && !(i === 0 && isEmptySeed(st.state)))
        blockers.push('seed needs the factory seed hook')
    }
    if (blockers.length) {
      unverifiable.push([...new Set(blockers)].join('; '))
      return { yaml: '', unverifiable: unverifiable.join('; ') }
    }
    lines.push('- launchApp:', '    clearState: true')
    // A leading `navigate` step says where the behavior starts; otherwise its screen does.
    const intro = firstOp === 'navigate' ? [] : walkTo(behavior.screen)
    if (!intro) {
      unverifiable.push(
        `no navigation path from ${rootScreenOf(spec)} to ${behavior.screen} in the AppSpec edges`,
      )
      return { yaml: '', unverifiable: unverifiable.join('; ') }
    }
    lines.push(...intro)
  }
  // Every flow starts from a clean install unless the behavior seeds explicitly.
  if (!sourceApp && firstOp !== 'seed') {
    if (firstOp === 'navigate' || firstOp === 'openRoute') {
      if (!byArgument) lines.push('- launchApp:', '    clearState: true')
    } else {
      lines.push(...goto(behavior.screen, [], true))
    }
  }
  for (const [index, step] of behavior.steps.entries()) {
    switch (step.op) {
      case 'navigate':
        if (sourceApp) {
          const taps = walkTo(step.screen)
          if (!taps) {
            unverifiable.push(
              `no navigation path from ${current} to ${step.screen} in the AppSpec edges`,
            )
            return { yaml: '', unverifiable: unverifiable.join('; ') }
          }
          lines.push(...taps)
          break
        }
        lines.push(...goto(step.screen, [], byArgument && index === 0))
        current = step.screen
        break
      case 'openRoute':
        lines.push(...goto(step.route, [], byArgument && index === 0))
        // An unknown route lands wherever the app's fallback goes; only a real screen moves the tracker.
        if (spec.screens.some((s) => s.id === step.route)) current = step.route
        break
      case 'seed':
        if (sourceApp) break // an empty leading seed: the clean launch already covered it
        if (byArgument) {
          lines.push(
            '- launchApp:',
            '    clearState: true',
            '    arguments:',
            `      ${opts.seedArgument}: ${yamlString(JSON.stringify(step.state))}`,
            `      ${routeArg}: ${yamlString(behavior.screen)}`,
          )
        } else {
          lines.push(
            '- launchApp:',
            '    clearState: true',
            '    arguments:',
            `      ${opts.seedArgument}: ${yamlString(JSON.stringify(step.state))}`,
          )
          lines.push(`- openLink: ${opts.deepLinkBase}/${behavior.screen}`)
        }
        current = behavior.screen
        break
      case 'tap':
      case 'doubleTap':
      case 'longPress': {
        const gesture: Gesture =
          step.op === 'tap' ? 'tapOn' : step.op === 'doubleTap' ? 'doubleTapOn' : 'longPressOn'
        if (sourceApp && !isHooked(step.element)) {
          const tap =
            sourceTap(step.element, step.text, gesture) ??
            (step.op === 'tap' && backLike(step.element, step.element) ? platformBack() : undefined)
          if (!tap) return unhooked(step.element)
          lines.push(...tap)
          advance(step.element)
          break
        }
        lines.push(...tapById(idOf(step.element), step.text, gesture))
        advance(step.element)
        break
      }
      case 'type':
        if (sourceApp && !isHooked(step.element)) return unhooked(step.element)
        lines.push(...reveal(idOf(step.element)))
        lines.push(`- tapOn:`, `    id: ${yamlString(idOf(step.element))}`)
        if (kindOf(step.element) === 'picker') {
          // A picker opens a list of options; choose the one whose label or value contains the text.
          lines.push(`- tapOn:`, `    text: ${yamlString(`(?i).*${escapeRegex(step.text)}.*`)}`)
          break
        }
        lines.push('- eraseText')
        lines.push(...inputLines(step.text))
        lines.push(...dismissKeyboard())
        break
      case 'select':
        if (sourceApp && !isHooked(step.element)) return unhooked(step.element)
        lines.push(...reveal(idOf(step.element)))
        lines.push(`- tapOn:`, `    id: ${yamlString(idOf(step.element))}`)
        lines.push(`- tapOn:`, `    text: ${yamlString(`(?i).*${escapeRegex(step.option)}.*`)}`)
        break
      case 'expectVisible': {
        if (sourceApp && !isHooked(step.element)) {
          const label = labelText(step.element)
          if (!label) return unhooked(step.element)
          const text = `(?i)${escapeRegex(label)}`
          lines.push(...revealText(text), `- assertVisible:`, `    text: ${yamlString(text)}`)
          break
        }
        lines.push(...reveal(idOf(step.element)))
        lines.push(`- assertVisible:`, `    id: ${yamlString(idOf(step.element))}`)
        break
      }
      case 'expectHidden': {
        if (sourceApp && !isHooked(step.element)) {
          const label = labelText(step.element)
          if (!label) return unhooked(step.element)
          lines.push(`- assertNotVisible:`, `    text: ${yamlString(`(?i)${escapeRegex(label)}`)}`)
          break
        }
        lines.push(`- assertNotVisible:`, `    id: ${yamlString(idOf(step.element))}`)
        break
      }
      case 'expectText': {
        const pattern = step.exact ? step.text : `.*${escapeRegex(step.text)}.*`
        if (sourceApp && !isHooked(step.element)) {
          // No hook to anchor on: the text itself has to be on screen.
          lines.push(...revealText(pattern), `- assertVisible:`, `    text: ${yamlString(pattern)}`)
          break
        }
        lines.push(...reveal(idOf(step.element)))
        lines.push(...expectText(idOf(step.element), pattern))
        break
      }
      case 'expectCount': {
        // Maestro cannot count, but a count is checkable as "row N-1 is on screen and row N is not":
        // with index-based row ids by id, otherwise with Maestro's `index` on the shared id (the
        // N-th match). Only a source app without a hook for the rows has nothing to select by.
        const prefix = rowPrefix(
          spec,
          elements.get(step.element) ? currentScreenOf(spec, step.element) : current,
          step.element,
        )
        if (prefix) {
          if (step.count > 0) {
            lines.push(...reveal(`${prefix}${step.count - 1}`))
            lines.push(`- assertVisible:`, `    id: ${yamlString(`${prefix}${step.count - 1}`)}`)
          }
          lines.push(`- assertNotVisible:`, `    id: ${yamlString(`${prefix}${step.count}`)}`)
          break
        }
        if (sourceApp && !isHooked(step.element)) {
          unverifiable.push(
            `expectCount on ${step.element} cannot be checked on the source app (rows carry no hook)`,
          )
          break
        }
        const id = idOf(step.element)
        if (step.count > 0) {
          lines.push(
            `- scrollUntilVisible:`,
            `    element:`,
            `      id: ${yamlString(id)}`,
            `      index: ${step.count - 1}`,
            `    direction: DOWN`,
            `    timeout: 4000`,
            `    optional: true`,
            `- assertVisible:`,
            `    id: ${yamlString(id)}`,
            `    index: ${step.count - 1}`,
          )
        }
        lines.push(`- assertNotVisible:`, `    id: ${yamlString(id)}`, `    index: ${step.count}`)
        break
      }
      case 'restart':
        // A target app is killed only once its root view is up: a launch seed or an edit made just
        // before has then been persisted (the scaffolds write seeds through before the first frame).
        if (!sourceApp) lines.push(...waitForRoot(RESTART_SETTLE_MS))
        lines.push('- stopApp')
        if (sourceApp) {
          // The app comes back on its root screen; walk to where the behavior lives again.
          lines.push('- launchApp:', '    clearState: false')
          const back = current
          current = rootScreenOf(spec)
          history.length = 0
          const taps = walkTo(back)
          if (!taps) {
            unverifiable.push(`no navigation path back to ${back} after a restart`)
            return { yaml: '', unverifiable: unverifiable.join('; ') }
          }
          lines.push(...taps)
        } else
          // Back where the user was: the behavior's screen unless a navigation or an edge tap moved them.
          lines.push(
            ...(byArgument
              ? goto(current)
              : [
                  '- launchApp:',
                  '    clearState: false',
                  `- openLink: ${opts.deepLinkBase}/${current}`,
                ]),
          )
        break
      case 'wait':
        lines.push(...pause(Math.max(100, step.ms)))
        break
      case 'swipe': {
        const direction = step.direction.toUpperCase()
        if (sourceApp && !isHooked(step.element)) {
          const label = labelText(step.element)
          if (!label) return unhooked(step.element)
          const text = `(?i)${escapeRegex(label)}`
          lines.push(
            ...revealText(text),
            `- swipe:`,
            `    from:`,
            `      text: ${yamlString(text)}`,
            `    direction: ${direction}`,
          )
          break
        }
        lines.push(...reveal(idOf(step.element)))
        lines.push(
          `- swipe:`,
          `    from:`,
          `      id: ${yamlString(idOf(step.element))}`,
          `    direction: ${direction}`,
        )
        break
      }
      case 'custom':
        unverifiable.push(`custom step: ${step.description}`)
        break
    }
  }
  if (opts.screenshotPath) lines.push(`- takeScreenshot: ${yamlString(opts.screenshotPath)}`)
  // Collapse consecutive identical navigation commands (seed + restart + navigate often target the same screen).
  const compact: string[] = []
  for (const line of lines) {
    if (line.startsWith('- openLink: ') && compact.at(-1) === line) continue
    compact.push(line)
  }
  return {
    yaml: `${compact.join('\n')}\n`,
    unverifiable: unverifiable.length ? unverifiable.join('; ') : undefined,
  }
}

/**
 * Assert that the element with `id` shows `text`. Native toolkits differ in where the text
 * lives: a Compose `Button` exposes its label on a child node while a `Text` or `TextField`
 * carries it directly, and iOS flattens both. Wait briefly for the direct match; when it never
 * appears, require the label on a descendant of the tagged node instead. Both forms fail the
 * flow if the text is genuinely absent.
 */
function expectText(id: string, text: string): string[] {
  return [
    `- extendedWaitUntil:`,
    `    visible:`,
    `      id: ${yamlString(id)}`,
    `      text: ${yamlString(text)}`,
    `    timeout: ${DIRECT_TEXT_WAIT_MS}`,
    `    optional: true`,
    `- runFlow:`,
    `    when:`,
    `      notVisible:`,
    `        id: ${yamlString(id)}`,
    `        text: ${yamlString(text)}`,
    `    commands:`,
    `      - assertVisible:`,
    `          id: ${yamlString(id)}`,
    `          containsDescendants:`,
    `            - text: ${yamlString(text)}`,
  ]
}

/** How long to wait for a label on the tagged node itself before checking its descendants. */
const DIRECT_TEXT_WAIT_MS = 4000

/** How long a restart gives the app to show its root view (and persist a seed) before the kill. */
const RESTART_SETTLE_MS = 10_000

/** Wait until the scaffold's root view is on screen (the flow fails if it never shows). */
/** A plain pause: wait the full timeout for an id that never appears; `optional` keeps the flow going. */
function pause(ms: number): string[] {
  return [
    `- extendedWaitUntil:`,
    `    visible:`,
    `      id: ${yamlString(`mpf-pause-${ms}`)}`,
    `    timeout: ${ms}`,
    `    optional: true`,
  ]
}

/** The screen an element belongs to. */
function currentScreenOf(spec: AppSpec, elementId: string): string {
  return (
    spec.screens.find((s) => s.elements.some((e) => e.id === elementId))?.id ?? spec.navigation.root
  )
}

/**
 * The id prefix of a list's index-based rows (`note-row-` for `note-row-0`, `note-row-1`, or
 * `note-row-<index>`), found among the elements of the list's screen. Undefined when the rows have
 * no index, so a count cannot be expressed.
 */
export function rowPrefix(spec: AppSpec, screenId: string, listId: string): string | undefined {
  const screen = spec.screens.find((s) => s.id === screenId)
  if (!screen) return undefined
  const prefixes = new Set<string>()
  for (const e of screen.elements) {
    if (e.id === listId) continue
    const templated = /^(.+?)[<{][^>}]*(?:index|idx|row|position|pos|i|n|arg)[^>}]*[>}]$/i.exec(
      e.testId,
    )
    if (templated) prefixes.add(templated[1]!)
    const numbered = /^(.+?)(\d+)$/.exec(e.testId)
    if (numbered) prefixes.add(numbered[1]!)
  }
  return prefixes.size === 1 ? [...prefixes][0] : undefined
}

function waitForRoot(timeoutMs: number): string[] {
  return [
    `- extendedWaitUntil:`,
    `    visible:`,
    `      id: ${yamlString(ROOT_TEST_ID)}`,
    `    timeout: ${timeoutMs}`,
  ]
}

function rootScreenOf(spec: AppSpec): string {
  return spec.navigation.root
}

/** A seed with no keys, or only empty containers, asks for the app's default state. */
function isEmptySeed(state: Record<string, unknown>): boolean {
  return Object.values(state).every(
    (v) =>
      v === null ||
      v === undefined ||
      (typeof v === 'object' && Object.keys(v as object).length === 0),
  )
}

/** Shortest list of trigger element ids that leads from one screen to another over the AppSpec edges. */
export function navigationPath(spec: AppSpec, from: string, to: string): string[] | undefined {
  return navigationHops(spec, from, to)?.map((h) => h.trigger)
}

export interface NavigationHop {
  from: string
  to: string
  trigger: string
}

/**
 * The element on `from` that an edge trigger names: the trigger itself when it is an element id,
 * else the longest element id of that screen the trigger mentions as a word (specs sometimes write
 * triggers as prose such as "Tap the `add-note` bar button").
 */
export function triggerElement(
  spec: AppSpec,
  elements: Map<string, Element>,
  from: string,
  trigger: string,
): string | undefined {
  if (elements.has(trigger)) return trigger
  const plain = (id: string) => id.replace(/[<{][^>}]*[>}]/g, '')
  const screen = spec.screens.find((s) => s.id === from)
  const candidates = (screen?.elements ?? []).map((e) => e.id).sort((a, b) => b.length - a.length)
  for (const id of candidates) {
    const stem = plain(id)
    if (stem && new RegExp(`(^|[^\\w-])${escapeRegex(stem)}($|[^\\w-])`).test(plain(trigger)))
      return id
  }
  return undefined
}

/** Does a testId match one of the hooks a source exposes? Placeholders (`<SKU>`, `\(row)`) match anything. */
export function hookMatcher(hooks: string[]): (testId: string) => boolean {
  // A placeholder stands for a value (an index, an id, a SKU: digits or an uppercase token) or another
  // placeholder, never for lowercase words, so `note-row-<row>` covers `note-row-0` and `row-<id>` covers
  // `row-MUG-01` but neither covers an invented `note-row-swipe-delete`.
  const value = '(?:<[^>]*>|\\{[^}]*\\}|[A-Z0-9][\\w-]*)'
  const patterns = hooks.map((h) => {
    const parts = h.split(/[<{][^>}]*[>}]/g).map(escapeRegex)
    return new RegExp(`^${parts.join(value)}$`)
  })
  return (testId) => patterns.some((re) => re.test(testId))
}

/** Shortest hop list (from, to, trigger) between two screens over the AppSpec edges. */
export function navigationHops(
  spec: AppSpec,
  from: string,
  to: string,
): NavigationHop[] | undefined {
  if (from === to) return []
  const prev = new Map<string, { screen: string; trigger: string }>()
  const queue = [from]
  const seen = new Set([from])
  while (queue.length) {
    const here = queue.shift()!
    for (const edge of spec.navigation.edges.filter((e) => e.from === here)) {
      if (seen.has(edge.to)) continue
      seen.add(edge.to)
      prev.set(edge.to, { screen: here, trigger: edge.trigger })
      if (edge.to === to) {
        const path: NavigationHop[] = []
        let at = to
        while (at !== from) {
          const step = prev.get(at)!
          path.unshift({ from: step.screen, to: at, trigger: step.trigger })
          at = step.screen
        }
        return path
      }
      queue.push(edge.to)
    }
  }
  return undefined
}

function yamlString(s: string): string {
  return JSON.stringify(s)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `inputText` types characters only: a newline inside the text is dropped on Android and unreliable
 * on iOS, so multi-line text is typed line by line with an Enter press between the lines.
 */
export function inputLines(text: string): string[] {
  const parts = text.split('\n')
  const out: string[] = []
  parts.forEach((part, i) => {
    if (part) out.push(`- inputText: ${yamlString(part)}`)
    if (i < parts.length - 1) out.push('- pressKey: Enter')
  })
  return out
}
