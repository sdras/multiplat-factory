# Running the factory somewhere other than a laptop

The factory is local-first: one process, SQLite under `~/.mpf`, toolchains on the same
machine, the user's own Claude credentials. Nothing in the pipeline assumes that, though.
These are the seams a hosted or CI deployment plugs into, in the order they matter.

## 1. `RunStore` (`packages/core/src/store/types.ts`)

Every read and write of runs, stages, events, and artifacts goes through this interface;
`SqliteRunStore` (`node:sqlite`) is the only implementation today. A hosted deployment
implements it over Postgres (or any store with a monotonic per-run event sequence).
Requirements that are easy to miss:

- `listEvents(runId, after)` must return events in `seq` order; the dashboard and the CLI
  replay from an arbitrary `seq` after a reconnect.
- `upsertStage` and `updateRun` are called from concurrent stage completions and from
  `chargeCost` while a stage is still running; the SQLite store serializes them in-process,
  a shared store needs row-level atomicity.
- Artifacts are recorded by run-directory-relative path. The bytes live on disk under the run
  directory, so a hosted store pairs with an object store (see 4).

## 2. `StageRunnerRegistry` and `Orchestrator` (`packages/orchestrator`)

The orchestrator is a pure scheduler over the store: the only in-memory state is the
in-flight abort controllers, the per-stage instruction queues, the pending human answers, and
the cost already charged to running stages (`Live`). Running it in a worker that can be
restarted is safe as long as the store is shared; a `paused` or `running` run resumes from
the stage records. Two options matter for hosting:

- `registry` can be a resolver `(run) => StageRunnerRegistry`, which is how the fake and the
  real pipelines coexist. A hosted mode can route `generate:<target>` stages to a different
  machine class (macOS for iOS) by returning runners that enqueue remote work and report
  outcomes through the same `StageOutcome` shape.
- `concurrency` caps LLM workers; device lanes (`packages/harness/src/lanes.ts`) cap
  simulators and emulators per process. On a fleet, replace `Lanes` with a distributed
  semaphore, or give each worker its own devices.

Two pieces of in-memory state need a home when the process can restart between requests: a
human answer (`answer()` re-queues the stage and hands the choice to it when it starts) and
queued instructions (`instruct()` holds them until the stage's next worker starts). Persist
both, or make sure the same process serves the answer and the restart.

## 3. `AgentFn` (`packages/analyzer/src/worker.ts`) and `runAgent` (`packages/llm`)

Every LLM call goes through `runWorker`, which takes an `AgentFn`. The default runs the
Claude Agent SDK in-process with the user's login or `ANTHROPIC_API_KEY`. A hosted
deployment substitutes an `AgentFn` that runs the same `AgentRunOptions` in a sandbox with
the tenant's credentials, and returns `AgentRunResult` (including `sessionId` so fix loops
can resume, and `costUsd` so budgets hold). The permission policy
(`packages/llm/src/permissions.ts`) is a pure function of the options; keep applying it
wherever the tools execute. `runWorker` keeps a `sessions.json` ledger in the run directory
so a resumed session, whose result reports the whole session's spend, is charged only for
the increment; a hosted `AgentFn` must report costs the same way or keep that file in sync.

## 4. Run directory and artifacts

Stages read and write `run.runDir` (source checkout, observation output, workspaces, core
crate, screenshots, PORT.md, the session ledger). The daemon serves artifact bytes from that
directory. For hosting, mount the run directory on shared storage or sync it to an object
store when a stage ends; the `artifact.added` event carries the relative path, size, and
hash needed for the upload (a directory artifact such as an iOS `.app` has a size and no
hash).

## 5. `RunEventBus` (`packages/core/src/events/bus.ts`)

In-process fan-out to SSE subscribers. Multiple API instances need a broadcast channel
(Postgres `LISTEN/NOTIFY`, Redis pub/sub) behind the same `subscribe`/`subscribeAll` API;
the payloads are already the persisted `Event` rows, so replay and live streams stay
identical.

## 6. Config and credentials

`loadConfig` (`packages/core/src/config.ts`) layers defaults, `~/.mpf/config.json`,
`./mpf.config.{ts,js,json}`, and environment variables (`MPF_HOME` picks the data
directory). A hosted deployment sets `MPF_HOME`, toolchain paths, and model defaults per
worker, and supplies credentials per tenant to the `AgentFn` rather than through the process
environment.

## What does not change

Schemas (`packages/core/src/schemas`), the stage graph and state machine, adapters,
prompts, the critic, the flow compilers, and the dashboard. A run created on a laptop and a
run created in a hosted deployment produce the same events, artifacts, and PORT.md.
