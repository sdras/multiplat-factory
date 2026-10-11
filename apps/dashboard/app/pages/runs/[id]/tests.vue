<script setup lang="ts">
import type { Artifact } from '@mpf/core/schemas'

const annotating = ref<Artifact>()
const review = useProjectReview()
const { isBoard } = useDashboardStyle()
const route = useRoute()
const id = String(route.params.id)
const api = useApi()
const { view, error } = useRunView(id)

const targets = computed(() => view.value.run?.targets ?? [])
/** The source app's own suite (run by the observe stage) sits above the targets it is the baseline for. */
const rows = computed(() => [
  ...(view.value.tests.some((t) => t.target === 'source') ? ['source'] : []),
  ...targets.value,
])
const kinds = ['build', 'unit', 'launch', 'e2e', 'parity', 'screenshot'] as const
const latest = (target: string, kind: string) =>
  [...view.value.tests].reverse().find((t) => t.target === target && t.kind === kind)
const contentUrl = (a: Artifact) => `${api.base}/runs/${id}/artifacts/${a.id}/content`
const screens = computed(() => {
  const ids = new Set<string>()
  for (const a of view.value.artifacts)
    if ((a.kind === 'source-screenshot' || a.kind === 'target-screenshot') && a.meta.screenId)
      ids.add(String(a.meta.screenId))
  return [...ids]
})
const shot = (screenId: string, target?: string) =>
  [...view.value.artifacts]
    .reverse()
    .find(
      (a) =>
        a.meta.screenId === screenId &&
        (target
          ? a.kind === 'target-screenshot' && a.meta.target === target
          : a.kind === 'source-screenshot'),
    )
/** Only the latest result per target and kind counts; earlier rounds of the fix loop are history. */
const latestResults = computed(() => {
  const byKey = new Map<string, (typeof view.value.tests)[number]>()
  for (const t of view.value.tests) byKey.set(`${t.target}:${t.kind}`, t)
  return [...byKey.values()]
})
/** Behaviors whose flow has a step the compiler could not express (a custom step, an unhooked check): a failure there does not block the target (the test stage's log says so). */
const partialOf = (target: string) => view.value.partialFlows[target] ?? []
const failing = computed(() =>
  latestResults.value.flatMap((t) =>
    t.cases
      .filter((c) => c.status === 'fail' || c.status === 'flaky')
      .map((c) => ({
        target: t.target,
        kind: t.kind,
        ...c,
        partial: !!c.behaviorId && partialOf(t.target).includes(c.behaviorId),
        // A system dialog over the app explains the whole failure; the evidence summary leads with it.
        ...splitDialogLine(c.message),
      })),
  ),
)
const failingCounts = computed(() => {
  const n = { fail: 0, flaky: 0, partial: 0 }
  for (const c of failing.value) {
    if (c.partial) n.partial++
    else if (c.status === 'flaky') n.flaky++
    else n.fail++
  }
  return [
    n.fail ? `${n.fail} failing` : '',
    n.flaky ? `${n.flaky} flaky` : '',
    n.partial ? `${n.partial} partial (a step the compiler could not express, not blocking)` : '',
  ]
    .filter(Boolean)
    .join(' · ')
})

/** Golden-vector parity: one row per vector, one column per host that ran it (the core itself, then each target). */
const parity = computed(() => {
  const latestByTarget = new Map<string, (typeof view.value.tests)[number]>()
  for (const t of view.value.tests) if (t.kind === 'parity') latestByTarget.set(t.target, t)
  const hosts = [...latestByTarget.keys()].sort((a, b) =>
    a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b),
  )
  const rows = new Map<string, Record<string, string>>()
  for (const host of hosts) {
    for (const c of latestByTarget.get(host)!.cases) {
      const key = c.id
      const row = rows.get(key) ?? {}
      row[host] = c.status
      rows.set(key, row)
    }
  }
  return { hosts, rows: [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)) }
})
</script>

