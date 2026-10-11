<script lang="ts">
export type IconName =
  | 'pause'
  | 'play'
  | 'x'
  | 'refresh'
  | 'send'
  | 'check'
  | 'warn'
  | 'arrow-right'
  | 'arrow-left'
  | 'plus'
  | 'copy'
  | 'image'
  | 'flag'
  | 'device'

type Def = { d: string[]; box: [number, number]; fill?: boolean }
const DEFS: Record<IconName, Def> = {
  pause: { d: ['M2 1.5h3v9H2zM7 1.5h3v9H7z'], box: [12, 12], fill: true },
  play: { d: ['M2.5 1.5l8 4.5-8 4.5z'], box: [12, 12], fill: true },
  x: { d: ['M2 2l8 8M10 2l-8 8'], box: [12, 12] },
  refresh: { d: ['M10 6a4 4 0 1 1-1.2-2.9', 'M10 1.5v2.5H7.5'], box: [12, 12] },
  send: { d: ['M1.5 6h9M7 2.5L10.5 6 7 9.5'], box: [12, 12] },
  check: { d: ['M1.5 6.5l3 3L10.5 3'], box: [12, 12] },
  warn: { d: ['M7 1.5l6 11H1z', 'M7 5.5v3M7 10.5v.5'], box: [14, 14] },
  'arrow-right': { d: ['M1 5h11M8 1l4 4-4 4'], box: [14, 10] },
  'arrow-left': { d: ['M13 5H2M6 1L2 5l4 4'], box: [14, 10] },
  plus: { d: ['M6 1.5v9M1.5 6h9'], box: [12, 12] },
  copy: {
    d: ['M4 4h7v7H4z', 'M8 4V2a1 1 0 0 0-1-1H2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h2'],
    box: [12, 12],
  },
  image: {
    d: [
      'M3 4h18v16H3z',
      'M3 15l5-5 4 4 3-3 6 6',
      'M16 9m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
    ],
    box: [24, 24],
  },
  flag: { d: ['M2.5 11V1.5h7l-1.5 2.5 1.5 2.5h-7'], box: [12, 12] },
  // A phone outline: the emulator or simulator a notice came from.
  device: {
    d: ['M3.5 1h5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z', 'M5 9h2'],
    box: [12, 12],
  },
}
</script>

<script setup lang="ts">
/** Inline stroke icons, one weight, never emoji. */
const props = defineProps<{ name: IconName; size?: number }>()
const def = computed(() => DEFS[props.name])
const w = computed(() => props.size ?? def.value.box[0])
const h = computed(() => Math.round((w.value * def.value.box[1]) / def.value.box[0]))
</script>

<template>
  <svg
    :width="w"
    :height="h"
    :viewBox="`0 0 ${def.box[0]} ${def.box[1]}`"
    :fill="def.fill ? 'currentColor' : 'none'"
    :stroke="def.fill ? 'none' : 'currentColor'"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in def.d" :key="i" :d="d" />
  </svg>
</template>
