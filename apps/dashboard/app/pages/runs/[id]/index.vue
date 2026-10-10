<script setup lang="ts">
import { STAGE_CATALOG } from '@mpf/core/stages'
import type { Stage } from '@mpf/core/schemas'

const route = useRoute()
const id = String(route.params.id)
const api = useApi()
const { view, connected, error } = useRunView(id)
const { now } = useClock(1000)
const selected = ref<string>()
const instruction = ref('')
const note = ref('')
const actionError = ref<string>()

const run = computed(() => view.value.run)
const finished = computed(() => !!run.value && TERMINAL_RUN.has(run.value.status))
const elapsed = computed(() => (run.value ? clock(runElapsed(run.value, now.value)) : '0:00'))

/** The stage under inspection: what you clicked, else what needs you, else what is running, else the latest one. */
const current = computed<Stage | undefined>(
  () =>
    view.value.stages.find((s) => s.id === selected.value) ??
    view.value.stages.find((s) => s.status === 'waiting_human') ??
    view.value.stages.find((s) => s.status === 'running') ??
    [...view.value.stages].reverse().find((s) => s.startedAt),
)
const info = computed(() => (current.value ? STAGE_CATALOG[current.value.kind] : undefined))
const transcript = computed(() =>
  current.value ? (view.value.transcripts[current.value.id] ?? []) : [],
)
const runLog = computed(() => view.value.transcripts['_run'] ?? [])

const breakdown = computed(() => {
  const sums = new Map<string, number>()
  for (const s of view.value.stages) {
    const key = laneOf(s)
    const label =
      key === 'analyze' ? 'analysis' : key === 'finish' ? 'report' : (LANE_TITLES[key] ?? key)
    sums.set(label, (sums.get(label) ?? 0) + s.costUsd)
  }
  return [...sums].filter(([, v]) => v > 0).map(([label, value]) => ({ label, value }))
})
const pendingTitle = computed(() => {
  const s = view.value.pending?.stageId
    ? view.value.stages.find((x) => x.id === view.value.pending?.stageId)
    : undefined
  return s ? `${STAGE_CATALOG[s.kind].title}${s.target ? ` · ${s.target}` : ''}` : 'this run'
})

const canPause = computed(() => run.value?.status === 'running')
const canResume = computed(() => run.value?.status === 'paused')
const canCancel = computed(() =>
  ['running', 'paused', 'waiting_human', 'queued'].includes(run.value?.status ?? ''),
)
const rerunnable = computed(
  () =>
    !!current.value && ['succeeded', 'blocked', 'skipped', 'failed'].includes(current.value.status),
)
const steerable = computed(
  () => !!current.value && ['running', 'queued', 'pending'].includes(current.value.status),
)

async function act(path: string, body?: unknown) {
  actionError.value = undefined
  try {
    await api.post(`/runs/${id}${path}`, body)
  } catch (e) {
    actionError.value = (e as Error).message
  }
}
async function answer(choice: string) {
  if (!view.value.pending?.stageId) return
  await act(`/stages/${view.value.pending.stageId}/answer`, {
    choice,
    note: note.value || undefined,
  })
  note.value = ''
}
async function sendInstruction() {
  if (!current.value || !instruction.value.trim()) return
  await act(`/stages/${current.value.id}/instruct`, { text: instruction.value.trim() })
  instruction.value = ''
}
const artifactUrl = (aid: string) => `${api.base}/runs/${id}/artifacts/${aid}/content`
/** The report may run more than once (fix loops rerun it); show the latest PORT.md per target. */
const readmes = computed(() => [
  ...new Map(
    view.value.artifacts
      .filter((a) => a.kind === 'port-readme')
      .map((a) => [String(a.meta.target ?? ''), a]),
  ).values(),
])
</script>

