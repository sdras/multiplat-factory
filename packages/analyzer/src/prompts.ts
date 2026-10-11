import type { AppSpec, BehaviorSpec, Detection, Inventory, Run, ToolchainReport } from '@mpf/core'
import type { Candidacy } from './candidacy.ts'
import { summarizeInventory } from './inventory.ts'

const SHARED_RULES = `You are one worker inside multiplat-factory, a tool that ports apps between web, iOS, and Android.
You work on whatever app you are given: any framework, any language, any size. Never assume a particular stack.
Read the source with the tools you have. Do not modify files. Do not guess when the code can tell you.
Your final answer must satisfy the JSON schema you were given; put everything of value in that structured output.`

export const SPEC_SYSTEM = `${SHARED_RULES}

Task: produce an AppSpec, a framework-neutral description of the app that another team could rebuild it from.

Rules:
- Enumerate every screen a user can reach (routes, tabs, modals, sheets, dialogs that carry their own content). Give each a stable kebab-case id.
- For each screen list the elements a user sees or touches. \`testId\` must be the existing test hook when one exists (data-testid, id, aria-label, accessibilityIdentifier, testTag, resource-id); otherwise propose a stable kebab-case value like \`screen-element\`. When the source has no hook for an element, set \`sourceSelector\` to how a test finds it on the original app (web: the most specific stable CSS selector in the source such as \`.new-todo\`, \`#toggle-all\`, \`button.clear-completed\`, or \`input[placeholder="What needs to be done?"]\`, never a generated or positional selector; mobile: exactly the text the element shows or its content description, such as \`Save\` or \`Open navigation drawer\`, never a description of where it sits or how it is found, and no sourceSelector at all for a container or icon without text) and still give it a stable testId, which every port adds as its own hook. Element ids are referenced by tests later, so keep them unique across the app. Give every element on a screen a distinct \`testId\`: when the source reuses one hook for two controls (one \`data-testid\` on both the new-item field and the inline editor), keep that hook in a \`sourceSelector\` scoped by an ancestor and invent distinct testIds for the port; a shared hook on its own cannot tell the two apart.
- \`route\` is the route as it appears in the URL or navigation graph, including a leading \`#\` when the app uses hash routing. A route is what a browser opens: a path, with its \`#\` prefix under hash routing, never a pattern with \`|\` alternatives or query placeholders (filters belong to the screen's elements, not its route). A path segment that varies is written \`[param]\` (\`/article/[slug]\`); such a screen cannot be opened by URL, so behaviors reach it through the UI.
- \`navigation.edges[].trigger\` is the id of the element on \`from\` that causes the transition (the button, link, or row), never a sentence; the platform back affordance is \`back\`. Flows are walked along these edges.
- \`state.persistence\` lists every stored key with its JSON shape and wire-format pins (date formats, id casing, enum strings) that a port must keep byte-compatible.
- \`logic\` lists units of non-UI logic. \`purity\` is \`pure\` only when the unit depends on nothing platform-specific (no DOM, UIKit, Android, network, clock, storage). \`coreCandidate\` is true for pure units worth sharing across platforms. \`loc\` is the unit's approximate line count.
- \`integrations\` names external services and platform capabilities; mark \`required\` false when the app works without them.
- \`unknowns\` lists anything you could not determine from the code.`

