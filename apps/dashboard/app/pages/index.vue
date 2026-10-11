<script setup lang="ts">
import type { Run, Stage } from '@mpf/core/schemas'

const { isBoard } = useDashboardStyle()
const api = useApi()
const runs = ref<Run[]>([])
const stagesOf = ref<Record<string, Stage[]>>({})
const error = ref<string>()
const loaded = ref(false)
const filter = ref<'all' | 'active' | 'needs' | 'done'>('all')
const { now } = useClock(1000)
let timer: ReturnType<typeof setInterval> | undefined

async function load() {
  try {
    const list = await api.get<Run[]>('/runs')
    runs.value = list
    error.value = undefined
    const snaps = await Promise.all(
      list.slice(0, 60).map((r) =>
        api
          .get<{ stages: Stage[] }>(`/runs/${r.id}`)
          .then((s) => [r.id, s.stages] as const)
          .catch(() => [r.id, [] as Stage[]] as const),
      ),
    )
    stagesOf.value = Object.fromEntries(snaps)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loaded.value = true
  }
}
onMounted(() => {
  void load()
  timer = setInterval(load, 8000)
})
onUnmounted(() => clearInterval(timer))

const counts = computed(() => ({
  all: runs.value.length,
  active: runs.value.filter((r) => ACTIVE_RUN.has(r.status)).length,
  needs: runs.value.filter((r) => r.status === 'waiting_human').length,
  done: runs.value.filter((r) => TERMINAL_RUN.has(r.status)).length,
}))
const filtered = computed(() =>
  runs.value.filter((r) => {
    if (filter.value === 'active') return ACTIVE_RUN.has(r.status)
    if (filter.value === 'needs') return r.status === 'waiting_human'
    if (filter.value === 'done') return TERMINAL_RUN.has(r.status)
    return true
  }),
)
const summary = computed(() => {
  const parts = [`${counts.value.all} run${counts.value.all === 1 ? '' : 's'} on this machine`]
  if (counts.value.needs) parts.push(`${counts.value.needs} waiting for you`)
  const running = runs.value.filter((r) => r.status === 'running').length
  if (running) parts.push(`${running} running`)
  return parts.join(' · ')
})

const TARGETS = ['web', 'ios', 'android'] as const
const TNAME: Record<string, string> = { web: 'Web', ios: 'iOS', android: 'And' }

function detected(run: Run): string {
  const parts = [run.source.platform, run.source.framework, run.source.language].filter(Boolean)
  return parts.length
    ? parts.join(' · ')
    : run.options.fake
      ? 'fake pipeline'
      : 'detected in the first stage'
}
function pct(run: Run): number {
  return run.options.budgetUsd ? Math.min(100, (run.costUsd / run.options.budgetUsd) * 100) : 0
}
function meterClass(run: Run): string {
  const p = pct(run)
  return p >= 90 ? 'bad' : p >= 70 ? 'warn' : ''
}
function sectors(run: Run) {
  const stages = stagesOf.value[run.id] ?? []
  return ['analyze', 'core', ...run.targets].map((key) => ({
    key,
    title: LANE_TITLES[key] ?? key,
    status: groupStatus(stages.filter((s) => laneOf(s) === key)),
  }))
}
</script>

