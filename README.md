# ⚙️ Multiplat Factory

If you have an app that runs on one platform: the web, iOS, or Android, this Multiplat Factory will help you publish to the others. Point this tool at the app, name the platforms you want, and it builds working native apps for them, tests that they behave and look like the original, and writes up what it did. It even has design, annotation, and implementation, which can be useful for going from small screen to large.

It runs on your own machine, uses your own agent accounts, and you decide on the budget cap.

https://github.com/user-attachments/assets/145f78c3-7b22-4a36-b986-779a44c52e98

## How it works

The factory reads your app's code and works out what the app does: its screens, its controls, and the things a user can do with it (we call those **behaviors**). It then runs the original app and checks each behavior really works there, so it will infer what "correct" looks like. Next it plans the port, and Claude writes the code for each new platform. The factory builds that code, installs it on a simulator or emulator or in a browser, and runs the same behaviors against it. You can speak directly to the agent within the run as well.

Failures go back to the agent to fix, a limited number of times. A second, independent agent session reviews the finished port and scores it. Finally a `PORT.md` file per platform records what shipped, what passed, what failed, and what you chose to accept.

There are a couple of design principles:

- **An agent never decides what happens next.** The order of steps, the retry limits, the budget, and the pass or fail decisions are fixed code. The agent only writes files.
- **Everything is checked against the real app.** Behaviors are verified on the original before anything is written, and the ports are tested with real behaviors.
- **Leverage WASM for Portability** When your app has a good amount of logic that is not user interface (pricing rules, validation, data handling), the factory can pull that logic out into one **shared core**: a small Rust program compiled to WebAssembly that runs unchanged on web, iOS, and Android. It records the original app's real outputs for many inputs and checks the core gives the same answers on every platform.

A dashboard in your browser shows all of this live: where a run is, what it is spending, what is failing, and when it needs a decision from you.

## What it supports

| Your app is on | It can read                                                                                                          | It produces                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Web            | Vite, Next, Nuxt, SvelteKit, Angular, any npm project with build or dev scripts, or plain static HTML                | A Vite app in vanilla JavaScript, React 19, Vue 3, or Svelte 5 (you choose, or the plan does) |
| iOS            | Xcode projects and workspaces, XcodeGen `project.yml` files, Swift packages. Swift or Objective-C. UIKit or SwiftUI. | A SwiftUI app, built and tested on the iPhone simulator                                       |
| Android        | Gradle projects. Kotlin or Java. Views or Jetpack Compose. Multi-module and flavored builds are fine.                | A Jetpack Compose app, built and tested on a headless emulator                                |

_Apps already built with a cross-platform framework (React Native, Flutter, Capacitor) are not supported_

## Install

The package is not on npm yet. Once it is:

```bash
npm i -g multiplat-factory
mpf doctor
```