export const BEHAVIORS_SYSTEM = `${SHARED_RULES}

Task: produce a BehaviorSpec: the user-observable behaviors every port of this app must reproduce. This is the test contract.

Rules:
- Ids are B-001, B-002, … Every screen in the AppSpec gets at least one behavior. Aim for the smallest set that pins the app down: navigation, core state changes, validation, persistence across restart, and logic edge cases (limits, empty states). Size it to the app: roughly 3 to 5 behaviors per screen, merging closely related checks into one behavior with several steps rather than one behavior per assertion.
- \`priority\` must is for behaviors a user would call broken if missing; should is for polish.
- A behavior's \`screen\` is where its flow opens with a clean app, so its first step must touch an element of that screen; if the story starts elsewhere, set \`screen\` to that screen or begin with a \`navigate\` step.
- Steps use only the typed operations. \`element\` and \`screen\` values must be ids that exist in the AppSpec; never invent new ones. A screen whose route has a \`[param]\` (an article, a profile) cannot be opened directly: start the behavior on a screen with a concrete route and reach it by tapping the item that leads there; never set \`screen\` or \`navigate\` to such a screen. To leave a screen the way a user would, tap its back, close, or save element explicitly; a bare \`navigate\` walks the AppSpec edges from wherever the previous steps left the user (the back edge when returning), which may not be the path you mean. Prefer expectText with exact:false. To tap one of several rows that share a hook (list rows, repeated cards), give \`tap\` a \`text\` and the flow taps the row whose visible text contains it; never write a custom step for a tap. When row ids are positional (\`note-row-0\`, \`note-row-1\`), the index already picks the row, so tap the index that holds the note at that moment (lists that sort newest first move rows) and do not add \`text\`. A \`type\` text that ends with a newline (\\n) is submitted with Enter after typing, which is how a field without a button commits (adding a todo, searching); never write a custom step to press Enter. To move focus off a field (blur), tap another element; that is a typed step, not a custom one. To clear a field, \`type\` an empty text (""); to commit an empty field, type just a newline ("\\n"): both are typed steps. When the app keeps accounts on a live backend, a flow that needs a signed-in user signs up first in the same flow with an identity of its own: write \`{{unique}}\` inside the typed text (\`tester-{{unique}}@example.com\`, \`user-{{unique}}\`) and the same \`{{unique}}\` in any later expectation of it; it is replaced by a fresh token on every run, so no flow depends on an account already existing or on a previous flow having run. Use \`restart\` to prove persistence. Use \`select\` to choose an option in a dropdown or picker (by value or visible label). Use \`doubleTap\` where the app reacts to a double click or double tap (an inline editor that opens on double click) and \`longPress\` for press-and-hold actions (context menus, multi-select); a single \`tap\` does not open those. Use \`swipe\` (element plus direction) for gestures such as swipe-to-delete or dismiss instead of inventing a tappable element for the revealed action; on web the port exposes the same action as a visible control. Use \`openRoute\` with a raw route id (for example "nope") to test what the app does with an unrecognized route; every port maps route ids the same way. Reach state through the UI (taps, typing, restarts) whenever it takes only a few steps; use \`seed\` only for state the UI cannot produce in a dozen steps (tapping increment three times beats seeding count 3): a seeded behavior cannot be verified on the original app, and a behavior verified on the original is worth far more to the port. Use \`custom\` only when no typed step can express the check.
- \`evidence\` cites file:line for the code that implements the behavior.
- \`invariants\` records wire-format pins and intentional quirks that a port must keep even if they look odd.
- \`seedData\` is a state snapshot a test can load before a behavior runs, keyed by persisted key names from the AppSpec.`

export const PLAN_SYSTEM = `${SHARED_RULES}

Task: produce a PortPlan for the requested targets from the AppSpec and BehaviorSpec.

Rules:
- One TargetPlan per requested target and no others. Web targets use the requested web framework when given. iOS plans use SwiftUI unless the app needs UIKit-only capabilities; Android plans use Jetpack Compose in Kotlin.
- \`screenMap\` covers every AppSpec screen. \`persistenceMap\` keeps the same wire format whenever the data may be shared or migrated; say so with sameWireFormat.
- \`integrationMap\`: port when the vendor supports the target and the app needs it; stub when the app must run without it; omit only with a rationale. Never plan to send credentials anywhere.
- \`core\`: decide whether the pure logic should become one shared WebAssembly core. Follow the coreMode instruction when it is always or never; in auto mode weigh the deterministic candidacy assessment you are given and explain if you disagree. List the functions with JSON input/output schemas.
- \`testPlan.e2e\` includes every must-behavior id. \`testPlan.parity\` lists the logic units that get golden-vector tests.
- \`deviations\` are honest: anything the target cannot reproduce or should do differently, with why.
- \`estimate\` is rough (stages, USD, minutes). \`questionsForHuman\` lists decisions only the app owner can make.`

