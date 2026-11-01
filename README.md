# multiplat-factory

Give it an app built for one platform (web, iOS, or Android), pick the other platforms you want, and it produces fully functional builds for them.

The factory is itself an app: a dashboard for steering the process and watching it. Inside are a deterministic orchestrator, LLM workers that do the porting, a verification harness, an independent critic, and testing infrastructure that proves the ported app still behaves like the original. A shared logic core compiled to WebAssembly runs unchanged on all three platforms when the source app has enough non-UI logic to justify it.

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

Cross-platform sources (React Native, Flutter, Capacitor) are detected and refused with a reason. The iOS target is iPhone only today: the generated project pins the iPhone device family and the harness boots an iPhone simulator.

## Requirements

- **Node 22.13 or newer.** `.nvmrc` says 24, so run `nvm use` in a source checkout. On an older Node, `pnpm` itself may fail before anything runs with `Cannot find matching keyid`; that is the old Corepack shim, and switching Node fixes it.
- **Claude credentials.** Either `ANTHROPIC_API_KEY` in the environment or the Claude Code login on the machine (`claude`, then `/login`). Every LLM call goes through your own account, and every run has a budget cap.
- **Toolchains for the targets you want.** `mpf doctor` lists them and says exactly what each gap disables, and `mpf setup` installs them. In short: web needs Playwright's Chromium to observe the source; Android needs a JDK 17 to 24, the Android SDK with an emulator and an `android-36` system image, Gradle, and Maestro; iOS needs macOS with Xcode, an iOS simulator runtime, XcodeGen, and Maestro. A shared core needs Rust with the `wasm32-unknown-unknown` target. A target whose toolchain is missing is skipped with a plain reason.

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

1. **Check the machine.** `mpf doctor` prints one line per toolchain and which targets are available here. `mpf doctor --json` prints the same report as JSON.
2. **Install what is missing.** `mpf setup` walks through the gaps doctor found and asks before running each install command (Homebrew on macOS, apt on Linux, winget on Windows). Anything that needs `sudo` is only run after you confirm that exact command. `mpf setup --yes` accepts every command that does not need sudo and prints the rest for you to run by hand; `mpf setup --dry-run` shows what would run and stops.
3. **Start the daemon and dashboard.** `mpf serve` runs the API and the dashboard on one URL, `http://127.0.0.1:4310` by default (`--port`, `--host`, or `MPF_PORT`). Leave it running. If you skip this step, every command starts an embedded daemon for its own lifetime, so the dashboard is only up while a command runs.
4. **Port something.** `mpf port ./my-app --to ios,android` takes a path or a git URL. The command creates the run, prints its dashboard link, and follows it in the terminal until the run settles. It exits non-zero unless the run succeeded or stopped where `--until` asked. The first pause is plan approval: open the dashboard page or run `mpf answer <runId> plan approve`.
5. **Read the result.** Each target's project is in `~/.mpf/runs/<runId>/workspace/<target>/`, with a `PORT.md` that lists what shipped, every behavior and whether its flow passed, the critic's verdict, accepted deviations, and the shared core's hand-written vectors. `report.json` next to it holds the same data for tools, and `mpf status <runId>` prints the one-line summary.

A no-cost rehearsal of the whole pipeline, with no LLM and no toolchains:

```bash
mpf port fixtures/inhouse/web-vanilla-counter --to web,android --fake --yes
```

## Command reference

| Command                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mpf doctor [--json]`                            | Check Node, git, the package manager, Claude access, Xcode, Java, the Android SDK, Gradle, Rust, Maestro, and Playwright's Chromium. Says which targets are available here and what each gap disables.                                                                                                                                                                                                                                                |
| `mpf setup [--yes] [--dry-run]`                  | Install what doctor reports missing, asking before each step.                                                                                                                                                                                                                                                                                                                                                                                         |
| `mpf serve [--port <n>] [--host <h>]`            | Run the daemon (API, SSE event stream, and the dashboard) until stopped.                                                                                                                                                                                                                                                                                                                                                                              |
| `mpf port <source> --to <targets> [options]`     | Port a path or git URL. `--to web,ios,android`; `--budget <usd>` (default 30, at most 500); `--core auto\|always\|never` for the shared WASM core (`auto` declines when only one target is requested); `--web-framework vanilla\|react\|vue\|svelte`; `--until <stage>` to pause after that stage; `--yes` to skip the plan approval and fix-loop checkpoints; `--detach` to create the run and return; `--fake` for the LLM-free rehearsal pipeline. |
| `mpf runs`                                       | List runs with status, source, targets, and cost.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mpf status <runId>`                             | Show a run's stages and its result summary.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mpf resume <runId>`                             | Continue a paused run, including past a `--until` stop.                                                                                                                                                                                                                                                                                                                                                                                               |
| `mpf answer <runId> <stageId> <choice> [--note]` | Answer a stage that is waiting for a decision. Stage ids look like `plan`, `test:android`, or `critique:ios`.                                                                                                                                                                                                                                                                                                                                         |
| `mpf rerun <runId> <stageId>`                    | Re-run one stage and everything downstream of it. Fix-round counts start over for the rerun stages.                                                                                                                                                                                                                                                                                                                                                   |
| `mpf instruct <runId> <stageId> "<text>"`        | Queue an instruction for that stage's next worker.                                                                                                                                                                                                                                                                                                                                                                                                    |

