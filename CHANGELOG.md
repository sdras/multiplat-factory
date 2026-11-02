# Changelog

Notable changes to the `multiplat-factory` package, newest first. Add a section for each version
before publishing it.

## [Unreleased]

### Added

- Workers can run on models other than Claude. `llm.provider` in `~/.mpf/config.json` (or
  `mpf port --provider`) picks `openai`, `gemini`, `openrouter`, `ollama`, or a `custom`
  OpenAI-compatible server (`--base-url`); keys come from `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `OPENROUTER_API_KEY`, or `MPF_LLM_API_KEY`. Claude stays the default when the machine has a
  Claude Code login or `ANTHROPIC_API_KEY`. `mpf doctor` reports the provider it will use, checks
  the key, confirms the models against the server's catalog, and names models it cannot price.
  Verified on Ollama with `qwen2.5-coder:7b`: the provider probe passes and a run reaches the
  spec stage. Models that write tool calls as text instead of native calls are understood.
- `scripts/spike-provider.ts` proves a provider works before a run spends money on it.
- Weak or slow models are refused before a run's first worker. Claude, full-size GPT-5 and
  o-series, and Gemini Pro models pass on their name; any other model on a non-Claude provider is
  probed with a short tool task, and one that fails it, answers under 10 output tokens per second,
  or has fewer than 30B parameters by its name stops the run with a `model-unsuitable` error.
  `mpf doctor --probe` runs the same check; `llm.probe: false` skips it.

### Fixed

- Analysis and review workers (spec, behaviors, plan, critique) can no longer write files. The
  sandbox denies the write tools for them on every backend; a small local model spent a whole
  attempt editing the source copy under the run folder.

## [0.1.1] - 2026-11-01

### Fixed

- A naming collision between the monorepo root and the published package. Both were named
  `multiplat-factory`, so a publish from the root shipped the workspace instead of the CLI, and
  0.1.0 contains the source tree without a runnable `mpf` command. The root is now
  `multiplat-factory-workspace`, and `pnpm release` publishes the CLI from `apps/cli` after
  building it. Use 0.1.1 or later.

## [0.1.0] - 2026-11-01

Initial release of the `mpf` command line tool.

### Added

- `mpf doctor`, `mpf setup`, `mpf serve`, `mpf port`, `mpf runs`, `mpf status`, `mpf resume`,
  `mpf answer`, `mpf rerun`, and `mpf instruct`.
- Source adapters for web (Vite, Next, Nuxt, SvelteKit, Angular, generic npm projects, static
  HTML), iOS (Xcode projects and workspaces, XcodeGen, Swift packages; Swift or Objective-C), and
  Android (Gradle; Kotlin or Java; Views or Compose).
- Target adapters that produce a SwiftUI app, a Jetpack Compose app, or a Vite web app in vanilla
  JavaScript, React 19, Vue 3, or Svelte 5.
- Behavior verification on the original app before anything is generated, and the same behaviors
  run as device or browser flows against every port.
- An optional shared logic core in Rust compiled to WebAssembly, with recorded input and output
  vectors checked on every platform.
- An independent critic review with fidelity scores, bounded fix loops, and a `PORT.md` per port.
- A local dashboard served next to the API, with the run graph, live transcript, budget, tests,
  screenshots, critic findings, a shared-core playground, and project review tools.
- Budget caps on every run, with pauses for plan approval, before the first paid fix round, and on
  critic escalation.