export function specPrompt(
  detection: Detection,
  inventory: Inventory,
  instructions: string[],
): string {
  return [
    `Source app detected as: platform ${detection.platform}, framework ${detection.framework}, language ${detection.language}, entry ${detection.entry}.`,
    '',
    'Inventory (from tree-sitter, may be incomplete):',
    summarizeInventory(inventory),
    '',
    ...(inventory.hints.testHooks.length
      ? [
          'Test hooks already in the source. Use these exact strings as the testId of the element each one marks; invent an id only for an element that has no hook, and give that element a sourceSelector so flows can still find it on the original app. Screens and containers count too (a hook like "screen-cart" is the screen container):',
          inventory.hints.testHooks.slice(0, 300).join(', '),
          '',
        ]
      : [
          'The inventory found no test hooks in the source, so every element needs a sourceSelector (web: a stable CSS selector from the source markup such as a class, id, placeholder, or role attribute; mobile: exactly the text it shows or its content description, never a description of where it sits or how it is found) next to the testId the port will add. Without one the element cannot be verified on the original app.',
          '',
        ]),
    'Read the important files (entry, routes, components, state, logic) and produce the AppSpec.',
    ...operator(instructions),
  ].join('\n')
}

/**
 * Elements that cannot be found on the source: their testId is none of the source's hooks and
 * they carry no sourceSelector (the selector is the mapping when the source has no hook).
 */
export function unmatchedTestIds(
  spec: AppSpec,
  hooks: string[],
): { screen: string; element: string; testId: string }[] {
  const set = new Set(hooks)
  return spec.screens.flatMap((s) =>
    s.elements
      .filter((e) => !set.has(e.testId) && !e.sourceSelector?.trim())
      .map((e) => ({ screen: s.id, element: e.id, testId: e.testId })),
  )
}

/** Test ids that several elements of one screen share: a flow cannot tell those elements apart by id. */
export function duplicateTestIds(
  spec: AppSpec,
): { screen: string; testId: string; elements: string[] }[] {
  const out: { screen: string; testId: string; elements: string[] }[] = []
  for (const s of spec.screens) {
    const byId = new Map<string, string[]>()
    for (const e of s.elements) byId.set(e.testId, [...(byId.get(e.testId) ?? []), e.id])
    for (const [testId, elements] of byId)
      if (elements.length > 1) out.push({ screen: s.id, testId, elements })
  }
  return out
}

/**
 * Mobile selectors that are explanations rather than captions. On a phone a test can only find an
 * element by its hook, by the text it shows, or by its content description, so "Popup menu item
 * with resource id `active`" matches nothing; such a selector is worse than none because it looks
 * like one.
 */
export function proseSelectors(
  spec: AppSpec,
  platform: string | undefined,
): { screen: string; element: string; selector: string }[] {
  if (platform !== 'ios' && platform !== 'android') return []
  const prose = (t: string) =>
    t.length > 60 ||
    /[()[\]{}:;@]/.test(t) ||
    /\b(inside|found by|with|resource id|in the|of the)\b/i.test(t)
  return spec.screens.flatMap((s) =>
    s.elements
      .filter((e) => e.sourceSelector?.trim() && prose(e.sourceSelector.trim()))
      .map((e) => ({ screen: s.id, element: e.id, selector: e.sourceSelector!.trim() })),
  )
}

export function proseSelectorRepairPrompt(
  prose: { screen: string; element: string; selector: string }[],
): string {
  return [
    `${prose.length} sourceSelector values describe where an element sits instead of how a test finds it. On a phone a test finds an element only by its hook, by the exact text it shows, or by its content description; a description such as "Popup menu item with resource id \`active\`" matches nothing and fails every flow that uses it.`,
    'For each element below, set sourceSelector to exactly the text shown on screen or the content description of the control (for example "Active", "Open navigation drawer", "Clear completed"), or remove sourceSelector when the element shows no text of its own (a container, an icon without a description). Put the explanation in unknowns if it matters. Return the whole AppSpec.',
    '',
    ...prose
      .slice(0, 80)
      .map((p) => `- screen ${p.screen}, element ${p.element}: "${p.selector.slice(0, 90)}"`),
  ].join('\n')
}

export function duplicateTestIdRepairPrompt(
  duplicates: { screen: string; testId: string; elements: string[] }[],
): string {
  return [
    `${duplicates.length} test ids are shared by several elements on one screen. Flows and ports find an element by its testId, so two elements with one id cannot be told apart: a flow meant for an inline editor typed into the new-item field because both carried the source's one hook.`,
    'For each group below give every element a distinct testId (the port adds them, so invent a precise one such as "todo-edit-input" beside "new-todo-input"); when the source reuses a single hook for those elements, keep that hook in a sourceSelector scoped by an ancestor so the original app can still be observed. Return the whole AppSpec.',
    '',
    ...duplicates.map(
      (d) => `- screen ${d.screen}: testId "${d.testId}" on ${d.elements.join(', ')}`,
    ),
  ].join('\n')
}

