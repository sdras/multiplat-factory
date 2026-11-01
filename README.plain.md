# multiplat-factory

Give it an app built for one platform (web, iOS, or Android), pick the other platforms you want, and it produces fully functional builds for them.

The factory is an app too. Its dashboard lets you steer a port and watch it happen. Behind the dashboard are five parts: an orchestrator that runs the same steps in the same order every time, LLM workers that write the ported code, a harness that builds and runs the apps, an independent critic that reviews the result, and tests that prove the ported app still behaves like the original. When the source app has enough logic that is not UI, that logic is compiled into one shared WebAssembly core that runs unchanged on all three platforms.

- [What it supports](#what-it-supports)
- [Requirements](#requirements)
- [Install](#install)
- [Your first port, step by step](#your-first-port-step-by-step)
- [Command reference](#command-reference)
- [Checkpoints, budgets, and stopping early](#checkpoints-budgets-and-stopping-early)
- [The dashboard](#the-dashboard)
- [Where data lives](#where-data-lives)
- [Configuration](#configuration)
- [What a run does](#what-a-run-does)
- [Troubleshooting](#troubleshooting)
- [Developing the factory](#developing-the-factory)
- [Releasing and publishing](#releasing-and-publishing)
- [Layout](#layout)

## What it supports

| Direction | Sources detected                                                                                                | Target produced                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Web       | Vite, Next, Nuxt, SvelteKit, Angular, any npm project with build or dev scripts (`web-generic`), static HTML    | A Vite app in vanilla, React 19, Vue 3, or Svelte 5 (`--web-framework`, else the plan's choice) |
| iOS       | Xcode projects and workspaces, XcodeGen `project.yml`, SwiftPM packages; Swift or Objective-C; UIKit or SwiftUI | A SwiftUI app generated through XcodeGen, built and tested on the iPhone simulator              |
| Android   | Gradle projects; Kotlin or Java; Views or Compose; multi-module and flavored builds                             | A Jetpack Compose app, built and tested on a headless emulator                                  |

Apps built with a cross-platform framework (React Native, Flutter, Capacitor) are detected and refused, with a message that says why. The iOS target is iPhone only for now: the generated project is set to the iPhone device family, and the harness starts an iPhone simulator.

## Requirements

- **Node 22.13 or newer.** `.nvmrc` says 24, so run `nvm use` in a source checkout. On an older Node, `pnpm` itself may fail before anything runs, with the error `Cannot find matching keyid`. That comes from the old Corepack shim. Switching Node fixes it.
- **Claude credentials.** Either set `ANTHROPIC_API_KEY` in the environment, or log in to Claude Code on the machine (`claude`, then `/login`). Every LLM call uses your own account, and every run has a budget cap.
- **Toolchains for the targets you want.** `mpf doctor` lists them and says exactly what each missing one disables. `mpf setup` installs them. In short:
  - Web needs Playwright's Chromium, to observe the source app.
  - Android needs a JDK 17 to 24, the Android SDK with an emulator and an `android-36` system image, Gradle, and Maestro.
  - iOS needs macOS with Xcode, an iOS simulator runtime, XcodeGen, and Maestro.
  - A shared core needs Rust with the `wasm32-unknown-unknown` target.

  A target whose toolchain is missing is skipped, with a plain reason.

iOS targets run only on macOS. Web and Android targets also run on Linux.

## Install

From npm, once the package is published:

```bash
npm i -g @multiplat/factory
mpf doctor
```

From a packed tarball (what the release script produces, see [Releasing and publishing](#releasing-and-publishing)):

```bash
npm i -g dist-release/multiplat-factory-0.1.0.tgz
mpf doctor
```

From source, every `mpf` command runs as `pnpm mpf <command>`:

```bash
git clone https://github.com/sdras/multiplatform-factory.git
cd multiplatform-factory
nvm use
pnpm install
pnpm mpf doctor
```

## Your first port, step by step

1. **Check the machine.** `mpf doctor` prints one line per toolchain and says which targets this machine can build. `mpf doctor --json` prints the same report as JSON.
2. **Install what is missing.** `mpf setup` goes through the gaps doctor found and asks before it runs each install command (Homebrew on macOS, apt on Linux, winget on Windows). Anything that needs `sudo` runs only after you confirm that exact command. `mpf setup --yes` accepts every command that does not need sudo and prints the rest for you to run by hand. `mpf setup --dry-run` shows what would run and stops.
3. **Start the daemon and dashboard.** `mpf serve` runs the API and the dashboard on one URL, `http://127.0.0.1:4310` by default (change it with `--port`, `--host`, or `MPF_PORT`). Leave it running. If you skip this step, each command starts its own daemon and stops it when the command ends, so the dashboard is only up while a command runs.
4. **Port something.** `mpf port ./my-app --to ios,android` takes a path or a git URL. The command creates the run, prints a link to its dashboard page, and follows the run in the terminal until it finishes. It exits with a non-zero code unless the run succeeded or stopped where `--until` told it to. The first pause is plan approval: open the dashboard page, or run `mpf answer <runId> plan approve`.
5. **Read the result.** Each target's project is in `~/.mpf/runs/<runId>/workspace/<target>/`. That folder has a `PORT.md` that lists what shipped, every behavior and whether its flow passed, the critic's verdict, the deviations you accepted, and the shared core's hand-written vectors. `report.json`, in the run's folder, holds the same data for tools to read. `mpf status <runId>` prints the one-line summary.

To rehearse the whole pipeline for free, with no LLM and no toolchains:

```bash
mpf port fixtures/inhouse/web-vanilla-counter --to web,android --fake --yes
```

## Command reference

| Command                                          | What it does                                                                                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mpf doctor [--json]`                            | Checks Node, git, the package manager, Claude access, Xcode, Java, the Android SDK, Gradle, Rust, Maestro, and Playwright's Chromium. Says which targets this machine can build and what each gap disables. |
| `mpf setup [--yes] [--dry-run]`                  | Installs what doctor reports missing, asking before each step.                                                                                                                                              |
| `mpf serve [--port <n>] [--host <h>]`            | Runs the daemon (the API, the SSE event stream, and the dashboard) until you stop it.                                                                                                                       |
| `mpf port <source> --to <targets> [options]`     | Ports a path or git URL. The options are listed below.                                                                                                                                                      |
| `mpf runs`                                       | Lists runs with status, source, targets, and cost.                                                                                                                                                          |
| `mpf status <runId>`                             | Shows a run's stages and its result summary.                                                                                                                                                                |
| `mpf resume <runId>`                             | Continues a paused run, including one that stopped at `--until`.                                                                                                                                            |
| `mpf answer <runId> <stageId> <choice> [--note]` | Answers a stage that is waiting for a decision. Stage ids look like `plan`, `test:android`, or `critique:ios`.                                                                                              |
| `mpf rerun <runId> <stageId>`                    | Runs one stage again, plus everything after it. The rerun stages get a fresh count of fix rounds.                                                                                                           |
| `mpf instruct <runId> <stageId> "<text>"`        | Queues an instruction for that stage's next worker.                                                                                                                                                         |

Options for `mpf port`:

- `--to web,ios,android`: the targets to build.
- `--budget <usd>`: the spending cap. Default 30, at most 500.
- `--core auto|always|never`: whether to build the shared WASM core. `auto` says no when only one target is requested.
- `--web-framework vanilla|react|vue|svelte`: the framework for a web target.
- `--until <stage>`: pause after that stage.
- `--yes`: skip the plan approval and fix-loop checkpoints.
- `--detach`: create the run and return at once.
- `--fake`: run the LLM-free rehearsal pipeline.

Stage kinds, in pipeline order (use these for `--until` and in stage ids): `ingest`, `inventory`, `spec`, `behaviors`, `observe`, `plan`, `core.extract`, `core.vectors`, `core.build`, then per target `generate`, `build`, `test`, `critique`, `fix`, and finally `report`.

## Checkpoints, budgets, and stopping early

Three checkpoints can pause a run and wait for you. Answer each one from the run's dashboard page or with `mpf answer`.

- **Plan approval** (on by default; `--yes` skips it) pauses after `plan`. The choices are `approve` and `reject`.
- **Before the first fix worker** (`--yes` skips it) pauses `build` and `test` before they spend money on a fix round. The reason shows the failures and the worker's budget cap. `continue` goes ahead, rebuilding or retesting first. `reject` cancels the run.
- **Critic escalation** pauses when the critic cannot settle a target within its rounds. `accept` turns the remaining blocking findings into accepted deviations, marked as such in `PORT.md`. `reject` cancels the run.

`--until <stage>` pauses a run after that stage. Use it to review the analysis before anything is generated (`--until plan`), or to stop after the shared core is built (`--until core.build`). `mpf resume` continues the run. When the named stage is the last one, the run finishes instead of pausing.

Every run has a budget cap: `--budget`, or the configured default of $30. The ceiling is $500. Cost is charged the moment a worker returns, and the run pauses when it reaches the cap. The CLI and the dashboard cannot raise a paused run's budget yet. From a source checkout, `pnpm tsx scripts/run-control.ts <runId> resume --budget <usd>` does it. For scale: a two-screen app costs about $15 to $40 per target, and a dozen-screen app against a live backend about $100 to $150.

## The dashboard

`mpf serve` serves the dashboard and the API from one process on your machine. There is nothing to deploy or host. The factory needs the simulators, emulators, toolchains, and Claude login of the machine it runs on. So publishing the npm package is the deployment, and each user runs `mpf serve` on their own machine. A hosted factory for many users would have to replace the six seams (the places where a hosted version would plug in) listed in `docs/HOSTED-SEAM.md`. None of that exists yet.

The pages:

- `/`: the list of runs.
- `/runs/new`: the wizard for a new run.
- `/runs/<id>`: a run's overview, with the stage graph, transcript, budget, and controls.
- `spec`: the AppSpec and the behaviors, with marks showing which ones were verified on the source app.
- `plan`: the port plan, with approve and reject.
- `tests`: the test matrix with flows, screenshots, failure evidence, and the shared-core parity matrix.
- `critic`: the critic's verdicts and findings.
- `core`: the shared-core playground.
- `release`: the release checklist.
- `doctor`: the toolchain report.

The dashboard also has tools for reviewing a project: a chat about the project that can propose revisions, a design review that produces three concept mockups to choose from, a way to annotate recorded screenshots with pins and notes, and a release checklist. Applying a proposal creates a new version of the project and reruns the stages it affects. Browser agents can use these actions too, as WebMCP tools on the page. `docs/PROJECT-REVIEW.md` describes all of it, and `pnpm tsx scripts/review-demo.ts <screenshot.png> <port>` runs a demo against a throwaway database. The "Host on Netlify" card on the release page is for the generated web app, not for the factory.

For development, `pnpm dev` runs the API on 4310 and the dashboard, with hot reload, on 4311.

## Where data lives

Run data never goes inside your project. The data directory is `$MPF_HOME`, else `$XDG_DATA_HOME/mpf`, else `~/.mpf`. It holds:

- `mpf.sqlite`: the run store. Events are the source of truth, and every view is built from them.
- `daemon.json`: the running daemon's address. The other commands read it to find the daemon.
- `runs/<runId>/`: one folder per run, holding:
  - `source/`: the copied source app
  - `detection.json`, `inventory.json`, `appspec.json`, `behaviorspec.json`, and `portplan.json`: the analysis and the plan
  - `observe/`: screenshots and the source app's own test results
  - `core/`: the Rust crate, the built module, and `vectors/*.json`
  - `workspace/<target>/`: the generated project, its `PORT.md`, and the Maestro or web flow files and their evidence
  - `report.json`: the run's report
  - `review/`: annotations
- `locks/`: one lock per run and one per device lane. Only one process drives a run at a time, and only one process uses the simulator or emulator at a time.
- `jdks/`: JDKs you unpack here are found the same way as installed ones. This lets you serve a source app whose Gradle wrapper needs an old JDK (Gradle 4 to 7 need JDK 8 to 16) without a package manager or sudo.
- `cache/`.

## Configuration

Settings come in layers, and later layers win: built-in defaults, then `~/.mpf/config.json` (in the data directory), then `./mpf.config.{ts,js,json}` in the current directory, then environment variables.

```json
{
  "models": { "generate": "claude-opus-5", "critic": "claude-opus-5", "cheap": "claude-sonnet-5" },
  "effort": { "generate": "xhigh", "critic": "high" },
  "budget": { "defaultUsd": 30 },
  "concurrency": {
    "agents": 3,
    "lanes": { "xcodebuild": 1, "gradle": 1, "simulator": 1, "emulator": 1, "web": 2 }
  },
  "toolchain": {
    "androidHome": "/path/to/android-sdk",
    "javaHome": "/path/to/jdk",
    "developerDir": "/Applications/Xcode.app/Contents/Developer",
    "maestro": "/path/to/maestro",
    "cargo": "/path/to/cargo"
  },
  "server": { "host": "127.0.0.1", "port": 4310 },
  "dataDir": "/somewhere/else"
}
```

The values shown are the defaults, except the toolchain overrides. Those are empty by default, because toolchains are found automatically (`DEVELOPER_DIR` or `xcode-select`, `JAVA_HOME`, `ANDROID_HOME`, Homebrew prefixes, PATH).

Environment variables:

- `MPF_HOME`: the data directory
- `MPF_PORT` and `MPF_HOST`: the daemon address
- `MPF_BUDGET_USD`: the default budget
- `MPF_MODEL_GENERATE`, `MPF_MODEL_CRITIC`, `MPF_MODEL_CHEAP`: the models
- `ANDROID_HOME` or `ANDROID_SDK_ROOT`, `JAVA_HOME`, `DEVELOPER_DIR`: toolchain locations
- `ANTHROPIC_API_KEY`: Claude access
- `MPF_ANDROID_AVD`: the emulator image to boot. Otherwise the first AVD is used, or `mpf-api36` if there is none.
- `MPF_KEEP_DEVICES=1`: leave the emulator or simulator a run booted running when the run ends
- `PLAYWRIGHT_BROWSERS_PATH`: where Playwright keeps its browsers

## What a run does

A run goes through these stages:

1. `ingest` copies the source app and detects its platform and framework.
2. `inventory` parses it with tree-sitter and collects the test hooks it already has.
3. `spec` and `behaviors` write a framework-neutral AppSpec and BehaviorSpec.
4. `observe` runs the original app, checks the behaviors against it, takes screenshots, and runs the source's own test suite as the baseline. For web it uses a dev server or the production build plus Chromium. For iOS and Android it uses a simulator or emulator plus Maestro.
5. `plan` decides how to port the app and whether a shared Rust core is worth building.
6. When the plan says yes, the three `core.*` stages extract that core, record golden vectors for it, and build it.
7. Then, for each target: the project is scaffolded, generated, built, and tested against the same behaviors, reviewed by the critic, and fixed in a bounded loop (three build-fix rounds, two test-fix rounds, two critic rounds). The result is written up in a `PORT.md`.
8. `report` runs once every target has ended, however it ended.

Devices are handled for you. The harness boots a headless emulator or an iPhone simulator when none is running, reuses one that is, dismisses stale system dialogs before each launch, and shuts down the devices it booted itself when the run ends.

## Troubleshooting

- **`mpf doctor` says there is no Claude login, but you are logged in.** nvm keeps global CLIs per Node version, so a `claude` installed under another Node is not on PATH. The Agent SDK still finds the login. Either install `claude` under this Node, or ignore the line.
- **Xcode is installed, but `xcode-select` points at the Command Line Tools.** The harness works out `DEVELOPER_DIR` itself and keeps working. `sudo xcode-select -s /Applications/Xcode.app` makes Xcode the default for everything else.
- **Gradle fails with `java.lang.IllegalArgumentException: 27` or similar.** The JDK is newer than Gradle supports. The factory's own builds need JDK 17 to 24. Homebrew's plain `openjdk` tracks the newest release, so install `openjdk@21` instead. Run `gradle --stop` after switching JDKs. A source app's own wrapper may need an older JDK still. The harness picks one by the wrapper's version, and a JDK unpacked under `<data dir>/jdks` counts.
- **`brew install maestro` installs the wrong thing.** The mobile testing tool is `brew trust mobile-dev-inc/tap && brew install --formula mobile-dev-inc/tap/maestro`.
- **Web observation says "unverified".** Playwright's Chromium is missing. Run `npx playwright install chromium` (from a source checkout, `pnpm --filter @mpf/analyzer exec playwright install chromium`). The port still runs; the behaviors are just not checked against the source app.
- **Every iOS flow fails at once.** A stale "Open in …?" dialog from an earlier URL-scheme launch is hiding the whole app. The harness dismisses it before each launch. If one is stuck, shut the simulator down.
- **Every Android flow fails at once.** A stale system dialog (an "isn't responding" prompt, a crash dialog, or an "Open with" chooser) is covering the app. The harness detects and dismisses these. If an "Open with" chooser keeps appearing, uninstall leftover `app.mpf.*` packages from the emulator.
- **"already being driven by another process".** Only one process drives a run at a time. Stop the other one (a daemon or a `run-control` script) before resuming or re-running here.
- **Flows die part-way under load.** On a busy machine, Maestro batches fail without writing a report. Keep the machine quiet during device runs.
- **The run paused on its budget.** Raise it as described under [Checkpoints, budgets, and stopping early](#checkpoints-budgets-and-stopping-early), then resume.

## Developing the factory

```bash
nvm use
pnpm install
pnpm dev            # API on 4310, dashboard with hot reload on 4311
pnpm test           # vitest across every package; tests tagged by toolchain skip when it is absent
pnpm typecheck
pnpm lint
pnpm format         # Prettier; `pnpm format:check` to verify
pnpm mpf <command>  # run the CLI from source
```

To drive a run without the daemon while you work on stages, use `scripts/run-control.ts`:

- `pnpm tsx scripts/run-control.ts <runId> resume|rerun <stageId>|answer <stageId> <choice> [note]|status` drives an existing run.
- `resume` also takes `--until <stage>`, `--budget <usd>`, and `--core auto|always|never`. `rerun` takes `--approve`.
- `pnpm tsx scripts/run-control.ts new <source> --to ios,android [--until <stage>] [--budget <usd>] [--core …] [--yes]` creates a run in this process, on the current code.

Set `MPF_HOME` to the same directory the daemon serves, and the run shows up in the dashboard. Two more scripts help. `scripts/compile-flows.ts <runId> <target>` recompiles a target's end-to-end flows from the stored BehaviorSpec without a device. `scripts/spike-target-scaffold.ts --target android|ios|web [--framework <flavor>] [--e2e] [--core]` runs a scaffold, build, launch, flow, and shared-core parity check with no LLM.

Fixtures. `fixtures/manifest.json` pins public apps by git URL, ref, and commit. `pnpm fixtures:sync` clones them into `fixtures/.cache` and fills in unpinned commits; `--id <fixture>` syncs one, and `--repin` moves the pins. The manifest also lists the in-house fixtures under `fixtures/inhouse/`:

- `web-vanilla-counter`: tiny; the core stays off
- `web-vanilla-cart`: about 150 lines of pure pricing logic, for the shared core
- `ios-uikit-notes`: Swift, UIKit, XcodeGen spec, XCTest
- `ios-objc-notes`: Objective-C, XCTest
- `android-views-java-notes`: Java, XML layouts, JUnit

Every in-house fixture has a test id on every interactive element. The mobile ones ship their own unit tests, which the observe stage records as the `source` result. `packages/adapters/test/detect.test.ts` checks the in-house fixtures, and `fixture-matrix.test.ts` checks the synced public ones.

CI (`.github/workflows/ci.yml`) runs these on Linux and macOS: lint, the format check, typecheck, the tests (with Rust and Chromium installed, so the core ABI and observe tests run), the fake pipeline end to end, the dashboard build, and the bundled CLI. It also runs the four web scaffold flavors with a Playwright flow, builds the in-house mobile fixtures and runs their own tests, and syncs the public fixture matrix and checks detection. Port runs that use a real LLM or a device are not in CI.

To add a platform or framework, implement `SourceAdapter` or `TargetAdapter` from `packages/adapters/src/types.ts`, register it, and add a fixture. `docs/ADAPTERS.md` walks through it. `docs/ARCHITECTURE.md` describes the design and where the code differs from it. `docs/ABI.md` is the contract for the shared core.

## Releasing and publishing

The published package is `@multiplat/factory`. It is built from `apps/cli`, with every `@mpf/*` package inlined and the static dashboard copied next to the binary. Its npm page is `apps/cli/README.md`.

1. Bump the version in `apps/cli/package.json` and in `meta.version` in `apps/cli/src/main.ts`.
2. Build and pack: `pnpm tsx scripts/release.ts`. It builds the dashboard, bundles the CLI with tsup, runs `mpf --help` from the bundle, and packs the tarball into `dist-release/`. It prints the tarball's contents (about 1.2 MB, with source maps).
3. Try the tarball in a clean project: `mkdir /tmp/try && cd /tmp/try && npm init -y && npm i <repo>/dist-release/multiplat-factory-<version>.tgz && npx mpf doctor && npx mpf serve`.
4. Log in to npm and check that you can publish to the scope: `npm login`, then `npm access list packages multiplat`. If the `multiplat` org is not yours, create it on npmjs.com or rename the package.
5. Publish: `pnpm tsx scripts/release.ts --publish`. It rebuilds, then runs `pnpm publish --access public --no-git-checks` from `apps/cli`. With two-factor auth on, npm asks for a one-time code.
6. Check from another machine: `npm view @multiplat/factory version` and `npx @multiplat/factory doctor`.

The package metadata and this README link to the GitHub repository. Make it public before publishing, or expect dead links.

## Layout

- `apps/cli`: the `mpf` command
- `apps/server`: HTTP + SSE API, the run daemon, and the project review routes
- `apps/dashboard`: Nuxt dashboard
- `packages/core`: schemas, event log, SQLite store, config, reducer, stage catalog
- `packages/orchestrator`: deterministic stage graph, state machine, scheduler, generic target stages, critique and fix, report, project revisions
- `packages/harness`: toolchain discovery, process runner, device lifecycle, lanes
- `packages/adapters`: source and target adapters, the flow compilers, and the generated host bindings for the shared core (all platform knowledge lives here)
- `packages/analyzer`: source inventory, AppSpec and BehaviorSpec extraction, source observation, plan
- `packages/llm`: Agent SDK worker wrapper with the sandbox policy, Messages structured call, cost accounting, recorder
- `packages/critic`: independent review with structured verdicts
- `packages/wasm-core`: Rust core template implementing `docs/ABI.md`, cargo runner, Node host, golden vectors, core stages

Licensed under Apache-2.0; see `LICENSE`.
