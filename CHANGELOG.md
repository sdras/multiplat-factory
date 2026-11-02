# Changelog

Notable changes to the `multiplat-factory` package, newest first. Add a section for each version
before running `pnpm release`; the release script refuses to publish a version that has no entry.

## [Unreleased]

## [0.1.1] - 2026-11-01

### Fixed

- A naming collision between the monorepo root and the published package. Both `package.json`
  files are named `multiplat-factory`, so a publish resolved by name picked the workspace root and
  0.1.0 shipped the source tree without a runnable `mpf` command. The release script now builds
  the CLI by path (`pnpm --filter ./apps/cli`), publishes only the packed tarball from `apps/cli`,
  and the root refuses `npm publish` outright. Use 0.1.1 or later.

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
