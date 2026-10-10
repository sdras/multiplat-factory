# @multiplat/factory

Port an app from one platform (web, iOS, Android) to the others. Give the factory a source
project, pick the targets, and it analyzes the app, verifies its behaviors on the original (a dev
server plus Chromium for web, a simulator or emulator plus Maestro for mobile), plans the port,
generates native projects (SwiftUI, Jetpack Compose, or a web app in vanilla, React, Vue, or
Svelte), builds and tests them against the same behaviors, has an independent critic review the
result, and writes a `PORT.md` per target. Optionally it extracts the shared, non-UI logic into a
Rust core compiled to WebAssembly that runs unchanged on all three platforms with golden-vector
parity tests.

```bash
npm i -g @multiplat/factory   # or: npx @multiplat/factory doctor
mpf doctor                     # what toolchains are present, what to install
mpf setup                      # install what doctor reports missing, asking before each step (--yes, --dry-run)
mpf serve                      # the dashboard and API on http://127.0.0.1:4310
mpf port ./my-app --to ios,android --budget 30
mpf runs                       # runs so far; `mpf status <runId>` for one
```

`mpf port` takes `--to web,ios,android`, `--budget <usd>`, `--core auto|always|never`,
`--web-framework vanilla|react|vue|svelte`, `--until <stage>` (pause after that stage, for example
`plan`), `--yes` (skip the plan approval checkpoint), `--detach` (create the run and return), and
`--fake` (a pipeline with no LLM and no toolchains, to exercise the factory). Without `--detach`
it follows the run in the terminal and exits non-zero unless the run succeeded or stopped where
`--until` asked.

A run pauses for you at two checkpoints: plan approval (`approve` or `reject`) and critic
escalation, when the critic cannot settle a target within its rounds (`accept` turns the remaining
findings into accepted deviations recorded in `PORT.md`; `reject` cancels). Answer from the
dashboard or with the control commands:

```bash
mpf answer <runId> <stageId> <choice> [--note "..."]   # e.g. mpf answer 01M... plan approve
mpf resume <runId>                                      # continue a paused run, or past a --until stop
mpf rerun <runId> <stageId>                             # re-run one stage and everything after it
mpf instruct <runId> <stageId> "text"                   # queue an instruction for a stage's next worker
```

Requires Node 22.13 or newer. The factory uses your own Claude credentials: `ANTHROPIC_API_KEY`,
or the Claude Code login on this machine. Every run has a budget cap that is always enforced;
the run pauses when it is reached. Run data lives under `~/.mpf` (or `$MPF_HOME`), never inside
your project. Commands start an embedded daemon when `mpf serve` is not running.

Toolchains are discovered (`DEVELOPER_DIR` or `xcode-select`, `JAVA_HOME`, `ANDROID_HOME`, PATH)
with overrides in `~/.mpf/config.json`. A target whose toolchain is missing is skipped with a
plain reason; iOS needs macOS with Xcode, web and Android also work on Linux.

Source code, architecture, and the adapter interface for adding frameworks:
https://github.com/multiplat/factory