From a packed tarball (`pnpm --filter multiplat-factory run prepublishOnly` builds the CLI, then `pnpm --filter multiplat-factory pack` writes `apps/cli/multiplat-factory-<version>.tgz`; see [Releasing and publishing](#releasing-and-publishing)):

```bash
npm i -g apps/cli/multiplat-factory-0.1.1.tgz
mpf doctor
```

From source, every `mpf` command runs as `pnpm mpf <command>`:

```bash
git clone https://github.com/sdras/multiplat-factory.git
cd multiplat-factory
nvm use
pnpm install
pnpm mpf doctor
```

## Step by step instructions

1. **Check the machine.** `mpf doctor` prints one line per tool and says which platforms this machine can build for. `mpf doctor --json` prints the same report as JSON.
2. **Install what is missing.** `mpf setup` walks through the gaps doctor found and asks before running each install command (Homebrew on macOS, apt on Linux, winget on Windows). Anything that needs `sudo` runs only after you confirm that exact command. `mpf setup --yes` accepts every command that does not need sudo and prints the rest for you to run yourself. `mpf setup --dry-run` shows what would run and stops.
3. **Start the dashboard.** `mpf serve` runs the API and the dashboard on one address, `http://127.0.0.1:4310` by default (change it with `--port`, `--host`, or `MPF_PORT`). Leave it running. If you skip this, each command starts its own copy for as long as the command runs, so the dashboard disappears when the command ends.
4. **Port something.** `mpf port ./my-app --to ios,android` takes a folder or a git URL. It creates the run, prints a link to the run's dashboard page, and follows the run in the terminal until it finishes. The command exits with an error code unless the run succeeded or stopped where you told it to with `--until`. The first pause is plan approval: open the dashboard page, or run `mpf answer <runId> plan approve`.
5. **Read the result.** Each platform's project is in `~/.mpf/runs/<runId>/workspace/<target>/`. Its `PORT.md` lists what shipped, every behavior and whether its test passed, the reviewer's verdict, any deviations you accepted, and the parts of the shared core that were written by hand rather than recorded from the original. `report.json` in the run's folder holds the same data for tools. `mpf status <runId>` prints a one-line summary.

To rehearse the whole thing for free, with no Claude calls and no build tools:

```bash
mpf port fixtures/inhouse/web-vanilla-counter --to web,android --fake --yes
```

## Commands

| Command                                          | What it does                                                                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mpf doctor [--json]`                            | Checks Node, git, the package manager, Claude access, Xcode, Java, the Android SDK, Gradle, Rust, Maestro, and Playwright's Chromium. Says which platforms you can build for and what each gap costs you. |
| `mpf setup [--yes] [--dry-run]`                  | Installs what doctor reports missing, asking before each step.                                                                                                                                            |
| `mpf serve [--port <n>] [--host <h>]`            | Runs the daemon (the API, the live event stream, and the dashboard) until you stop it.                                                                                                                    |
| `mpf port <source> --to <targets> [options]`     | Ports a folder or git URL. Options are listed below.                                                                                                                                                      |
| `mpf runs`                                       | Lists runs with their status, source, targets, and cost.                                                                                                                                                  |
| `mpf status <runId>`                             | Shows one run's stages and its summary.                                                                                                                                                                   |
| `mpf resume <runId>`                             | Continues a paused run, including one that stopped at `--until`.                                                                                                                                          |
| `mpf answer <runId> <stageId> <choice> [--note]` | Answers a stage that is waiting for you. Stage ids look like `plan`, `test:android`, or `critique:ios`.                                                                                                   |
| `mpf rerun <runId> <stageId>`                    | Runs one stage again, plus everything after it. The rerun stages get a fresh allowance of fix rounds.                                                                                                     |
| `mpf instruct <runId> <stageId> "<text>"`        | Leaves a note for the Claude session that will work on that stage next.                                                                                                                                   |

Options for `mpf port`:

- `--to web,ios,android`: the platforms to build.
- `--budget <usd>`: the spending cap. Default 30, at most 500.
- `--core auto|always|never`: whether to build the shared core. `auto` says no when only one platform is requested, since there is nothing to share.
- `--web-framework vanilla|react|vue|svelte`: the framework for a web port.
- `--until <stage>`: pause after that stage.
- `--yes`: skip the plan approval and the pause before fix rounds.
- `--detach`: create the run and return right away instead of following it.
- `--fake`: run the rehearsal pipeline with no Claude calls and no build tools.

A run's stages, in order (use these names for `--until` and in stage ids): `ingest`, `inventory`, `spec`, `behaviors`, `observe`, `plan`, `core.extract`, `core.vectors`, `core.build`, then for each platform `generate`, `build`, `test`, `critique`, `fix`, and finally `report`.

## What you need

- **Node 22.13 or newer.** The repo's `.nvmrc` asks for 24, so run `nvm use` in a source checkout. On an older Node, `pnpm` itself can fail before anything starts with the error `Cannot find matching keyid`. That is the old Corepack shim; switching Node fixes it.
- **A way to use agents.** Either set `ANTHROPIC_API_KEY`, or log in to Claude Code on this machine (`claude`, then `/login`). Every call goes through your account and every run has a spending cap.
- **The build tools for the platforms you want.** `mpf doctor` lists what is present. `mpf setup` installs missing build tools. In short:
  - Web needs Playwright's Chromium, so the factory can watch the original app run.
  - Android needs a JDK between 17 and 24, the Android SDK with an emulator and an `android-36` system image, Gradle, and Maestro (the tool that taps and types on mobile devices).
  - iOS needs macOS with Xcode, an iOS simulator, XcodeGen, and Maestro.
  - A shared core needs Rust with the `wasm32-unknown-unknown` target.

  A platform whose tools are missing is skipped, and the run explain this.

iOS output can only be built on macOS. Web and Android output can be built on macOS or Linux.

## Pauses, budgets, and stopping early

A run can pause and wait for you at three points. Answer from the run's dashboard page or with `mpf answer`.

- **Plan approval** (on by default; `--yes` skips it) pauses after `plan`. Choices: `approve` or `reject`.
- **Before the first fix round** (`--yes` skips it) pauses `build` and `test` before they spend money on fixes. The pause shows the failures and how much the fix is allowed to cost. `continue` goes ahead, rebuilding or retesting first. `reject` cancels the run.
- **Reviewer escalation** pauses when the independent review cannot settle a platform within its rounds. `accept` records the remaining problems as deviations you have chosen to live with, marked as such in `PORT.md`. `reject` cancels the run.

`--until <stage>` pauses a run after that stage. Use it to read the analysis before anything is generated (`--until plan`), or to stop after the shared core is built (`--until core.build`). `mpf resume` carries on. If the named stage is the last one, the run finishes instead of pausing.

Every run has a spending cap: `--budget`, or the configured default of $30. The ceiling is $500. Cost is charged the moment a Claude session returns, and the run pauses when it reaches the cap. The CLI and the dashboard cannot raise a paused run's budget yet. From a source checkout, `pnpm tsx scripts/run-control.ts <runId> resume --budget <usd>` does it. For scale: a two-screen app costs about $15 to $40 per platform, and a dozen-screen app that talks to a live backend about $100 to $150.

## The dashboard

`mpf serve` serves the dashboard and the API from one process on your machine. There is nothing to deploy. The factory needs the simulators, emulators, build tools, and Claude login of the machine it runs on, so each person runs it locally. A hosted version for many users would need the six replacement points listed in `docs/HOSTED-SEAM.md`. None of that exists yet.

The pages:

- `/`: all runs.
- `/runs/new`: start a new run.
- `/runs/<id>`: one run, with its stage graph, live transcript, budget, and controls.
- `spec`: the app's screens and behaviors, marked with which ones were verified on the original.
- `plan`: the port plan, with approve and reject.
- `tests`: results per platform, with flows, screenshots, failure evidence, and the shared-core parity table.
- `critic`: the independent review's verdicts and findings.
- `core`: a playground for the shared core.
- `release`: a release checklist.
- `doctor`: the tool report.

The dashboard also has review tools for a project: a chat about the project that can propose changes, a design review that drafts three concept mockups to pick from, annotation of recorded screenshots with pins and notes, and the release checklist. Applying a proposal creates a new version of the project and reruns the stages it touches. These actions are also available to browser agents as WebMCP tools on the page. `docs/PROJECT-REVIEW.md` describes all of it, and `pnpm tsx scripts/review-demo.ts <screenshot.png> <port>` runs a demo against a throwaway database. The "Host on Netlify" card on the release page is for the generated web app, not for the factory itself.

When developing from source, the dashboard is not prebuilt: run the API with `pnpm mpf serve` on 4310 and the dashboard with `pnpm dev`, which reloads on changes at `http://localhost:4311` and forwards `/api` calls to the daemon. Use `localhost`, not `127.0.0.1`; the dev server listens on IPv6.

## Where data lives

Run data never goes inside your project. The data folder is `$MPF_HOME` if set, else `$XDG_DATA_HOME/mpf`, else `~/.mpf`. Inside:

- `mpf.sqlite`: the run database. Everything that happened is stored as a log of events, and every view is rebuilt from that log.
- `daemon.json`: the running daemon's address, so the other commands can find it.
- `runs/<runId>/`: one folder per run:
  - `source/`: a copy of the original app
  - `detection.json`, `inventory.json`, `appspec.json`, `behaviorspec.json`, `portplan.json`: the analysis and the plan
  - `observe/`: screenshots of the original app and its own test results
  - `core/`: the shared core's Rust code, the built WebAssembly module, and the recorded inputs and outputs in `vectors/*.json`
  - `workspace/<target>/`: the generated project, its `PORT.md`, and the test flows with their evidence
  - `report.json`: the run's report
  - `review/`: screenshot annotations
- `locks/`: one lock per run and one per device. Only one process drives a run at a time, and only one process uses the simulator or the emulator at a time.
- `jdks/`: JDKs you unpack here are found like installed ones. Some older apps come with a Gradle wrapper that needs an old JDK (Gradle 4 to 7 want JDK 8 to 16), and this lets you provide one without a package manager or sudo.
- `cache/`.

## Configuration

Settings come in layers, and later layers win: built-in defaults, then `config.json` in the data folder, then `mpf.config.ts`, `.js`, or `.json` in the current folder, then environment variables.

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

The values shown are the defaults, except the `toolchain` entries. Those are empty by default because the tools are found automatically (`DEVELOPER_DIR` or `xcode-select`, `JAVA_HOME`, `ANDROID_HOME`, Homebrew folders, PATH). Fill one in only when discovery picks the wrong thing.

Environment variables:

- `MPF_HOME`: the data folder
- `MPF_PORT` and `MPF_HOST`: the daemon's address
- `MPF_BUDGET_USD`: the default budget
- `MPF_MODEL_GENERATE`, `MPF_MODEL_CRITIC`, `MPF_MODEL_CHEAP`: which Claude models to use
- `ANDROID_HOME` or `ANDROID_SDK_ROOT`, `JAVA_HOME`, `DEVELOPER_DIR`: where the build tools are
- `ANTHROPIC_API_KEY`: Claude access
- `MPF_ANDROID_AVD`: which emulator image to start. Otherwise the first one found, or `mpf-api36` if there is none.
- `MPF_KEEP_DEVICES=1`: leave the emulator or simulator running after a run that started it
- `PLAYWRIGHT_BROWSERS_PATH`: where Playwright keeps its browsers

## Run stages

1. `ingest` copies the app and works out its platform and framework.
2. `inventory` parses the code and collects the test ids the app already has, so tests can find its controls.
3. `spec` and `behaviors` describe the app in platform-neutral terms: its screens, controls, navigation, and the things a user can do.
4. `observe` runs the original app and checks each behavior against it, takes screenshots, and runs the app's own test suite as a baseline. Web apps run in Chromium from a dev server or a production build. iOS and Android apps run on a simulator or emulator, driven by Maestro.
5. `plan` decides how to build each port and whether a shared core is worth it.
6. If so, `core.extract`, `core.vectors`, and `core.build` pull out the shared logic, record the original app's real outputs for many inputs, and compile the core.
7. For each platform: the project is scaffolded, Claude writes the code, the factory builds it and runs the same behaviors against it, the independent reviewer scores it, and problems go back for fixing within fixed limits (three build-fix rounds, two test-fix rounds, two review rounds). A `PORT.md` sums it up.
8. `report` runs once every platform has finished, however it finished.

Devices are handled for you. The factory starts a headless emulator or an iPhone simulator when none is running, reuses one that is, clears stale system dialogs before each launch, and shuts down the devices it started when the run ends.

## Troubleshooting

- **`mpf doctor` says there is no Claude login, but you are logged in.** nvm keeps global commands per Node version, so a `claude` installed under another Node is not on PATH. The factory still finds the login. Either install `claude` under this Node, or ignore the line.
- **Xcode is installed, but `xcode-select` points at the Command Line Tools.** The factory finds Xcode itself and keeps working. `sudo xcode-select -s /Applications/Xcode.app` makes Xcode the default for everything else too.
- **Gradle fails with `java.lang.IllegalArgumentException: 27` or similar.** The JDK is newer than Gradle supports. The factory's own builds need JDK 17 to 24. Homebrew's plain `openjdk` tracks the newest release, so install `openjdk@21` instead. Run `gradle --stop` after switching JDKs. The original app's own wrapper may need an older JDK still; the factory picks one by the wrapper's version, and a JDK unpacked under `<data folder>/jdks` counts.
- **`brew install maestro` installs the wrong thing.** The mobile testing tool is `brew trust mobile-dev-inc/tap && brew install --formula mobile-dev-inc/tap/maestro`.
- **Web observation says "unverified".** Playwright's Chromium is missing. Run `npx playwright install chromium` (from a source checkout, `pnpm --filter @mpf/analyzer exec playwright install chromium`). The port still runs; the behaviors just are not checked against the original.
- **Every iOS test fails at once.** A stale "Open in …?" dialog from an earlier launch is hiding the whole app. The factory dismisses it before each launch. If one is stuck, shut the simulator down.
- **Every Android test fails at once.** A stale system dialog (an "isn't responding" prompt, a crash dialog, or an "Open with" chooser) is covering the app. The factory detects and dismisses these. If an "Open with" chooser keeps coming back, uninstall leftover `app.mpf.*` packages from the emulator.
- **"already being driven by another process".** Only one process drives a run at a time. Stop the other one (a daemon or a `run-control` script) before resuming or rerunning here.
- **Tests die part-way when the machine is busy.** Maestro gives up without a report under heavy load. Keep the machine quiet during device runs.
- **The run paused on its budget.** Raise it as described under [Pauses, budgets, and stopping early](#pauses-budgets-and-stopping-early), then resume.

## Developing the factory

```bash
nvm use
pnpm install
pnpm mpf serve      # the API on 4310
pnpm dev            # the dashboard with hot reload on http://localhost:4311
pnpm test           # vitest across every package; tests that need a missing tool skip themselves
pnpm typecheck
pnpm lint
pnpm format         # Prettier; `pnpm format:check` is what CI runs
pnpm mpf <command>  # run the CLI from source
```

To drive a run without the daemon while you work on a stage, use `scripts/run-control.ts`:

- `pnpm tsx scripts/run-control.ts <runId> resume|rerun <stageId>|answer <stageId> <choice> [note]|status` drives an existing run.
- `resume` also takes `--until <stage>`, `--budget <usd>`, and `--core auto|always|never`. `rerun` takes `--approve`.
- `pnpm tsx scripts/run-control.ts new <source> --to ios,android [--until <stage>] [--budget <usd>] [--core …] [--yes]` creates a run in this process, on the current code.

Point `MPF_HOME` at the same folder the daemon serves and the run appears in the dashboard. Two more scripts help. `scripts/compile-flows.ts <runId> <target>` recompiles a platform's test flows from the stored behaviors without a device. `scripts/spike-target-scaffold.ts --target android|ios|web [--framework <flavor>] [--e2e] [--core]` scaffolds, builds, launches, runs one flow, and checks shared-core parity with no Claude calls.

**Fixtures** are the sample apps the factory is tested against. `fixtures/manifest.json` pins public apps by git URL, branch, and commit. `pnpm fixtures:sync` clones them into `fixtures/.cache` and fills in missing commits; `--id <fixture>` syncs one, and `--repin` moves the pins forward. The manifest also lists the in-house fixtures under `fixtures/inhouse/`:

- `web-vanilla-counter`: tiny; the shared core stays off
- `web-vanilla-cart`: about 150 lines of pure pricing logic, made for the shared core
- `ios-uikit-notes`: Swift, UIKit, XcodeGen spec, XCTest
- `ios-objc-notes`: Objective-C, XCTest
- `android-views-java-notes`: Java, XML layouts, JUnit

Every in-house fixture has a test id on every interactive element, and the mobile ones ship their own unit tests, which the `observe` stage records as the `source` result. `packages/adapters/test/detect.test.ts` checks the in-house fixtures, and `fixture-matrix.test.ts` checks the synced public ones.

**CI** (`.github/workflows/ci.yml`) runs on Linux and macOS: lint, the Prettier check, typecheck, the tests (with Rust and Chromium installed so the core and observe tests run), the rehearsal pipeline end to end, the dashboard build, and the bundled CLI. It also builds the four web flavors and runs one Playwright flow on each, builds the in-house mobile fixtures and runs their own tests, and syncs the public fixtures and checks they are detected correctly. Runs that use real Claude calls or real devices are not in CI.

To add a platform or framework, implement `SourceAdapter` or `TargetAdapter` from `packages/adapters/src/types.ts`, register it, and add a fixture. `docs/ADAPTERS.md` walks through it. `docs/ARCHITECTURE.md` describes the design and where the code differs from it. `docs/ABI.md` is the contract between the shared core and its hosts.

## Releasing and publishing

The published package is `multiplat-factory`. It is built from `apps/cli`, with every `@mpf/*` package bundled in and the static dashboard copied next to it. Its npm page is `apps/cli/README.md`. The monorepo root is a separate package, `multiplat-factory-workspace`, and is never published.

A release is three steps:

1. **Bump the version** in `apps/cli/package.json`. That is the version npm gets; the CLI reads it from there at run time.
2. **Add a section to `CHANGELOG.md`** headed `## [<version>] - <date>` with what changed, and commit both.
3. **Run `pnpm release`.** It is `pnpm --filter multiplat-factory publish`: the CLI's `prepublishOnly` script builds the dashboard, bundles the CLI, and runs `mpf --help` from the bundle, then pnpm resolves the `catalog:` and `workspace:` versions, packs, and publishes. npm asks for your two-factor code in the terminal. pnpm refuses to publish from a branch other than `main` or with uncommitted changes.

Then check from another machine with `npm view multiplat-factory version` and `npx multiplat-factory doctor`.

Always publish with pnpm, never `npm publish` from `apps/cli`: npm leaves the `catalog:` versions unresolved and the package would not install. To build and inspect without publishing, run `pnpm release --dry-run`; it does everything but the upload and lists the tarball's contents. A version number can never be reused on npm, so a bad release gets a deprecation notice (`npm deprecate multiplat-factory@<version> "<reason>"`) and a fixed version right after it.

## Layout

- `apps/cli`: the `mpf` command
- `apps/server`: the HTTP API, the live event stream, the run daemon, and the project review routes
- `apps/dashboard`: the Nuxt dashboard
- `packages/core`: schemas, the event log, the SQLite store, config, the view reducer, the stage catalog
- `packages/orchestrator`: the stage graph, state machine, scheduler, the per-platform stages, review and fix, report, project revisions
- `packages/harness`: finding build tools, running processes, starting and stopping devices, lanes
- `packages/adapters`: everything that knows about a specific platform or framework: reading sources, generating targets, compiling test flows, and the shared core's host bindings
- `packages/analyzer`: the inventory, the spec and behaviors extraction, observing the original app, planning
- `packages/llm`: the Claude session wrapper, its sandbox rules, cost accounting, and a recorder
- `packages/critic`: the independent review
- `packages/wasm-core`: the Rust core template, its build runner, the Node host, the recorded vectors, and the core stages

Licensed under Apache-2.0; see `LICENSE`.
