# Changelog

Notable changes to the `multiplat-factory` package, newest first. Add a section for each version
before publishing it.

## [Unreleased]

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
