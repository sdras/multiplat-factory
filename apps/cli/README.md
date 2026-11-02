# multiplat-factory

Port an app from one platform (web, iOS, Android) to the others. Give the factory a source
project, pick the targets, and it analyzes the app, verifies its behaviors on the original (a dev
server plus Chromium for web, a simulator or emulator plus Maestro for mobile), plans the port,
generates native projects (SwiftUI, Jetpack Compose, or a web app in vanilla, React, Vue, or
Svelte), builds and tests them against the same behaviors, has an independent critic review the
result, and writes a `PORT.md` per target. Optionally it extracts the shared, non-UI logic into a
Rust core compiled to WebAssembly that runs unchanged on all three platforms with golden-vector
parity tests.

## Quick start

```bash
npm i -g multiplat-factory   # or: npx multiplat-factory doctor
mpf doctor                     # what toolchains are present, what each gap disables (--json)
mpf setup                      # install what doctor reports missing, asking before each step (--yes, --dry-run)
mpf serve                      # the dashboard and API on http://127.0.0.1:4310 (--port, --host)
mpf port ./my-app --to ios,android --budget 30
mpf runs                       # runs so far; `mpf status <runId>` for one
```

Requires Node 22.13 or newer. The factory uses your own Claude credentials: `ANTHROPIC_API_KEY`,
or the Claude Code login on this machine. iOS targets need macOS with Xcode; web and Android
targets also run on Linux. A target whose toolchain is missing is skipped with a plain reason.

The dashboard runs on your machine next to the daemon, because the factory needs this machine's
simulators, emulators, toolchains, and Claude login. There is nothing to host. Commands start an
embedded daemon for their own lifetime when `mpf serve` is not running.

## Porting

`mpf port <path or git URL> --to web,ios,android` creates a run, prints its dashboard link, and
follows it in the terminal. Options: `--budget <usd>` (default 30, at most 500; the run pauses
when it is reached), `--core auto|always|never` for the shared WASM core (`auto` declines when
only one target is requested), `--web-framework vanilla|react|vue|svelte`, `--until <stage>`
(pause after that stage, for example `plan`), `--yes` (skip the plan approval and fix-loop
checkpoints), `--detach` (create the run and return), and `--fake` (a pipeline with no LLM and
no toolchains, to exercise the factory). Without `--detach` it exits non-zero unless the run
succeeded or stopped where `--until` asked.

Stage kinds, in order: `ingest`, `inventory`, `spec`, `behaviors`, `observe`, `plan`,
`core.extract`, `core.vectors`, `core.build`, then per target `generate`, `build`, `test`,
`critique`, `fix`, and finally `report`. Stage ids look like `plan`, `test:android`, or
`critique:ios`.

Each target's project lands in `~/.mpf/runs/<runId>/workspace/<target>/` with its `PORT.md`:
what shipped, every behavior and whether its flow passed, the critic's verdict, and any accepted
deviations.

## Checkpoints

A run pauses for you at three checkpoints: plan approval (`approve` or `reject`), before the first
paid fix round of a build or test stage (`continue` or `reject`; `--yes` skips both of these), and
critic escalation, when the critic cannot settle a target within its rounds (`accept` turns the
remaining findings into accepted deviations recorded in `PORT.md`; `reject` cancels). Answer from
the dashboard or with the control commands:

```bash
mpf answer <runId> <stageId> <choice> [--note "..."]   # e.g. mpf answer 01M... plan approve
mpf resume <runId>                                      # continue a paused run, or past a --until stop
mpf rerun <runId> <stageId>                             # re-run one stage and everything after it
mpf instruct <runId> <stageId> "text"                   # queue an instruction for a stage's next worker
```

## Data and configuration

Run data lives under `~/.mpf` (or `$MPF_HOME`, or `$XDG_DATA_HOME/mpf`), never inside your
project: the SQLite run store, `runs/<runId>/` with the copied source, the analysis, the
observation screenshots, the shared core, and each target's workspace, plus `jdks/` for JDKs you
unpack by hand for old Gradle wrappers.

Toolchains are discovered (`DEVELOPER_DIR` or `xcode-select`, `JAVA_HOME`, `ANDROID_HOME`,
Homebrew prefixes, PATH) with overrides in `~/.mpf/config.json`: `models` (`generate`, `critic`,
`cheap`), `effort`, `budget.defaultUsd`, `concurrency`, `toolchain` (`androidHome`, `javaHome`,
`developerDir`, `maestro`, `cargo`), `server` (`host`, `port`), and `dataDir`. Environment
variables override the file: `MPF_HOME`, `MPF_PORT`, `MPF_HOST`, `MPF_BUDGET_USD`,
`MPF_MODEL_GENERATE`, `MPF_MODEL_CRITIC`, `MPF_MODEL_CHEAP`, `ANDROID_HOME`, `JAVA_HOME`,
`DEVELOPER_DIR`, `MPF_ANDROID_AVD` (the emulator image to boot), and `MPF_KEEP_DEVICES=1` (leave
the devices a run booted running).

Source code, the full guide with troubleshooting, the architecture, and the adapter interface for
adding frameworks: https://github.com/sdras/multiplat-factory
