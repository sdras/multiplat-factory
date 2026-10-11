<script setup lang="ts">
import type { Artifact, PortPlan, Run, Stage } from '@mpf/core/schemas'

const review = useProjectReview()
const route = useRoute()
const id = String(route.params.id)
const api = useApi()
const run = ref<Run>()
const planStage = ref<Stage>()
const plan = ref<PortPlan>()
const error = ref<string>()
const actionError = ref<string>()
const note = ref('')

async function load() {
  try {
    const snap = await api.get<{ run: Run; stages: Stage[]; artifacts: Artifact[] }>(`/runs/${id}`)
    run.value = snap.run
    planStage.value = snap.stages.find((s) => s.id === 'plan')
    const a = [...snap.artifacts].reverse().find((x) => x.kind === 'portplan')
    if (a)
      plan.value = await (await fetch(`${api.base}/runs/${id}/artifacts/${a.id}/content`)).json()
  } catch (e) {
    error.value = (e as Error).message
  }
}
onMounted(load)

const waiting = computed(() => planStage.value?.status === 'waiting_human')
async function answer(choice: string) {
  actionError.value = undefined
  try {
    await api.post(`/runs/${id}/stages/plan/answer`, { choice, note: note.value || undefined })
    note.value = ''
    setTimeout(load, 500)
  } catch (e) {
    actionError.value = (e as Error).message
  }
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
          <NuxtLink :to="`/runs/${id}/spec`" class="inline">Spec &amp; behaviors</NuxtLink>
        </div>
        <div class="row" style="gap: 14px">
          <h1 class="title">Port plan</h1>
          <StatusAnnunciator v-if="planStage" :status="planStage.status" />
        </div>
      </div>
      <div class="grow" />
      <div v-if="plan" class="readouts">
        <div class="readout">
          <span class="k">Estimate</span
          ><span class="v"
            ><span class="mono">{{ plan.estimate.stages }}</span> stages · about
            <span class="mono">{{ money(plan.estimate.costUsd, 0) }}</span> ·
            <span class="mono">{{ plan.estimate.minutes }}</span> min</span
          >
        </div>
        <div v-if="run" class="readout">
          <span class="k">Spent so far</span
          ><span class="v"
            ><span class="mono">{{ money(run.costUsd) }}</span> of
            <span class="mono">{{ money(run.options.budgetUsd, 0) }}</span></span
          >
        </div>
      </div>
    </div>

    <div v-if="error" class="callout bad" style="margin-bottom: 16px">
      <span class="lamp" />
      <div class="body">{{ error }}</div>
    </div>
    <p v-else-if="!plan" class="muted">
      No plan yet. It appears once the "Port plan" stage finishes.
    </p>

    <template v-else>
      <button class="btn review-page-action" @click="review.discuss('plan')">
        Discuss this plan
      </button>
      <button class="btn review-page-action" @click="review.showDesign()">
        Explore 3 design directions
      </button>
      <section v-if="waiting" class="callout" style="margin-bottom: 16px">
        <div class="stack" style="gap: 1px; line-height: 1.35">
          <span class="head">Go or no go</span>
          <span class="body"
            >Approve this plan to start generation on every target, or reject to cancel the run.
            Your note goes to every generation worker.</span
          >
        </div>
        <div class="grow" />
        <label for="note" class="sr-only">Optional instruction for the generation workers</label>
        <input
          id="note"
          v-model="note"
          type="text"
          placeholder="Optional instruction for the generation workers"
          style="width: 360px"
        />
        <button class="btn primary" type="button" @click="answer('approve')">
          <UiIcon name="check" />Approve plan
        </button>
        <button class="btn" type="button" @click="answer('reject')">Reject and cancel</button>
      </section>
      <div v-if="actionError" class="callout bad" style="margin-bottom: 16px">
        <span class="lamp" />
        <div class="body">{{ actionError }}</div>
      </div>

      <section class="grid-hair two" style="margin-bottom: 16px">
        <div
          v-for="t in plan.targets"
          :key="t.target"
          class="pane"
          style="padding: 16px 20px; gap: 12px"
        >
          <div class="panel-title">
            <span class="l strong" style="font-size: 18px">{{ t.target }}</span>
            <span class="tag">{{ t.uiFramework }}</span>
            <span class="r" />
          </div>
          <p class="small dim" style="font-size: 13px">{{ t.layout }}</p>
          <p style="font-size: 13px"><span class="muted">State · </span>{{ t.stateStrategy }}</p>
          <table>
            <thead>
              <tr>
                <th>Screen</th>
                <th>File</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in t.screenMap" :key="m.screen">
                <td>
                  <code>{{ m.screen }}</code>
                </td>
                <td>
                  <code class="dim">{{ m.file }}</code>
                </td>
                <td class="dim">{{ m.notes }}</td>
              </tr>
            </tbody>
          </table>
          <div class="two" style="gap: 20px">
            <div class="stack" style="gap: 6px">
              <PanelTitle title="Persistence" />
              <p v-if="!t.persistenceMap.length" class="hint">Nothing persisted.</p>
              <div
                v-for="p in t.persistenceMap"
                :key="p.sourceKey"
                class="stack"
                style="gap: 3px; font-size: 12.5px"
              >
                <span
                  ><code>{{ p.sourceKey }}</code> <span class="muted">→</span>
                  {{ p.mechanism }}</span
                >
                <StatusLamp
                  :status="p.sameWireFormat ? 'ok' : 'warn'"
                  :label="p.sameWireFormat ? 'same wire format' : 'format changes'"
                />
              </div>
            </div>
            <div class="stack" style="gap: 6px">
              <PanelTitle title="Integrations" />
              <p v-if="!t.integrationMap.length" class="hint">None.</p>
              <div
                v-for="i in t.integrationMap"
                :key="i.kind"
                class="stack"
                style="gap: 2px; font-size: 12.5px"
              >
                <span class="row" style="gap: 8px"
                  >{{ i.kind }}
                  <StatusLamp :status="i.decision === 'port' ? 'ok' : 'warn'" :label="i.decision"
                /></span>
                <span class="small dim">{{ i.rationale }}</span>
              </div>
            </div>
          </div>
          <div v-if="t.deviations.length" class="stack" style="gap: 6px">
            <PanelTitle title="Deviations" />
            <div
              v-for="d in t.deviations"
              :key="d.what"
              class="stack"
              style="gap: 1px; font-size: 12.5px; line-height: 1.4"
            >
              <span class="row" style="gap: 8px"
                ><b>{{ d.what }}</b
                ><span v-if="d.accepted" class="tag good">accepted</span></span
              >
              <span class="dim">{{ d.why }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="grid-hair two">
        <div class="pane" style="padding: 16px 20px">
          <PanelTitle
            title="Shared core"
            :meta="plan.core.enabled ? `${plan.core.functions.length} functions` : undefined"
          >
            <template #after
              ><StatusLamp
                :status="plan.core.enabled ? 'ok' : 'skipped'"
                :label="plan.core.enabled ? 'enabled' : 'off'"
            /></template>
          </PanelTitle>
          <p class="small dim" style="font-size: 13px">{{ plan.core.rationale }}</p>
          <table v-if="plan.core.functions.length">
            <tbody>
              <tr v-for="f in plan.core.functions" :key="f.name">
                <td style="width: 160px">
                  <code>{{ f.name }}</code>
                </td>
                <td class="dim">{{ f.description }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pane" style="padding: 16px 20px">
          <PanelTitle title="Test plan" />
          <div class="kv" style="grid-template-columns: 90px 1fr">
            <span class="k">Unit</span><span>{{ plan.testPlan.unit.join(', ') || 'none' }}</span>
            <span class="k">End to end</span
            ><span>{{ plan.testPlan.e2e.join(', ') || 'none' }}</span> <span class="k">Parity</span
            ><span>{{ plan.testPlan.parity.join(', ') || 'none' }}</span>
          </div>
          <template v-if="plan.questionsForHuman.length">
            <PanelTitle title="Questions for you" style="margin-top: 6px" />
            <ul class="list small dim" style="display: flex; flex-direction: column; gap: 4px">
              <li v-for="q in plan.questionsForHuman" :key="q">{{ q }}</li>
            </ul>
          </template>
        </div>
      </section>
    </template>
  </div>
</template>
