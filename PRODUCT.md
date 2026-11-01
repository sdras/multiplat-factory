# Product

<!-- impeccable:product-schema 1 -->

<!-- Written 2026-11-01 from CLAUDE.md and the design brief; no interview round was answered. Facts marked [inferred] are hypotheses to confirm. -->

## Platform

web

## Users

Developers and small teams who have an app on one platform (web, iOS, or Android) and want working builds on the others. They start a port from the CLI or the dashboard, then check back over the next 30 minutes to a few hours: approving the plan, answering a checkpoint before a fix loop, accepting or rejecting a critic escalation, topping up a budget, and diagnosing a stalled or failed stage by reading the worker transcript and failure evidence. [inferred] Most sessions are one person at a desk with the dashboard in a second window, glancing, not staring.

## Product Purpose

multiplat-factory ports an app from one platform to the others and proves the port: observed behaviors on the source app, compiled device flows on the targets, unit tests, a shared logic core checked against golden vectors, and a critic review, all written up in a PORT.md per target. The dashboard exists to steer and observe that process: see where a run is, what it is spending, what is failing, and what decision is waiting on a human. Success is a run that ends `succeeded` with the summary line a user can trust, and a user who was interrupted only at the checkpoints that needed them.

## Positioning

The orchestrator is deterministic TypeScript; LLM workers produce artifacts and never decide control flow. Every claim on the dashboard derives from an append-only event log through one isomorphic reducer, so the view a user sees is the same view the server's tests check. Budgets are enforced on every call. A neighbouring "AI builds your app" product cannot truthfully say its progress view is a replay of the truth or that its spend is capped per stage.

## Operating Context

- Served locally by `mpf serve` (API on 4310, dashboard on 4311) next to the machine's toolchains: Xcode, the iOS simulator, the Android emulator, Gradle, Maestro, Playwright, Rust.
- A run is a DAG of stages in lanes: Analyze (ingest, inventory, spec, behaviors, observe, plan), Core (extract, golden vectors, build core), one lane per target (generate, build, test, critic review, fix, with bounded fix rounds), and Finish (report).
- Live state arrives over SSE; stage transcripts carry worker messages, tool calls, process output and log lines.
- Typical runs cost $15 to $50; a large app with accounts on a live backend costs about $100 to $150. The default cap is $30; a run pauses at its cap for a top-up.
- Checkpoints that need a person: plan approval, the pause before a fix loop (with the failures and the worker's cap in the reason), and critic escalation (accept remaining findings as deviations, or reject).
- The pages today: Runs (list with status, source, targets, cost against cap, elapsed, stage sectors), New run, Doctor (toolchain readiness), and per run: the live run page (header, decision callout, result, lane timeline, stage transcript, run log, Now, Budget, Tests, Critic, Artifacts), Spec & behaviors, Plan, Tests & screens (per-target results and screenshots against the source), Critic, Core (parity matrix and playground), Release.

## Capabilities and Constraints

- Run statuses: queued, running, paused, waiting_human, succeeded, partial, failed, cancelled. Stage statuses: pending, queued, running, succeeded, failed, blocked, waiting_human, paused, skipped, cancelled.
- Test kinds per target: build, unit, launch, e2e (flows, with "partial" flows that do not block), parity, screenshot; the source's own suite is recorded as `source`.
- The critic returns a decision (pass, fix, escalate) with fidelity and test-adequacy scores out of 5 and a list of findings; accepted findings are recorded as deviations.
- Controls: pause, resume, cancel a run; re-run a stage; send an instruction to a running worker; answer a pending decision with an optional note.
- The dashboard imports only isomorphic core subpaths; no Node APIs. It is a general-purpose product and must never be tuned to one person's repos, habits, or machine.
- Undecided: whether the dashboard will ever be hosted remotely or multi-user. [inferred] Treat it as single-operator, local, for now.

## Brand Commitments

- Name: Multiplat Factory (`mpf` on the CLI).
- Binding constraints from the 2026-11-01 brief: clean, slick, easy to navigate; no purple anywhere; no commonly used AI-generated fonts or styles (the Inter / Space Grotesk / JetBrains Mono family of defaults, neon-on-black glow, gradient washes, cream-and-serif editorial).
- The current look (dark warm graphite, B612, Big Shoulders, one orange accent, lane timeline) is the incumbent; this round explores alternatives to it, not refinements of it.

## Evidence on Hand

- Real run outcomes recorded in CLAUDE.md's Status section (for example `android: 15/15 flows, 79/79 unit, critic escalate 3.8/5`, `web: 20/20 flows, 194/194 unit, critic pass 4.3/5`), with costs, turn counts, fix rounds and the fixtures they ran on (TodoMVC Vue/React/Svelte/Angular, RealWorld SvelteKit, android architecture-samples, Minimal-Todo, in-house notes apps, counter, cart).
- Stage descriptions, "what can go wrong" and "what you can do" text per stage in `packages/core/src/stages/catalog.ts`.
- No customer testimonials, logos, or pricing exist; do not invent any.

## Product Principles

- Status is a word beside a colour, never a colour alone.
- Interrupt the person only at a checkpoint, and say exactly what is being asked and what it costs.
- The event log is the truth; the dashboard shows derived state and never guesses.
- Spend is always visible against its cap, per stage and per run.
- Familiar operational affordances (pause, resume, re-run, answer) over invented ones.

## Accessibility & Inclusion

Keyboard-reachable controls throughout; text contrast at 4.5:1 or better including muted labels; status conveyed by label and shape as well as colour; long-running pages must stay legible at a glance from arm's length.