<template>
  <div>
    <BoardHero
      v-if="isBoard"
      title="Tests &amp; previews"
      :description="
        view.run
          ? `Test results and screenshots for ${projectName(view.run.source.locator)}. Expand a result to see the details.`
          : 'Compare test results and screenshots with the original app.'
      "
      art="tests"
    />
    <p v-if="!isBoard" class="muted">
      <NuxtLink :to="`/runs/${id}`">← Run</NuxtLink> ·
      <NuxtLink :to="`/runs/${id}/spec`">Spec</NuxtLink> ·
      <NuxtLink :to="`/runs/${id}/plan`">Plan</NuxtLink>
    </p>
    <h1 v-if="!isBoard">Tests</h1>
    <p v-if="error" class="callout">{{ error }}</p>
    <template v-else-if="view.run">
      <BoardTestSummary v-if="isBoard" :view="view" />
      <div v-else class="panel board-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Target</th>
              <th v-for="k in kinds" :key="k">
                {{
                  isBoard
                    ? {
                        build: 'Builds successfully',
                        unit: 'Individual functions',
                        launch: 'App opens',
                        e2e: 'User flows',
                        parity: 'Same results',
                        screenshot: 'Screens & layout',
                      }[k]
                    : k
                }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in rows" :key="t">
              <td>
                <b>{{ t }}</b
                ><span v-if="t === 'source'" class="muted"> (own suite)</span>
              </td>
              <td v-for="k in kinds" :key="k">
                <template v-if="latest(t, k)">
                  <span class="badge" :class="latest(t, k)!.status">{{
                    latest(t, k)!.status
                  }}</span>
                  <span class="muted">
                    {{ latest(t, k)!.summary.passed }}/{{ latest(t, k)!.summary.total
                    }}<span v-if="latest(t, k)!.summary.flaky">
                      · {{ latest(t, k)!.summary.flaky }} flaky</span
                    ><span v-if="k === 'e2e' && partialOf(t).length">
                      · {{ partialOf(t).length }} partial</span
                    ></span
                  >
                  <div v-if="latest(t, k)!.skipReason" class="muted" style="font-size: 12px">
                    {{ latest(t, k)!.skipReason }}
                  </div>
                </template>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!view.tests.length" class="muted">
          No results yet. They appear as each target's test stage runs.
        </p>
      </div>

      <template v-if="failing.length">
        <h2>
          Failing and flaky cases <span class="muted small">{{ failingCounts }}</span>
        </h2>
        <div class="panel board-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Target</th>
                <th>Kind</th>
                <th>Case</th>
                <th>Status</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in failing" :key="c.target + c.kind + c.id">
                <td>{{ c.target }}</td>
                <td>{{ c.kind }}</td>
                <td>
                  {{ c.name }} <code v-if="c.behaviorId" class="muted">{{ c.behaviorId }}</code>
                </td>
                <td>
                  <span
                    v-if="c.partial"
                    class="tag warn"
                    title="This flow has a step the compiler could not express, so its failure does not block the target"
                    >partial</span
                  >
                  <span v-else class="badge" :class="c.status">{{ c.status }}</span>
                </td>
                <td style="font-size: 12px">
                  <div v-if="c.dialog" class="dialog">
                    <UiIcon name="warn" :size="12" />
                    <b>{{ c.dialog }}</b>
                  </div>
                  <details v-if="isBoard" class="board-test-note">
                    <summary>Technical evidence</summary>
                    <p class="muted" style="white-space: pre-wrap; overflow-wrap: anywhere">
                      {{ c.rest }}
                    </p>
                  </details>
                  <span v-else class="muted" style="white-space: pre-wrap">{{ c.rest }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <template v-if="parity.hosts.length">
        <h2>Shared core parity</h2>
        <p class="muted">
          Every host runs the same golden vectors against the same WebAssembly module; a cell is one
          vector on one host.
        </p>
        <div class="panel board-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Vector</th>
                <th v-for="h in parity.hosts" :key="h">{{ h === 'core' ? 'rust (native)' : h }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="[vector, byHost] in parity.rows" :key="vector">
                <td>
                  <code>{{ vector }}</code>
                </td>
                <td v-for="h in parity.hosts" :key="h">
                  <span v-if="byHost[h]" class="badge" :class="byHost[h]">{{ byHost[h] }}</span
                  ><span v-else class="muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <h2>Screens: source vs targets</h2>
      <button class="btn review-page-action" @click="review.showDesign()">
        Explore 3 design directions
      </button>
      <p v-if="!screens.length" class="muted">
        Screenshots appear after the observe stage (source) and each target's test stage.
      </p>
      <div v-for="s in screens" :key="s" class="panel" style="margin-bottom: 14px">
        <b
          ><code>{{ s }}</code></b
        >
        <div class="row" style="align-items: flex-start; margin-top: 8px">
          <figure style="margin: 0; max-width: 360px">
            <figcaption class="muted">
              Source
              <button v-if="shot(s)" class="btn annotate-button" @click="annotating = shot(s)">
                Annotate
              </button>
            </figcaption>
            <img
              v-if="shot(s)"
              :src="contentUrl(shot(s)!)"
              :alt="`${s} on source`"
              style="width: 100%; border: 1px solid var(--border); border-radius: 6px"
            />
            <p v-else class="muted">—</p>
          </figure>
          <figure v-for="t in targets" :key="t" style="margin: 0; max-width: 220px">
            <figcaption class="muted">
              {{ t }}
              <button
                v-if="shot(s, t)"
                class="btn annotate-button"
                @click="annotating = shot(s, t)"
              >
                Annotate
              </button>
            </figcaption>
            <img
              v-if="shot(s, t)"
              :src="contentUrl(shot(s, t)!)"
              :alt="`${s} on ${t}`"
              style="width: 100%; border: 1px solid var(--border); border-radius: 6px"
            />
            <p v-else class="muted">—</p>
          </figure>
        </div>
      </div>
    </template>
    <PreviewAnnotator
      v-if="annotating"
      :run-id="id"
      :artifact="annotating"
      @close="annotating = undefined"
    />
  </div>
</template>

<style scoped>
/* The dialog line explains the failure on its own, so it leads the message in the warning color. */
.dialog {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--warn);
  margin-bottom: 4px;
  line-height: 1.4;
}
.dialog svg {
  flex-shrink: 0;
  margin-top: 2px;
}
</style>