<template>
  <div>
    <div v-if="error" class="callout bad" style="margin-bottom: 16px">
      <span class="lamp" />
      <div>
        <div class="head">Cannot load this run</div>
        <div class="body">{{ error }}</div>
      </div>
    </div>

    <template v-if="run">
      <section class="run-head">
        <div class="row" style="gap: 12px; align-items: baseline">
          <span class="lbl muted" style="font-size: 13px">Run</span>
          <span class="mono" style="font-size: 24px; font-weight: 700; letter-spacing: 0.02em">{{
            shortId(run.id)
          }}</span>
        </div>
        <StatusAnnunciator :status="run.status" />
        <span v-if="run.options.fake" class="tag dashed">fake</span>
        <div class="source">
          <span class="row" style="gap: 8px">
            <span class="mono">{{ run.source.locator }}</span>
            <span v-if="run.source.commit" class="mono muted small"
              >@ {{ run.source.commit.slice(0, 7) }}</span
            >
          </span>
          <span class="row small dim" style="gap: 8px">
            <span>{{
              [run.source.platform, run.source.framework].filter(Boolean).join(' · ') || 'source'
            }}</span>
            <UiIcon name="arrow-right" :size="14" />
            <span style="color: var(--ink)">{{ run.targets.join(', ') }}</span>
            <span class="muted">· shared core: {{ run.options.coreMode }}</span>
          </span>
        </div>
        <div class="grow" />
        <div class="row" style="gap: 20px">
          <NuxtLink :to="`/runs/${id}/spec`" class="inline small">Spec &amp; behaviors</NuxtLink>
          <NuxtLink :to="`/runs/${id}/plan`" class="inline small">Plan</NuxtLink>
          <NuxtLink :to="`/runs/${id}/tests`" class="inline small">Tests &amp; screens</NuxtLink>
          <NuxtLink :to="`/runs/${id}/critic`" class="inline small">Critic</NuxtLink>
          <NuxtLink :to="`/runs/${id}/core`" class="inline small">Core</NuxtLink>
        </div>
        <div class="row" style="gap: 8px; align-items: baseline">
          <span class="lbl muted" style="font-size: 12px">{{ finished ? 'Took' : 'Elapsed' }}</span>
          <span class="mono tnum" style="font-size: 22px; font-weight: 700">{{ elapsed }}</span>
        </div>
        <StatusLamp
          :status="connected ? 'ok' : 'warn'"
          :label="connected ? 'stream live' : 'reconnecting'"
        />
        <div class="row" style="gap: 8px">
          <button class="btn" type="button" :disabled="!canPause" @click="act('/pause')">
            <UiIcon name="pause" />Pause
          </button>
          <button class="btn" type="button" :disabled="!canResume" @click="act('/resume')">
            <UiIcon name="play" />Resume
          </button>
          <button class="btn" type="button" :disabled="!canCancel" @click="act('/cancel')">
            <UiIcon name="x" />Cancel
          </button>
        </div>
      </section>

      <section v-if="view.pending" class="callout" style="margin-bottom: 16px">
        <span class="lamp live" />
        <div class="stack" style="gap: 1px; line-height: 1.35">
          <span class="head">Decision needed · {{ pendingTitle }}</span>
          <span class="body">{{ view.pending.reason }}</span>
        </div>
        <div class="grow" />
        <label for="note" class="sr-only">Optional note for the worker</label>
        <input
          id="note"
          v-model="note"
          type="text"
          placeholder="Optional note for the worker"
          style="width: 300px"
        />
        <button
          v-for="(c, i) in view.pending.choices"
          :key="c.id"
          type="button"
          class="btn"
          :class="{ primary: i === 0 }"
          @click="answer(c.id)"
        >
          {{ c.label }}
        </button>
      </section>

      <section v-if="run.summary" class="callout" style="margin-bottom: 16px">
        <span class="lamp" />
        <div class="stack" style="gap: 1px; line-height: 1.35">
          <span class="head">Result</span>
          <span class="body">{{ run.summary }}</span>
        </div>
        <div class="grow" />
        <a
          v-for="a in readmes"
          :key="a.id"
          :href="artifactUrl(a.id)"
          target="_blank"
          rel="noopener"
          class="btn"
          >PORT.md · {{ a.meta.target }}</a
        >
      </section>

      <div v-if="actionError" class="callout bad" style="margin-bottom: 16px">
        <span class="lamp" />
        <div class="body">{{ actionError }}</div>
        <button
          class="btn tiny"
          type="button"
          style="margin-left: auto"
          @click="actionError = undefined"
        >
          Dismiss
        </button>
      </div>

      <section style="margin-bottom: 16px">
        <PanelTitle
          title="Timeline"
          :meta="
            finished
              ? 'click a stage to inspect it'
              : 'seconds since start · click a stage to inspect it'
          "
        />
        <RunTimeline
          :run="run"
          :stages="view.stages"
          :now="now"
          :selected="current?.id"
          @select="selected = $event"
        />
      </section>

      <section class="grid-hair three main-grid">
        <div class="left">
          <div class="pane stage-pane">
            <div class="panel-title">
              <span class="l strong">{{ info ? info.title : 'Transcript' }}</span>
              <span v-if="current?.target" class="tag">{{ current.target }}</span>
              <StatusLamp v-if="current" :status="current.status" />
              <span class="r" />
              <span v-if="current" class="meta">{{ stageWindow(current, now) }}</span>
            </div>
            <div v-if="current?.error" class="callout bad" style="padding: 8px 12px; gap: 8px">
              <span class="mono small" style="color: var(--bad)">{{ current.error.class }}</span>
              <span class="body">{{ current.error.message }}</span>
            </div>
            <p v-if="current?.skipReason" class="hint">Skipped: {{ current.skipReason }}</p>
            <TranscriptList :items="transcript" empty="Nothing yet for this stage." />
            <div v-if="steerable" class="row" style="gap: 8px; flex-wrap: nowrap">
              <label for="instruct" class="sr-only">Send an instruction to this worker</label>
              <input
                id="instruct"
                v-model="instruction"
                type="text"
                placeholder="Send an instruction to this worker"
                @keyup.enter="sendInstruction"
              />
              <button class="btn" type="button" @click="sendInstruction">
                <UiIcon name="send" />Send
              </button>
            </div>
          </div>
          <div class="pane log-pane">
            <PanelTitle title="Run log" />
            <TranscriptList :items="runLog" compact empty="No run-level messages yet." />
          </div>
        </div>

        <aside class="right">
          <div class="pane">
            <PanelTitle
              title="Now"
              :meta="
                current
                  ? `attempt ${current.attempt}/${current.maxAttempts} · ${money(current.costUsd)}`
                  : undefined
              "
            />
            <template v-if="info && current">
              <p style="font-size: 13px">{{ info.description }}</p>
              <p class="small dim">
                <span class="muted">Can go wrong · </span>{{ info.whatCanGoWrong }}
              </p>
              <p class="small dim"><span class="muted">You can · </span>{{ info.whatYouCanDo }}</p>
              <div>
                <button
                  class="btn"
                  type="button"
                  :disabled="!rerunnable"
                  @click="act(`/stages/${current.id}/rerun`)"
                >
                  <UiIcon name="refresh" />Re-run this stage
                </button>
              </div>
            </template>
            <p v-else class="hint">Select a stage on the timeline to see what it does.</p>
          </div>

          <div class="pane">
            <BudgetTape :cost="run.costUsd" :cap="run.options.budgetUsd" :breakdown="breakdown" />
          </div>

          <div class="pane">
            <PanelTitle title="Tests" />
            <table v-if="view.tests.length">
              <tbody>
                <tr v-for="t in view.tests" :key="t.stageId + t.kind">
                  <td class="lbl dim" style="font-size: 12px">{{ t.target }}</td>
                  <td class="muted">{{ t.kind }}</td>
                  <td><StatusLamp :status="t.status" /></td>
                  <td class="num">{{ t.summary.passed }}/{{ t.summary.total }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="hint">No results yet.</p>
          </div>

          <div class="pane">
            <PanelTitle title="Critic" />
            <div v-for="v in view.verdicts" :key="v.stageId + v.round" class="stack verdict">
              <div class="row small" style="gap: 8px">
                <span class="lbl dim" style="font-size: 12px">{{ v.target }}</span>
                <span class="muted">round {{ v.round }}</span>
                <StatusLamp :status="v.decision" />
                <span class="grow" />
                <span class="mono muted small"
                  >fidelity {{ v.scores.fidelity }}/5 · tests {{ v.scores.testAdequacy }}/5 ·
                  {{ v.findings.length }} findings</span
                >
              </div>
              <div class="small dim">{{ v.summary }}</div>
            </div>
            <p v-if="!view.verdicts.length" class="hint">No verdicts yet.</p>
          </div>

          <div class="pane">
            <PanelTitle
              title="Artifacts"
              :meta="view.artifacts.length ? `${view.artifacts.length} files` : undefined"
            />
            <ul v-if="view.artifacts.length" class="artifacts">
              <li v-for="a in view.artifacts" :key="a.id">
                <a :href="artifactUrl(a.id)" target="_blank" rel="noopener" class="mono">{{
                  a.relPath
                }}</a>
                <span class="muted small">{{ a.kind }}</span>
              </li>
            </ul>
            <p v-else class="hint">None yet.</p>
          </div>
        </aside>
      </section>
    </template>
    <p v-else-if="!error" class="muted">Loading…</p>
  </div>
</template>

<style scoped>
.run-head {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--rule);
}
.run-head .source {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.35;
  min-width: 0;
}
.main-grid {
  min-height: 620px;
}
.left {
  display: flex;
  flex-direction: column;
}
.stage-pane {
  flex-grow: 1;
  min-height: 0;
}
.stage-pane .transcript {
  max-height: 460px;
  min-height: 240px;
}
.log-pane {
  border-top: 1px solid var(--rule);
}
.log-pane .transcript {
  max-height: 150px;
}
.right {
  display: flex;
  flex-direction: column;
}
.right .pane + .pane {
  border-top: 1px solid var(--rule);
}
.verdict {
  padding: 4px 0;
  border-bottom: 1px solid var(--rule-faint);
  gap: 2px;
}
.artifacts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.artifacts li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  min-height: 22px;
}
@media (max-width: 900px) {
  .main-grid {
    min-height: 0;
  }
  .run-head {
    gap: 12px;
  }
}
</style>
