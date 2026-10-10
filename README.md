# multiplat-factory

Give it an app built for one platform (web, iOS, or Android), pick the other platforms you want, and it produces fully functional builds for them.

The factory is itself an app: a dashboard for steering the process and watching it. Inside are a deterministic orchestrator, LLM workers that do the porting, a verification harness, an independent critic, and testing infrastructure that proves the ported app still behaves like the original. A shared logic core compiled to WebAssembly runs unchanged on all three platforms when the source app has enough non-UI logic to justify it.

## Quick start

```bash
pnpm install
pnpm mpf doctor            # what toolchains are present, what each gap disables
pnpm mpf setup             # install what doctor reports as missing, asking before each step
pnpm dev                   # server (4310) + dashboard (4311)
pnpm mpf port ./my-app --to ios,android
```

Requires Node 22.13 or newer (`node:sqlite`; `.nvmrc` says 24). iOS targets need macOS with Xcode; web and Android targets also run on Linux. The factory uses your own Claude credentials (`ANTHROPIC_API_KEY` or the Claude Code login on the machine), every run has a budget cap, and run data lives under `~/.mpf` (or `$MPF_HOME`), never in your project.

The same CLI is packaged as `@multiplat/factory` (`npm i -g @multiplat/factory`, then `mpf doctor`). Until it is on npm, `pnpm tsx scripts/release.ts` builds the static dashboard, bundles the CLI with tsup, copies the dashboard next to it (`apps/cli/scripts/bundle-dashboard.mjs`), and packs the tarball into `dist-release/`; install it with `npm i -g dist-release/*.tgz`. `--publish` runs `pnpm publish` from `apps/cli`.

## What a run does

`ingest` copies the source and detects its platform and framework, `inventory` parses it with tree-sitter and collects the test hooks it already exposes, `spec` and `behaviors` extract a framework-neutral AppSpec and BehaviorSpec, `observe` runs the original app (a dev server plus Chromium for web; a simulator or emulator plus Maestro for iOS and Android) to verify the behaviors, take screenshots, and run the source's own test suite as the baseline, `plan` decides the port and whether a shared Rust core is worth it, then each target is scaffolded, generated, built, tested against the same behaviors, reviewed by the critic, fixed in a bounded loop, and written up in a `PORT.md`.

Two checkpoints can pause a run for you. Plan approval (on by default; `--yes` skips it) stops after `plan` with the choices `approve` and `reject`. Critic escalation stops when the critic cannot settle a target within its rounds, with `accept` (the remaining blocking findings become accepted deviations, marked as such in `PORT.md`) and `reject`. Answer from the dashboard or with `mpf answer <run> <stage> <choice>`; `reject` cancels the run. `--until <stage>` pauses a run after that stage so you can review the analysis before anything is generated; `mpf resume` continues it.

Driving a run without the daemon, while iterating on stages: `pnpm tsx scripts/run-control.ts <runId> resume|rerun <stageId>|answer <stageId> <choice> [note]|status`, or `new <source> --to ios,android [--until <stage>] [--budget <usd>] [--yes]` to create one in-process on the current code. The header comment of the script lists the commands. `scripts/compile-flows.ts <runId> <target>` recompiles a target's end-to-end flows from the stored BehaviorSpec without a device, and `scripts/spike-target-scaffold.ts --target android|ios|web [--e2e] [--core]` exercises a scaffold, build, launch, flow, and shared-core parity with no LLM.

## Fixtures

`fixtures/manifest.json` pins public apps by git URL, ref, and commit (`pnpm fixtures:sync` clones them into `fixtures/.cache` and fills unpinned commits; `--repin` moves the pins) and lists the in-house ones under `fixtures/inhouse/`: `web-vanilla-counter` (tiny; the core stays off), `web-vanilla-cart` (about 150 lines of pure pricing logic for the shared core), `ios-uikit-notes` (Swift, UIKit, XcodeGen spec, XCTest), `ios-objc-notes` (Objective-C, XCTest), and `android-views-java-notes` (Java, XML layouts, JUnit). Every in-house fixture has a test id on every interactive element so the observe stage can verify its behaviors; the three mobile ones also ship their own unit tests, which the observe stage runs as the `source` result. `packages/adapters/test/detect.test.ts` checks that every in-house fixture detects as the manifest expects, and `packages/adapters/test/fixture-matrix.test.ts` does the same for every synced public fixture.

CI (`.github/workflows/ci.yml`) runs lint, format check, typecheck, the tests (with Rust and Chromium installed so the core ABI and observe tests run), the fake pipeline end to end, the dashboard build, and the bundled CLI on Linux and macOS; the four web scaffold flavors with a Playwright flow; the in-house mobile fixtures building and passing their own tests (XcodeGen plus `xcodebuild test` on a simulator; Gradle `assembleDebug testDebugUnitTest`); and the public fixture matrix sync and detection. Real-LLM and device-driven port runs are not in CI.

## Layout

- `apps/cli`: the `mpf` command
- `apps/server`: HTTP + SSE API and run daemon
- `apps/dashboard`: Nuxt dashboard
- `packages/core`: schemas, event log, SQLite store, config, reducer, stage catalog
- `packages/orchestrator`: deterministic stage graph, state machine, scheduler, generic target stages, critique and fix, report
- `packages/harness`: toolchain discovery, process runner, device lifecycle, lanes
- `packages/adapters`: source and target adapters, the flow compilers, and the generated host bindings for the shared core (all platform knowledge lives here)
- `packages/analyzer`: source inventory, AppSpec and BehaviorSpec extraction, source observation, plan
- `packages/llm`: Agent SDK worker wrapper with the sandbox policy, Messages structured call, cost accounting, recorder
- `packages/critic`: independent review with structured verdicts
- `packages/wasm-core`: Rust core template implementing `docs/ABI.md`, cargo runner, Node host, golden vectors, core stages

See `docs/ARCHITECTURE.md` for the design and where the implementation differs from it, `docs/ADAPTERS.md` to add a platform or framework, `docs/ABI.md` for the shared core contract, and `docs/HOSTED-SEAM.md` for running the factory outside a laptop.
