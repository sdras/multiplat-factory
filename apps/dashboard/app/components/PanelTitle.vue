<script setup lang="ts">
/** Label, hairline, readout. The one heading device used on every panel. */
defineProps<{ title: string; strong?: boolean; meta?: string }>()
</script>

<template>
  <div class="panel-title">
    <span class="l" :class="{ strong }">{{ title }}</span>
    <slot name="after" />
    <span class="r" />
    <slot />
    <span v-if="meta" class="meta">{{ meta }}</span>
  </div>
</template>
