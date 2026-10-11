<script setup lang="ts">
withDefaults(defineProps<{ title: string; description?: string; art?: string }>(), {
  art: 'projects',
  description: '',
})
</script>
<template>
  <section class="board-hero" :data-art="art">
    <div class="board-art" aria-hidden="true">
      <img :src="`/board/${art}.webp`" alt="" width="1200" height="800" />
    </div>
    <div class="board-hero-copy">
      <h1>{{ title }}</h1>
      <p v-if="description" class="board-description">{{ description }}</p>
      <slot />
    </div>
  </section>
</template>