<template>
  <BoardProjects
    v-if="isBoard"
    :runs="runs"
    :stages-of="stagesOf"
    :loaded="loaded"
    :error="error"
  />
  <div v-else>
    <div class="page-head">
      <div>
        <h1 class="title">Runs</h1>
        <p class="subtitle">{{ summary }}</p>
      </div>
      <div class="grow" />
      <div class="seg-group" role="group" aria-label="Filter runs">
        <button type="button" class="seg" :class="{ on: filter === 'all' }" @click="filter = 'all'">
          All <span class="mono muted">{{ counts.all }}</span>
        </button>
        <button
          type="button"
          class="seg"
          :class="{ on: filter === 'active' }"
          @click="filter = 'active'"
        >
          Active <span class="mono muted">{{ counts.active }}</span>
        </button>
        <button
          type="button"
          class="seg"
          :class="{ on: filter === 'needs' }"
          @click="filter = 'needs'"
        >
          Needs you
          <span class="mono" :class="counts.needs ? 'st-waiting_human' : 'muted'">{{
            counts.needs
          }}</span>
        </button>
        <button
          type="button"
          class="seg"
          :class="{ on: filter === 'done' }"
          @click="filter = 'done'"
        >
          Done <span class="mono muted">{{ counts.done }}</span>
        </button>
      </div>
      <NuxtLink to="/runs/new" class="btn primary"><UiIcon name="plus" />New run</NuxtLink>
    </div>

    <div v-if="error" class="callout bad" style="margin-bottom: 16px">
      <span class="lamp" />
      <div>
        <div class="head">Cannot reach the server</div>
        <div class="body">{{ error }}. Start it with <code>pnpm mpf serve</code>.</div>
      </div>
    </div>

    <div class="boxed">
      <div class="head-row strip-head">
        <span>Status</span><span>Run</span><span>Source</span
        ><span class="col-targets">Targets</span><span class="col-cost">Cost · cap</span
        ><span class="col-started">Started · elapsed</span><span class="col-stages">Stages</span>
      </div>
      <ol v-if="filtered.length" class="strips">
        <li v-for="r in filtered" :key="r.id">
          <NuxtLink :to="`/runs/${r.id}`" class="strip">
            <StatusLamp :status="r.status" strong />
            <span class="row" style="gap: 8px">
              <span class="id">{{ shortId(r.id) }}</span>
              <span v-if="r.options.fake" class="tag dashed">fake</span>
            </span>
            <span class="cell">
              <span class="mono ellipsis">{{ r.source.locator }}</span>
              <span class="small muted">{{ detected(r) }}</span>
            </span>
            <span class="row col-targets" style="gap: 4px">
              <span
                v-for="t in TARGETS"
                :key="t"
                class="tcell"
                :class="{ off: !r.targets.includes(t) }"
                >{{ TNAME[t] }}</span
              >
            </span>
            <span class="cell col-cost" style="gap: 5px">
              <span class="mono tnum"
                >{{ money(r.costUsd) }}
                <span class="muted">/ {{ money(r.options.budgetUsd, 0) }}</span></span
              >
              <span class="meter" :class="meterClass(r)"
                ><i :style="{ width: `${pct(r)}%` }"
              /></span>
            </span>
            <span class="cell col-started">
              <span>{{ when(r.createdAt, now) }}</span>
              <span class="mono small muted tnum"
                >{{ clock(runElapsed(r, now))
                }}{{ ACTIVE_RUN.has(r.status) ? ' running' : '' }}</span
              >
            </span>
            <span class="sectors col-stages">
              <span
                v-for="s in sectors(r)"
                :key="s.key"
                class="sector"
                :class="[`st-${s.status}`, { wide: s.key === 'analyze' }]"
                :title="`${s.title}: ${statusLabel(s.status)}`"
              />
            </span>
          </NuxtLink>
        </li>
      </ol>
      <div v-else-if="loaded && !error" class="placeholder" style="margin: 18px; min-height: 160px">
        <template v-if="runs.length">
          <span>No runs match this filter.</span>
        </template>
        <template v-else>
          <span class="dim">No runs yet.</span>
          <span
            >Create one to port an app, or start a fake run to watch the factory work without
            spending anything.</span
          >
          <NuxtLink to="/runs/new" class="btn" style="margin-top: 6px">New run</NuxtLink>
        </template>
      </div>
      <div class="legend">
        <span>Stage strip: analyze · core · one block per target</span>
        <span class="status st-succeeded"><span class="sector" />succeeded</span>
        <span class="status st-running"><span class="sector" />running</span>
        <span class="status st-waiting_human"><span class="sector" />waiting for you</span>
        <span class="status st-failed"><span class="sector" />failed</span>
        <span class="status st-pending"><span class="sector st-pending" />skipped or pending</span>
        <span class="grow" />
        <span class="mono">~/.mpf</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.strip-head {
  grid-template-columns: 150px 110px minmax(0, 1fr) 150px 130px 150px 168px;
  gap: 16px;
}
@media (max-width: 1100px) {
  .strip-head {
    grid-template-columns: 130px 100px minmax(0, 1fr) 120px 110px;
  }
}
@media (max-width: 900px) {
  .strip-head {
    grid-template-columns: 120px minmax(0, 1fr);
  }
}
</style>
