<script setup lang="ts">
/** The cost tape: fill carries severity, the cap is a red limit mark. */
const props = defineProps<{
  cost: number
  cap: number
  breakdown?: { label: string; value: number }[]
}>()
const pct = computed(() => (props.cap > 0 ? Math.min(100, (props.cost / props.cap) * 100) : 0))
const severity = computed(() => (pct.value >= 90 ? 'bad' : pct.value >= 70 ? 'warn' : ''))
const ticks = computed(() => [0, 0.25, 0.5, 0.75].map((f) => Math.round(props.cap * f)))
</script>

<template>
  <div class="stack">
    <PanelTitle title="Budget" :meta="`${pct.toFixed(0)}% of cap`" />
    <div class="row" style="gap: 10px; align-items: baseline">
      <span class="hero">{{ money(cost) }}</span>
      <span class="muted small">of {{ money(cap) }}</span>
    </div>
    <div
      class="tape"
      :class="severity"
      role="meter"
      :aria-valuenow="cost"
      aria-valuemin="0"
      :aria-valuemax="cap"
      aria-label="Spent against the budget cap"
    >
      <div class="track" />
      <div class="fill" :style="{ width: `${pct}%` }" />
      <div class="limit" />
      <div class="ticks">
        <span v-for="t in ticks" :key="t">{{ t }}</span>
        <span class="cap">{{ cap }} cap</span>
      </div>
    </div>
    <div v-if="breakdown?.length" class="row small muted" style="gap: 14px">
      <span v-for="b in breakdown" :key="b.label"
        >{{ b.label }} <span class="mono dim">{{ b.value.toFixed(2) }}</span></span
      >
    </div>
  </div>
</template>
