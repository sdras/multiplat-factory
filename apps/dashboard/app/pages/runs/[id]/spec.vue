<script setup lang="ts">
import type { AppSpec, Artifact, BehaviorSpec, Run, Stage } from '@mpf/core/schemas'

const route = useRoute()
const id = String(route.params.id)
const api = useApi()
const run = ref<Run>()
const artifacts = ref<Artifact[]>([])
const spec = ref<AppSpec>()
const behaviors = ref<BehaviorSpec>()
const error = ref<string>()

const latest = (kind: Artifact['kind'], pred?: (a: Artifact) => boolean) =>
  [...artifacts.value].reverse().find((a) => a.kind === kind && (!pred || pred(a)))
const contentUrl = (a: Artifact) => `${api.base}/runs/${id}/artifacts/${a.id}/content`
const screenShot = (screenId: string) =>
  latest('source-screenshot', (a) => a.meta.screenId === screenId)
const behaviorShot = (behaviorId: string) =>
  latest('source-screenshot', (a) => a.meta.behaviorId === behaviorId)

onMounted(async () => {
  try {
    const snap = await api.get<{ run: Run; stages: Stage[]; artifacts: Artifact[] }>(`/runs/${id}`)
    run.value = snap.run
    artifacts.value = snap.artifacts
    const s = latest('appspec')
    const b = latest('behaviorspec')
    if (s) spec.value = await (await fetch(contentUrl(s))).json()
    if (b) behaviors.value = await (await fetch(contentUrl(b))).json()
  } catch (e) {
    error.value = (e as Error).message
  }
})