Stage kinds, in pipeline order, for `--until` and stage ids: `ingest`, `inventory`, `spec`, `behaviors`, `observe`, `plan`, `core.extract`, `core.vectors`, `core.build`, then per target `generate`, `build`, `test`, `critique`, `fix`, and finally `report`.

## Checkpoints, budgets, and stopping early

Three checkpoints can pause a run for you. Answer each from the run's dashboard page or with `mpf answer`.

- **Plan approval** (on by default; `--yes` skips it) pauses after `plan` with the choices `approve` and `reject`.
- **Before the first fix worker** (`--yes` skips it) pauses `build` and `test` before they spend money on a fix round, with the failures and the worker's budget cap in the reason. `continue` proceeds and rebuilds or retests first; `reject` cancels the run.
- **Critic escalation** pauses when the critic cannot settle a target within its rounds. `accept` turns the remaining blocking findings into accepted deviations, marked as such in `PORT.md`; `reject` cancels the run.

`--until <stage>` pauses a run after that stage, so you can review the analysis before anything is generated (`--until plan`) or stop after the shared core (`--until core.build`). `mpf resume` continues it. When the named stage is the last one, the run settles instead of pausing.

Every run has a budget cap, `--budget` or the configured default of $30, with a ceiling of $500. Cost is charged the moment a worker returns, and the run pauses when the cap is reached. Raising a paused run's budget is not exposed by the CLI or the dashboard yet; from a source checkout, `pnpm tsx scripts/run-control.ts <runId> resume --budget <usd>` does it. For scale: a two-screen app costs about $15 to $40 per target, and a dozen-screen app against a live backend about $100 to $150.

## The dashboard

`mpf serve` serves the dashboard and the API from one process on your machine. There is nothing to deploy or host: the factory needs the simulators, emulators, toolchains, and Claude login of the machine it runs on, so publishing the npm package is the deployment, and each user runs `mpf serve` locally. A hosted, multi-user factory would replace the six seams listed in `docs/HOSTED-SEAM.md`; none of that exists yet.

Pages: the runs list (`/`), the new-run wizard (`/runs/new`), and per run the overview with the stage graph, transcript, budget, and controls (`/runs/<id>`), the AppSpec and behaviors with their verified-on-source marks (`spec`), the port plan with approve and reject (`plan`), the test matrix with flows, screenshots, failure evidence, and the shared-core parity matrix (`tests`), the critic's verdicts and findings (`critic`), the shared-core playground (`core`), the release checklist (`release`), and the toolchain report (`doctor`).

The dashboard also carries project review tools: a chat about a project that can propose revisions, a design review that produces three concept mockups to choose from, annotation of recorded screenshots with pins and notes, and a release checklist. Applying a proposal creates a new version of the project and reruns the affected stages. These actions are also exposed to browser agents as WebMCP tools on the page. `docs/PROJECT-REVIEW.md` describes all of it, and `pnpm tsx scripts/review-demo.ts <screenshot.png> <port>` runs a demo against a throwaway database. The "Host on Netlify" card on the release page is for the generated web app, not for the factory.

For development, `pnpm dev` runs the API on 4310 and the dashboard with hot reload on 4311.

## Where data lives

Run data never goes inside your project. The data directory is `$MPF_HOME`, else `$XDG_DATA_HOME/mpf`, else `~/.mpf`. In it:

