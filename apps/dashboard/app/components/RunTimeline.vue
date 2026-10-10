<script setup lang="ts">
import { STAGE_CATALOG } from '@mpf/core/stages'
import type { Run, Stage } from '@mpf/core/schemas'

/**
 * The run as lanes on a time axis: Analyze, Core, one lane per target, Finish.
 * Bars come from stage timestamps; stages that have not started sit as dashed ghosts after "now".
 */
const props = defineProps<{ run: Run; stages: Stage[]; now: number; selected?: string }>()
const emit = defineEmits<{ select: [id: string] }>()

const t0 = computed(() => new Date(props.run.createdAt).getTime())
const finished = computed(() => TERMINAL_RUN.has(props.run.status))
const end = computed(() => {
  const stageEnds = props.stages.map((s) => (s.endedAt ? new Date(s.endedAt).getTime() : 0))
  const last = Math.max(new Date(props.run.updatedAt).getTime(), ...stageEnds)
  return finished.value ? last : Math.max(props.now, last)
})
const pendingCount = computed(() => props.stages.filter((s) => !s.startedAt).length)
/** Axis length in ms: at least 30 s, with headroom for ghost bars of stages still to come. */
const total = computed(() => {
  const span = Math.max(end.value - t0.value, 30_000)
  return span * (1 + Math.min(0.5, 0.08 * pendingCount.value) + 0.04)
})

const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000)
const step = computed(() => STEPS.find((s) => total.value / s <= 12) ?? STEPS[STEPS.length - 1]!)
const ticks = computed(() => {
  const out: { left: number; label: string }[] = []
  for (let t = 0; t <= total.value; t += step.value)
    out.push({ left: (t / total.value) * 100, label: clock(t) })
  return out
})

const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - t0.value) / total.value) * 100))
const nowPct = computed(() => pct(props.now))

interface Bar {
  id: string
  status: string
  title: string
  left: number
  width: number
  ghost: boolean
  aria: string
}
interface Lane {
  key: string
  title: string
  note: string
  bars: Bar[]
}

const lanes = computed<Lane[]>(() => {
  const order = ['analyze', 'core', ...props.run.targets, 'finish']
  const groups = new Map<string, Stage[]>()
  for (const s of props.stages) {
    const key = laneOf(s)
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  const anchor = finished.value ? end.value : props.now
  return order
    .filter((key) => groups.has(key))
    .map((key) => {
      const stages = groups.get(key)!
      let ghostSlot = 0
      const bars = stages.map<Bar>((s) => {
        const title = STAGE_CATALOG[s.kind].title
        const aria = `${title}${s.target ? ` for ${s.target}` : ''}, ${statusLabel(s.status)}`
        if (!s.startedAt) {
          const left = Math.min(94, pct(anchor) + 1 + ghostSlot * 6.5)
          ghostSlot += 1
          return { id: s.id, status: s.status, title, left, width: 6, ghost: true, aria }
        }
        const start = new Date(s.startedAt).getTime()
        const stop = s.endedAt ? new Date(s.endedAt).getTime() : anchor
        const left = pct(start)
        const width = Math.max(0.6, pct(stop) - left)
        return { id: s.id, status: s.status, title, left, width, ghost: false, aria }
      })
      const grouped = groupStatus(stages)
      const note = `${stages.filter((s) => s.status === 'succeeded').length}/${stages.length} · ${statusLabel(grouped)}`
      return { key, title: LANE_TITLES[key] ?? key, note, bars }
    })
})
</script>

<template>
  <div class="timeline" role="group" aria-label="Stage timeline">
    <div v-for="lane in lanes" :key="lane.key" class="lane">
      <div class="lane-label">
        <span class="lbl">{{ lane.title }}</span>
        <span class="note">{{ lane.note }}</span>
      </div>
      <div class="track">
        <button
          v-for="b in lane.bars"
          :key="b.id"
          type="button"
          class="bar"
          :class="[`st-${b.status}`, { selected: b.id === selected }]"
          :style="{ left: `${b.left}%`, width: `${b.width}%` }"
          :title="b.aria"
          :aria-label="b.aria"
          :aria-pressed="b.id === selected"
          @click="emit('select', b.id)"
        >
          <span class="lamp" :class="{ live: isLive(b.status) }" />
          <span class="name">{{ b.title }}</span>
        </button>
      </div>
    </div>
    <div class="axis">
      <div />
      <div class="track">
        <span v-for="t in ticks" :key="t.label" class="tick" :style="{ left: `${t.left}%` }"
          ><i /><span>{{ t.label }}</span></span
        >
      </div>
    </div>
    <template v-if="!finished">
      <div class="cursor" :style="{ left: `calc(112px + (100% - 112px) * ${nowPct / 100})` }" />
      <div class="cursor-label" :style="{ left: `calc(112px + (100% - 112px) * ${nowPct / 100})` }">
        NOW {{ clock(now - t0) }}
      </div>
    </template>
  </div>
</template>

<style scoped>
@media (max-width: 900px) {
  .cursor,
  .cursor-label {
    display: none;
  }
}
</style>
