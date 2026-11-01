<script setup lang="ts">
const { theme, setTheme } = useBoardTheme()
</script>

<template>
  <div class="board-theme-toggle" role="group" aria-label="Color theme">
    <button
      type="button"
      :aria-pressed="theme === 'light'"
      aria-label="Light theme"
      title="Light theme"
      @click="setTheme('light')"
    >
      <UiIcon name="sun" :size="15" />
    </button>
    <button
      type="button"
      :aria-pressed="theme === 'dark'"
      aria-label="Dark theme"
      title="Dark theme"
      @click="setTheme('dark')"
    >
      <UiIcon name="moon" :size="15" />
    </button>
  </div>
</template>