- `mpf.sqlite`: the run store. Events are the source of truth; every view is derived from them.
- `daemon.json`: the running daemon's address, which the other commands use to find it.
- `runs/<runId>/`: `source/` (the copied source app), `detection.json`, `inventory.json`, `appspec.json`, `behaviorspec.json`, `observe/` (screenshots and the source's test results), `portplan.json`, `core/` (the Rust crate, the built module, and `vectors/*.json`), `workspace/<target>/` (the generated project, its `PORT.md`, and Maestro or web flow files and evidence), `report.json`, and `review/` for annotations.
- `locks/`: one lock per run and per device lane. One process drives a run at a time, and one process uses the simulator or emulator at a time.
- `jdks/`: JDKs you unpack here are found like installed ones. A source app whose Gradle wrapper needs an old JDK (Gradle 4 to 7 need JDK 8 to 16) can be served this way without a package manager or sudo.
- `cache/`.

## Configuration

Layers, later ones winning: built-in defaults, `~/.mpf/config.json` (in the data directory), `./mpf.config.{ts,js,json}` in the current directory, then environment variables.

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

The values shown are the defaults, except the toolchain overrides, which are empty by default because toolchains are discovered (`DEVELOPER_DIR` or `xcode-select`, `JAVA_HOME`, `ANDROID_HOME`, Homebrew prefixes, PATH).

Environment variables: `MPF_HOME` (data directory), `MPF_PORT` and `MPF_HOST` (daemon address), `MPF_BUDGET_USD` (default budget), `MPF_MODEL_GENERATE`, `MPF_MODEL_CRITIC`, `MPF_MODEL_CHEAP`, `ANDROID_HOME` or `ANDROID_SDK_ROOT`, `JAVA_HOME`, `DEVELOPER_DIR`, `ANTHROPIC_API_KEY`, `MPF_ANDROID_AVD` (the emulator image to boot; otherwise the first AVD, else `mpf-api36`), `MPF_KEEP_DEVICES=1` (leave the emulator or simulator a run booted running when it ends), and Playwright's `PLAYWRIGHT_BROWSERS_PATH`.

## What a run does

`ingest` copies the source and detects its platform and framework, `inventory` parses it with tree-sitter and collects the test hooks it already exposes, `spec` and `behaviors` extract a framework-neutral AppSpec and BehaviorSpec, `observe` runs the original app (a dev server or its production build plus Chromium for web; a simulator or emulator plus Maestro for iOS and Android) to verify the behaviors, take screenshots, and run the source's own test suite as the baseline, `plan` decides the port and whether a shared Rust core is worth it, and the three `core.*` stages extract, record golden vectors for, and build that core when it is. Then each target is scaffolded, generated, built, tested against the same behaviors, reviewed by the critic, fixed in a bounded loop (three build-fix rounds, two test-fix rounds, two critic rounds), and written up in a `PORT.md`. The `report` stage runs once every target has ended, however it ended.

Devices are managed for you: the harness boots a headless emulator or an iPhone simulator when none is running, reuses one that is, dismisses stale system dialogs before each launch, and shuts down the devices it booted itself when the run ends.

## Troubleshooting

- **`mpf doctor` says there is no Claude login, but you are logged in.** nvm keeps global CLIs per Node version, so a `claude` installed under another Node is not on PATH. The Agent SDK still finds the login; either install `claude` under this Node or ignore the line.
- **Xcode is installed but `xcode-select` points at the Command Line Tools.** The harness resolves `DEVELOPER_DIR` itself and keeps working. `sudo xcode-select -s /Applications/Xcode.app` makes Xcode the default for everything else.
- **Gradle fails with `java.lang.IllegalArgumentException: 27` or similar.** The JDK is newer than Gradle supports. The factory's own builds need JDK 17 to 24; Homebrew's plain `openjdk` tracks the newest release, so install `openjdk@21`. Run `gradle --stop` after switching JDKs. A source app's own wrapper may need an older JDK still; the harness picks one by the wrapper's version, and a JDK unpacked under `<data dir>/jdks` counts.
- **`brew install maestro` installs the wrong thing.** The mobile testing tool is `brew trust mobile-dev-inc/tap && brew install --formula mobile-dev-inc/tap/maestro`.
- **Web observation says "unverified".** Playwright's Chromium is missing: `npx playwright install chromium` (from a source checkout, `pnpm --filter @mpf/analyzer exec playwright install chromium`). The port still runs; the behaviors are just not verified on the source.
- **Every iOS flow fails at once.** A stale "Open in …?" dialog from an earlier URL-scheme launch hides the whole app. The harness dismisses it before each launch; if one is stuck, shut the simulator down.
- **Every Android flow fails at once.** A stale system dialog (an "isn't responding" prompt, a crash dialog, or an "Open with" chooser) covers the app. The harness detects and dismisses these; if an "Open with" chooser keeps appearing, uninstall leftover `app.mpf.*` packages from the emulator.
- **"already being driven by another process".** One process drives a run at a time. Stop the other driver (a daemon or a `run-control` script) before resuming or re-running here.
- **Flows die part-way under load.** Maestro batches fail without a report on a busy machine. Keep the machine quiet during device runs.
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

Driving a run without the daemon, while iterating on stages: `pnpm tsx scripts/run-control.ts <runId> resume|rerun <stageId>|answer <stageId> <choice> [note]|status`, with `--until <stage>`, `--budget <usd>`, and `--core auto|always|never` on `resume`, `--approve` on `rerun`, or `new <source> --to ios,android [--until <stage>] [--budget <usd>] [--core …] [--yes]` to create one in-process on the current code. Set `MPF_HOME` to the same directory the daemon serves to see the run in the dashboard. `scripts/compile-flows.ts <runId> <target>` recompiles a target's end-to-end flows from the stored BehaviorSpec without a device, and `scripts/spike-target-scaffold.ts --target android|ios|web [--framework <flavor>] [--e2e] [--core]` exercises a scaffold, build, launch, flow, and shared-core parity with no LLM.

Fixtures: `fixtures/manifest.json` pins public apps by git URL, ref, and commit (`pnpm fixtures:sync` clones them into `fixtures/.cache` and fills unpinned commits; `--id <fixture>` syncs one; `--repin` moves the pins) and lists the in-house ones under `fixtures/inhouse/`: `web-vanilla-counter` (tiny; the core stays off), `web-vanilla-cart` (about 150 lines of pure pricing logic for the shared core), `ios-uikit-notes` (Swift, UIKit, XcodeGen spec, XCTest), `ios-objc-notes` (Objective-C, XCTest), and `android-views-java-notes` (Java, XML layouts, JUnit). Every in-house fixture has a test id on every interactive element, and the mobile ones ship their own unit tests, which the observe stage records as the `source` result. `packages/adapters/test/detect.test.ts` checks the in-house fixtures and `fixture-matrix.test.ts` the synced public ones.

CI (`.github/workflows/ci.yml`) runs lint, format check, typecheck, the tests (with Rust and Chromium installed so the core ABI and observe tests run), the fake pipeline end to end, the dashboard build, and the bundled CLI on Linux and macOS; the four web scaffold flavors with a Playwright flow; the in-house mobile fixtures building and passing their own tests; and the public fixture matrix sync and detection. Real-LLM and device-driven port runs are not in CI.

To add a platform or framework, implement `SourceAdapter` or `TargetAdapter` from `packages/adapters/src/types.ts`, register it, and add a fixture; `docs/ADAPTERS.md` walks through it. `docs/ARCHITECTURE.md` is the design and where the code differs from it, and `docs/ABI.md` is the shared-core contract.

## Releasing and publishing

The published package is `@multiplat/factory`, built from `apps/cli` with every `@mpf/*` package inlined and the static dashboard copied next to the binary. Its npm page is `apps/cli/README.md`.

1. Bump the version in `apps/cli/package.json`. The CLI reads it from there at run time, so that is the only place it lives.
2. Build and pack: `pnpm tsx scripts/release.ts`. It builds the dashboard, bundles the CLI with tsup, runs `mpf --help` from the bundle, and packs the tarball into `dist-release/`, printing its contents (about 1.2 MB, with source maps).
3. Try the tarball in a clean project: `mkdir /tmp/try && cd /tmp/try && npm init -y && npm i <repo>/dist-release/multiplat-factory-<version>.tgz && npx mpf doctor && npx mpf serve`.
4. Log in to npm and confirm you can publish to the scope: `npm login`, then `npm access list packages multiplat`. If the `multiplat` org is not yours, create it on npmjs.com or rename the package.
5. Publish: `pnpm tsx scripts/release.ts --publish`. It rebuilds, then runs `pnpm publish --access public --no-git-checks` from `apps/cli`; with two-factor auth on, npm prompts for a one-time code.
6. Verify from another machine: `npm view @multiplat/factory version` and `npx @multiplat/factory doctor`.

The GitHub repository is linked from the package metadata and this README, so make it public before publishing or expect dead links.

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
