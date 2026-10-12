# Project chat and preview review

Project chat is available in both dashboard styles. It uses the configured cheap Claude model and the existing Claude credentials. Questions are read-only model sessions; proposed revisions require a separate Apply changes action and budget. Fake runs give explicitly labelled demo replies and never call a model.

A project is currently identified by its exact source locator. Conversation, feedback, visual direction and revision proposals follow its versions. Release checklist progress is scoped to a version and platform. All of these records are persisted as `review.entry` events. Annotation coordinates are normalized to the captured image, and saving a note copies the image into an immutable review artifact. Rebuilding never moves an old annotation onto a different image.

In Tests & previews, choose Annotate, draw a pin, arrow, rectangle or pen path, and add a note. Save additional notes or choose Save & discuss to attach them to the composer. Notes can be discussed, resolved and reopened in the Feedback tab. The annotation editor works on recorded screenshots, including native captures; it does not embed or capture a running web app yet. Keyboard users can leave text-only feedback or add a center pin.

Applying a proposal creates a new version from the captured source. Source analysis is reused; a plan revision reruns planning and pauses for approval. An app revision reuses the approved plan and shared core, regenerates the selected platforms and reruns their build/test/review stages. The previous implementation and selected feedback images are made available to the generation worker as references. The original run and release remain available. A revision cannot be applied while its parent still has running stages. Copying a revision currently happens synchronously; very large source trees may take time. Dependency caches and build output are excluded.

Chat reserves up to $1 from the version budget before calling the model and settles to reported cost afterward, including failed model calls that report spend. Interrupted calls with unknown cost conservatively retain the reservation. Each conversation allows one reply in flight per server process. Existing pipeline budget behavior is unchanged; the chat reservation is visible to subsequent stage scheduling. A chat reply is returned as a whole, rather than streamed token by token.

## Design review

Choose **Explore 3 design directions** from the plan or previews page, or **Design review · 3 directions** in chat. Select a platform and optionally describe what to preserve or change. Every design review begins with exactly three concept mockups: A, B, and C. The model reads the app specification, plan and available source/target screenshots. Schema validation requires three unique option IDs and three different layout structures; incomplete responses fail without offering a partial set.

Mockups are rendered from a constrained, data-only schema: palette, typography, corners, navigation, app content, action labels and layout. No model-generated HTML, JavaScript or remote assets are executed. They are small illustrative concepts, not live apps or production-ready pixel specifications. The current layouts are sidebar, topbar and list-detail, with narrow-screen variants. Demo runs use explicitly labeled task-app examples; real runs use the existing configured model and chat budget cap. This does not introduce an OpenAI provider connection.

Before generating options, the setup asks **Would you like to add Impeccable?** Neither answer is preselected. Yes installs the official `impeccable@4.5.2` CLI's Claude skill into `<runDir>/.factory-skills/impeccable`, project-scoped with `--no-hooks`. It does not install into the user's source repository or global skill settings. npm may use its normal download cache. The skill and design references are explicitly supplied to the review model; the selected revision receives a copy under `source/.mpf-review/impeccable` with instructions for the planner and generation workers. No skips installation and skill guidance. Demo runs record the choice but do not download or claim to use the skill. Failures stop before the model call, allowing a retry or a choice to continue without it. The stored review records the choice and installed skill version. The integration uses design guidance within the existing tool permissions; it does not enable Impeccable hooks or automatically execute its detector or initialization scripts.

Selecting one option persists the choice and creates a proposal containing only that option's instructions and mockup specification. It never starts a build. Applying the proposal remains a separate budgeted action. The three alternatives and selected choice remain in project history. Selection is idempotent; a different choice requires a fresh review, avoiding silently changing an existing proposal. This is the first step of each design review, not a new automatic blocker on existing port jobs.

## Agent tools

The dashboard registers eleven tools through `document.modelContext` when supported. The regular UI remains usable without WebMCP. Registration uses an AbortSignal and is cleaned up when the app unmounts. Execution forwards cancellation to fetch; early implementations that omit the execution signal receive a local fallback. Tools are not exposed cross-origin.

- `list_projects`: find version IDs and status.
- `read_project`: read status, plan, tests, preview references, conversation, feedback, proposals, release checklist or designs.
- `start_design_review`: ask whether to add Impeccable, then create three mockups using the approved project budget; requires an explicit `impeccable` boolean and returns the saved review ID.
- `choose_design_direction`: record the user’s A/B/C selection and prepare a proposal, without starting work.
- `add_preview_feedback`: save a note and optional marks on a registered screenshot.
- `propose_revision`: save a concrete proposal for review.
- `apply_revision`: apply an approved proposal and budget to a new version.
- `answer_build_decision`: record an explicitly chosen pending decision.
- `resolve_feedback`: resolve or reopen a note.
- `set_visual_direction`: save direction for subsequent revisions.
- `update_release_checklist`: record manual completion, without publishing.

Read results use bounded text pages and return `nextOffset`; requesting that offset continues the same section. Tools call the same validated HTTP endpoints as the dashboard. Agent actions open the relevant project chat and leave a visible activity receipt. Repeated feedback request IDs and already-applied proposals are idempotent. General model chat is intentionally not a WebMCP tool: external agents can read context and save their own proposals without paying for a second model call. Design generation is exposed explicitly, with a budget-approval guard; selection also requires the user’s stated choice.

Tool strategy and scaffolding followed the user's WebMCP skill. Deterministic API/tool tests are in `apps/server/test/review.test.ts`; selection and journey eval cases are in `docs/evals/project-review.json`. These eval cases can be adapted to a browser-agent harness; they are not a claim of a completed live-model evaluation.

## Local verification

Use Node 24 (`nvm use`).

```sh
pnpm vitest run apps/server/test/review.test.ts apps/server/test/app.test.ts packages/orchestrator/test/runner.test.ts packages/core/test/reducer.test.ts
pnpm --filter @mpf/dashboard typecheck
pnpm --filter @mpf/dashboard build
pnpm tsx scripts/review-demo.ts /path/to/screenshot.png 4312
```

The demo uses its own temporary SQLite database and fake pipeline. It prints the URL and data directory, and does not change real projects. Stop it with Ctrl+C.

The new routes require restarting the API server. Do this after active ports finish; rebuilding the dashboard alone cannot update a running Node process. Do not run old and new API versions against a store containing new review events: older event schemas cannot read them.
