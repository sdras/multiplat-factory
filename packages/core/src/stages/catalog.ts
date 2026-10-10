import type { StageKind } from '../schemas/index.ts'

export interface StageInfo {
  title: string
  description: string
  whatCanGoWrong: string
  whatYouCanDo: string
  llm: boolean
}

/** Plain-language explanations shown in the dashboard's "what is happening now" panel. */
export const STAGE_CATALOG: Record<StageKind, StageInfo> = {
  ingest: {
    title: 'Ingest source',
    description:
      'Copies or clones your app into an isolated workspace and detects its platform and framework.',
    whatCanGoWrong: 'The path or URL is wrong, or no adapter recognizes the project.',
    whatYouCanDo:
      'Check the source locator. If detection is ambiguous, pick the adapter when asked.',
    llm: false,
  },
  inventory: {
    title: 'Inventory',
    description:
      'Parses the source with tree-sitter and lists files, symbols, routes, and persistence hints.',
    whatCanGoWrong: 'Unusual project layouts produce a thin inventory.',
    whatYouCanDo: 'Nothing is needed; the next stage reads the code directly as well.',
    llm: false,
  },
  spec: {
    title: 'Extract app spec',
    description:
      'An LLM reads the source and writes a framework-neutral description: screens, elements, navigation, state, logic, integrations.',
    whatCanGoWrong: 'Large or unusual apps can produce an incomplete spec.',
    whatYouCanDo:
      'Review the spec page; re-run this stage with an instruction if something is missing.',
    llm: true,
  },
  behaviors: {
    title: 'Extract behaviors',
    description:
      'Writes the list of user-observable behaviors that every port must reproduce. This becomes the test contract.',
    whatCanGoWrong: 'Behaviors may be too vague to compile into tests.',
    whatYouCanDo: 'Edit or add behaviors on the spec page before the plan is approved.',
    llm: true,
  },
  observe: {
    title: 'Observe source app',
    description:
      'Runs the original app and walks through the behaviors to capture screenshots and confirm they hold.',
    whatCanGoWrong: 'The source app may not build headlessly, or a toolchain is missing.',
    whatYouCanDo:
      'The run continues with unverified behaviors; fix the toolchain and re-run to verify.',
    llm: false,
  },
  plan: {
    title: 'Port plan',
    description:
      'Decides how each target will be built, which logic becomes a shared core, and how integrations are handled.',
    whatCanGoWrong: 'The plan may pick a deviation you do not want.',
    whatYouCanDo:
      'Approve, reject with a comment, or edit the plan when the run pauses for review.',
    llm: true,
  },
  'core.extract': {
    title: 'Extract shared core',
    description:
      'Ports the platform-independent logic into a Rust crate that compiles to one WebAssembly module used by every target.',
    whatCanGoWrong: 'Logic that secretly depends on platform APIs cannot be extracted cleanly.',
    whatYouCanDo: 'Set core mode to "never" for this run if the core is not worth it.',
    llm: true,
  },
  'core.vectors': {
    title: 'Golden vectors',
    description:
      'Records inputs and expected outputs from the original logic so every host can be checked against the same answers.',
    whatCanGoWrong:
      'When the original logic cannot be executed in isolation, vectors are derived by reading the code instead.',
    whatYouCanDo: 'Derived vectors are labeled; review them on the tests page.',
    llm: false,
  },
  'core.build': {
    title: 'Build core',
    description: 'Compiles the Rust crate to WebAssembly and runs the vectors natively.',
    whatCanGoWrong: 'Rust toolchain or the wasm32 target is missing.',
    whatYouCanDo: 'Run `mpf doctor` and install what it reports.',
    llm: false,
  },
  generate: {
    title: 'Generate target',
    description:
      'Scaffolds a green project for the target, then an LLM implements screens, state, and tests from the spec and plan.',
    whatCanGoWrong: 'This is the longest stage and the most expensive one.',
    whatYouCanDo: 'Watch the transcript; send an instruction if the worker heads the wrong way.',
    llm: true,
  },
  build: {
    title: 'Build target',
    description: 'Compiles the generated project with the platform toolchain.',
    whatCanGoWrong: 'Compiler errors, usually fixed automatically in a bounded loop.',
    whatYouCanDo:
      'Read diagnostics; if the loop stalls, the run asks you what to do. With the before-fix-loop checkpoint on, the run pauses before the first fix worker starts so you can read the errors first.',
    llm: false,
  },
  test: {
    title: 'Test target',
    description:
      'Runs unit tests, parity vectors, a launch check, end-to-end flows on a device, and captures screenshots.',
    whatCanGoWrong: 'Flaky device tests; a missing emulator or simulator.',
    whatYouCanDo:
      'Flaky results are retried once and never trigger fixes on their own. With the before-fix-loop checkpoint on, the run pauses on blocking failures before the first fix worker starts.',
    llm: false,
  },
  critique: {
    title: 'Critic review',
    description:
      'An independent LLM with its own context reviews fidelity, idiomatic quality, test adequacy, and documented deviations.',
    whatCanGoWrong: 'The critic may flag deviations you consider acceptable.',
    whatYouCanDo: 'Accept a finding as a deviation and it will not be raised again.',
    llm: true,
  },
  fix: {
    title: 'Fix',
    description: 'Applies the critic findings or build diagnostics, then rebuilds and retests.',
    whatCanGoWrong:
      'Fixes can loop; the loop is bounded and must shrink the finding set each round.',
    whatYouCanDo:
      'When the run pauses, choose: accept as deviation, add an instruction, or abort the target.',
    llm: true,
  },
  report: {
    title: 'Report',
    description:
      'Writes PORT.md per target (status, how to build and test, architecture map, wire-format pins, behavior coverage, deviations, the critic verdict) plus a one-line run result. Deterministic, no LLM.',
    whatCanGoWrong: 'Rarely anything.',
    whatYouCanDo: 'Open PORT.md from the run page or the artifacts list.',
    llm: false,
  },
}