const verifiedCount = computed(
  () => behaviors.value?.behaviors.filter((b) => b.verifiedOnSource).length ?? 0,
)
// Takes `unknown` so the template needs no type cast (a generic in an interpolation reads as a tag to Prettier).
const stepText = (step: unknown) => {
  const s = step as Record<string, unknown>
  return [
    s.op,
    'element' in s ? s.element : 'screen' in s ? s.screen : '',
    'text' in s ? `"${s.text}"` : '',
  ]
    .filter(Boolean)
    .join(' ')
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <div class="crumbs">
          <NuxtLink :to="`/runs/${id}`" class="row" style="gap: 6px; color: var(--ink-2)"
            ><UiIcon name="arrow-left" :size="12" />Run
            <span class="mono" style="color: var(--ink)">{{ shortId(id) }}</span></NuxtLink
          >
          <span class="sep">·</span>
          <NuxtLink :to="`/runs/${id}/plan`" class="inline">Plan</NuxtLink>
        </div>
        <div class="row" style="gap: 14px; align-items: baseline">
          <h1 class="title">App spec</h1>
          <span v-if="spec" style="font-size: 16px; color: var(--ink-2)">{{ spec.name }}</span>
        </div>
      </div>
      <div class="grow" />
      <div v-if="spec" class="readouts">
        <div class="readout">
          <span class="k">Source</span
          ><span class="v">{{
            [spec.source.platform, spec.source.framework, spec.source.language]
              .filter(Boolean)
              .join(' · ')
          }}</span>
        </div>
        <div class="readout">
          <span class="k">Entry</span><span class="v mono">{{ spec.source.entry }}</span>
        </div>
        <div class="readout">
          <span class="k">Navigation</span
          ><span class="v"
            >{{ spec.navigation.style }} from <code>{{ spec.navigation.root }}</code></span
          >
        </div>
      </div>
    </div>

    <div v-if="error" class="callout bad" style="margin-bottom: 16px">
      <span class="lamp" />
      <div class="body">{{ error }}</div>
    </div>
    <p v-else-if="!spec" class="muted">
      No app spec yet. It appears once the "Extract app spec" stage finishes.
    </p>

    <template v-else>
      <section class="grid-hair two" style="margin-bottom: 16px">
        <div
          v-for="s in spec.screens"
          :key="s.id"
          class="pane"
          style="padding: 16px 20px; gap: 12px"
        >
          <div class="row" style="gap: 10px; align-items: baseline">
            <span style="font-size: 16px; font-weight: 700">{{ s.name }}</span>
            <code class="muted">{{ s.id }}</code>
            <code v-if="s.route" class="muted">{{ s.route }}</code>
          </div>
          <p class="dim" style="font-size: 13px">{{ s.purpose }}</p>
          <img
            v-if="screenShot(s.id)"
            :src="contentUrl(screenShot(s.id)!)"
            :alt="`Source screenshot of ${s.name}`"
            class="shot"
          />
          <div v-else class="placeholder" style="min-height: 120px">
            <UiIcon name="image" :size="26" />
            <span>No source screenshot yet</span>
            <span class="mono">captured by the observe stage</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Element</th>
                <th>Kind</th>
                <th>Label</th>
                <th>Action · binds</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in s.elements" :key="e.id">
                <td>
                  <code>{{ e.id }}</code>
                </td>
                <td>
                  <span class="tag">{{ e.kind }}</span>
                </td>
                <td>{{ e.label }}</td>
                <td>
                  <code class="dim">{{ e.action ?? e.bindsTo ?? '' }}</code>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="s.navigatesTo.length" class="hint">
            Navigates to <code>{{ s.navigatesTo.join(', ') }}</code>
          </p>
        </div>
      </section>

      <section class="grid-hair two" style="margin-bottom: 16px">
        <div class="pane" style="padding: 16px 20px">
          <PanelTitle title="State and persistence" :meta="spec.state.storeStyle" />
          <table>
            <tbody>
              <tr v-for="(shape, name) in spec.state.entities" :key="name">
                <td style="width: 140px">
                  <code>{{ name }}</code>
                </td>
                <td class="dim">{{ shape }}</td>
              </tr>
            </tbody>
          </table>
          <div
            v-for="p in spec.state.persistence"
            :key="p.mechanism"
            class="stack"
            style="gap: 4px; padding-top: 4px"
          >
            <span style="font-size: 13px; font-weight: 700">{{ p.mechanism }}</span>
            <div v-for="k in p.keys" :key="k.key" class="row small" style="gap: 10px">
              <code>{{ k.key }}</code>
              <span class="dim">{{ k.shape }}</span>
              <StatusLamp
                v-if="k.wireFormatPins.length"
                status="warn"
                :label="`pinned: ${k.wireFormatPins.join('; ')}`"
              />
            </div>
          </div>
        </div>
        <div class="pane" style="padding: 16px 20px">
          <PanelTitle title="Logic" :meta="String(spec.logic.length)" />
          <table>
            <tbody>
              <tr v-for="l in spec.logic" :key="l.id">
                <td>
                  <code>{{ l.symbol }}</code>
                  <div class="mono small muted">{{ l.file }}</div>
                </td>
                <td>
                  <span class="row" style="gap: 4px"
                    ><span class="tag" :class="{ good: l.purity === 'pure' }">{{ l.purity }}</span
                    ><span v-if="l.coreCandidate" class="tag good">core</span></span
                  >
                </td>
                <td class="dim">{{ l.loc }} loc · {{ l.description }}</td>
              </tr>
            </tbody>
          </table>
          <div class="two" style="gap: 20px; margin-top: 4px">
            <div class="stack" style="gap: 6px">
              <PanelTitle title="Integrations" />
              <p v-if="!spec.integrations.length" class="hint">None.</p>
              <div
                v-for="i in spec.integrations"
                :key="i.kind + (i.vendor ?? '')"
                class="row small"
                style="gap: 8px"
              >
                {{ i.kind }} <span v-if="i.vendor" class="muted">({{ i.vendor }})</span>
                <span class="tag" :class="{ warn: i.required }">{{
                  i.required ? 'required' : 'optional'
                }}</span>
              </div>
            </div>
            <div class="stack" style="gap: 6px">
              <PanelTitle title="Unknowns" />
              <p v-if="!spec.unknowns.length" class="hint">None.</p>
              <ul v-else class="list small dim">
                <li v-for="u in spec.unknowns" :key="u">{{ u }}</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section class="boxed">
        <div class="pane" style="padding: 14px 20px 8px">
          <PanelTitle
            title="Behaviors"
            :meta="
              behaviors
                ? `${behaviors.behaviors.length} · ${verifiedCount} verified on source`
                : undefined
            "
            >This list is the test contract every port must pass.</PanelTitle
          >
        </div>
        <p v-if="!behaviors" class="hint" style="padding: 0 20px 16px">No behavior spec yet.</p>
        <template v-else>
          <div style="padding: 0 20px">
            <table>
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Behavior</th>
                  <th>Screen</th>
                  <th>Priority</th>
                  <th>Verified on source</th>
                  <th>Steps</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in behaviors.behaviors" :key="b.id">
                  <td>
                    <code>{{ b.id }}</code>
                  </td>
                  <td>
                    {{ b.title }}
                    <div class="mono small muted">{{ b.evidence.join(', ') }}</div>
                  </td>
                  <td>
                    <code class="dim">{{ b.screen }}</code>
                  </td>
                  <td>
                    <span class="tag" :class="{ warn: b.priority === 'must' }">{{
                      b.priority
                    }}</span>
                  </td>
                  <td>
                    <span class="row" style="gap: 8px">
                      <StatusLamp
                        :status="b.verifiedOnSource ? 'ok' : 'pending'"
                        :label="b.verifiedOnSource ? 'verified' : 'unverified'"
                        :hollow="!b.verifiedOnSource"
                      />
                      <a
                        v-if="behaviorShot(b.id)"
                        :href="contentUrl(behaviorShot(b.id)!)"
                        target="_blank"
                        rel="noopener"
                        class="inline small"
                        >screenshot</a
                      >
                    </span>
                  </td>
                  <td class="mono small dim">
                    <div v-for="(s, i) in b.steps" :key="i">{{ stepText(s) }}</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div
            v-if="behaviors.invariants.length"
            class="row small dim"
            style="padding: 10px 20px 14px; gap: 24px"
          >
            <span class="lbl muted" style="font-size: 12px">Invariants</span>
            <span v-for="i in behaviors.invariants" :key="i">{{ i }}</span>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>