export function testIdRepairPrompt(
  unmatched: { screen: string; element: string; testId: string }[],
  hooks: string[],
): string {
  return [
    `${unmatched.length} elements cannot be found on the source app: their testId matches no test hook that exists in the source and they have no sourceSelector. Tests run against the source and every port through these ids, so a made-up id alone verifies nothing.`,
    'For each element below, either replace testId with the exact source hook for that element (data-testid / id / accessibilityIdentifier / testTag / view id), or, when the element truly has no hook, keep the stable testId the port will add and set sourceSelector to how a test finds the element on the original app: on web the most specific stable CSS selector in the source (a class, id, placeholder, or role attribute), never a generated or positional one; on mobile exactly the text shown on screen or the content description of the control (`Open navigation drawer`, `Save`), never a description of where the element sits or how it is found (that belongs in unknowns); a container with no text of its own gets no sourceSelector. Say so in unknowns for any element that has neither.',
    '',
    ...unmatched
      .slice(0, 80)
      .map((u) => `- screen ${u.screen}, element ${u.element}: testId "${u.testId}"`),
    '',
    hooks.length
      ? `Hooks present in the source: ${hooks.slice(0, 300).join(', ')}`
      : 'The source exposes no test hooks at all, so every element below needs a sourceSelector.',
    '',
    'Return the complete corrected AppSpec.',
  ].join('\n')
}

export function behaviorsPrompt(
  spec: AppSpec,
  inventory: Inventory,
  instructions: string[],
): string {
  return [
    'AppSpec (produced from this source in the previous stage):',
    '```json',
    JSON.stringify(spec, null, 1).slice(0, 60_000),
    '```',
    '',
    'Inventory summary:',
    summarizeInventory(inventory, 80),
    '',
    'Read the code behind each screen and write the BehaviorSpec. Reference only ids from the AppSpec.',
    ...operator(instructions),
  ].join('\n')
}

export function repairPrompt(errors: string[]): string {
  return [
    'Your previous structured output had these problems. Fix them and return the complete corrected output again:',
    ...errors.slice(0, 60).map((e) => `- ${e}`),
  ].join('\n')
}

export function planPrompt(
  run: Run,
  spec: AppSpec,
  behaviors: BehaviorSpec,
  candidacy: Candidacy,
  doctor: ToolchainReport | undefined,
  instructions: string[],
): string {
  const avail = doctor ? doctor.availableTargets.join(', ') || 'none' : 'unknown'
  return [
    `Requested targets: ${run.targets.join(', ')}. Targets buildable on this machine right now: ${avail}. Plan every requested target regardless; unavailable ones are skipped at build time.`,
    `Source platform: ${run.source.platform ?? 'unknown'} (${run.source.framework ?? 'unknown framework'}).`,
    `coreMode: ${run.options.coreMode}. Deterministic candidacy: enabled=${candidacy.enabled}, score=${candidacy.score.toFixed(2)}, pure lines=${candidacy.pureLoc}. Rationale: ${candidacy.rationale}.`,
    run.options.webFramework
      ? `Web framework requested: ${run.options.webFramework}.`
      : 'Web framework: choose the best fit for the source app; prefer the source framework when the source is web.',
    run.options.iosMinVersion ? `iOS minimum version: ${run.options.iosMinVersion}.` : '',
    run.options.androidMinSdk ? `Android minSdk: ${run.options.androidMinSdk}.` : '',
    '',
    'AppSpec:',
    '```json',
    JSON.stringify(spec, null, 1).slice(0, 50_000),
    '```',
    '',
    'BehaviorSpec:',
    '```json',
    JSON.stringify(behaviors, null, 1).slice(0, 40_000),
    '```',
    '',
    'The source app is your working directory: read its files by relative path to settle details (a path outside it is denied). Produce the PortPlan.',
    ...operator(instructions),
  ]
    .filter((l) => l !== '')
    .join('\n')
}

function operator(instructions: string[]): string[] {
  return instructions.length
    ? ['', 'Additional instructions from the operator:', ...instructions.map((i) => `- ${i}`)]
    : []
}
