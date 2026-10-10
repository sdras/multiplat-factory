<script setup lang="ts">
/** A lamp beside a word. Status is never carried by color alone. */
const props = defineProps<{ status: string; label?: string; strong?: boolean; hollow?: boolean }>()
const text = computed(() => props.label ?? statusLabel(props.status))
</script>

<template>
  <span class="status" :class="`st-${status}`">
    <span class="lamp" :class="{ live: isLive(status), hollow }" />
    <span :class="{ lbl: strong }">{{ text }}</span>
  </span>
</template>
