<script setup lang="ts">
import type { ReviewMark } from '@mpf/core/schemas'
const props = defineProps<{ marks: ReviewMark[]; width: number; height: number }>()
const marker = `arrow-${useId().replace(/:/g, '')}`
const points = (mark: ReviewMark) =>
  mark.points.map((p) => `${p.x * props.width},${p.y * props.height}`).join(' ')
</script>
<template>
  <svg class="review-marks" :viewBox="`0 0 ${width} ${height}`" aria-hidden="true">
    <defs>
      <marker :id="marker" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
        <path d="M0 0 L9 4.5 L0 9 Z" fill="#ecadff" />
      </marker>
    </defs>
    <g v-for="(mark, i) in marks" :key="i" stroke="#ecadff" stroke-width="3" fill="none">
      <circle
        v-if="mark.kind === 'pin'"
        :cx="mark.points[0]!.x * width"
        :cy="mark.points[0]!.y * height"
        :r="width * 0.014"
        fill="#44304e"
        vector-effect="non-scaling-stroke"
      />
      <rect
        v-else-if="mark.kind === 'rectangle'"
        :x="Math.min(mark.points[0]!.x, mark.points.at(-1)!.x) * width"
        :y="Math.min(mark.points[0]!.y, mark.points.at(-1)!.y) * height"
        :width="Math.abs(mark.points[0]!.x - mark.points.at(-1)!.x) * width"
        :height="Math.abs(mark.points[0]!.y - mark.points.at(-1)!.y) * height"
        vector-effect="non-scaling-stroke"
      />
      <polyline
        v-else
        :points="points(mark)"
        :marker-end="mark.kind === 'arrow' ? `url(#${marker})` : undefined"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    </g>
  </svg>
</template>
