<script setup lang="ts">
/** The bordered status readout in a page header: lamp or warning glyph, then the word. */
const props = defineProps<{ status: string; label?: string }>()
const text = computed(() => props.label ?? statusLabel(props.status))
const warnGlyph = computed(() => props.status === 'waiting_human' || props.status === 'partial')
</script>

<template>
  <span class="annunciator" :class="`st-${status}`">
    <UiIcon v-if="warnGlyph" name="warn" :size="14" />
    <span v-else class="lamp" :class="{ live: isLive(status) }" />
    <span class="lbl">{{ text }}</span>
  </span>
</template>
