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
- For each screen list the elements a user sees or touches. \`testId\` must be the existing test hook when one exists (data-testid, id, aria-label, accessibilityIdentifier, testTag, resource-id); otherwise propose a stable kebab-case value like \`screen-element\`. Element ids are referenced by tests later, so keep them unique across the app.
- \`route\` is the route as it appears in the URL or navigation graph, including a leading \`#\` when the app uses hash routing.
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
- Steps use only the typed operations. \`element\` and \`screen\` values must be ids that exist in the AppSpec; never invent new ones. To leave a screen the way a user would, tap its back, close, or save element explicitly; a bare \`navigate\` walks the AppSpec edges from wherever the previous steps left the user (the back edge when returning), which may not be the path you mean. Prefer expectText with exact:false. To tap one of several rows that share a hook (list rows, repeated cards), give \`tap\` a \`text\` and the flow taps the row whose visible text contains it; never write a custom step for a tap. When row ids are positional (\`note-row-0\`, \`note-row-1\`), the index already picks the row, so tap the index that holds the note at that moment (lists that sort newest first move rows) and do not add \`text\`. Use \`restart\` to prove persistence. Use \`select\` to choose an option in a dropdown or picker (by value or visible label). Use \`swipe\` (element plus direction) for gestures such as swipe-to-delete or dismiss instead of inventing a tappable element for the revealed action; on web the port exposes the same action as a visible control. Use \`openRoute\` with a raw route id (for example "nope") to test what the app does with an unrecognized route; every port maps route ids the same way. Reach state through the UI (taps, typing, restarts) whenever it takes only a few steps; use \`seed\` only for state the UI cannot produce in a dozen steps (tapping increment three times beats seeding count 3): a seeded behavior cannot be verified on the original app, and a behavior verified on the original is worth far more to the port. Use \`custom\` only when no typed step can express the check.
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
          'Test hooks already in the source. Use these exact strings as the testId of the element each one marks; invent an id only for an element that has no hook (and say so in its action, since flows can then only match its visible text). Screens and containers count too (a hook like "screen-cart" is the screen container):',
          inventory.hints.testHooks.slice(0, 300).join(', '),
          '',
        ]
      : []),
    'Read the important files (entry, routes, components, state, logic) and produce the AppSpec.',
    ...operator(instructions),
  ].join('\n')
}

/** Elements whose testId is not one of the source's hooks, when the source has hooks at all. */
export function unmatchedTestIds(
  spec: AppSpec,
  hooks: string[],
): { screen: string; element: string; testId: string }[] {
  if (!hooks.length) return []
  const set = new Set(hooks)
  return spec.screens.flatMap((s) =>
    s.elements
      .filter((e) => !set.has(e.testId))
      .map((e) => ({ screen: s.id, element: e.id, testId: e.testId })),
  )
}

export function testIdRepairPrompt(
  unmatched: { screen: string; element: string; testId: string }[],
  hooks: string[],
): string {
  return [
    `${unmatched.length} element testIds do not match any test hook that exists in the source. Tests run against the source and every port through these ids, so a made-up id verifies nothing.`,
    'For each element below, replace testId with the exact source hook for that element (data-testid / accessibilityIdentifier / testTag / view id). Keep the invented id only when the element truly has no hook, and say so in unknowns.',
    '',
    ...unmatched
      .slice(0, 80)
      .map((u) => `- screen ${u.screen}, element ${u.element}: testId "${u.testId}"`),
    '',
    `Hooks present in the source: ${hooks.slice(0, 300).join(', ')}`,
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
    'You may read source files to settle details. Produce the PortPlan.',
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
