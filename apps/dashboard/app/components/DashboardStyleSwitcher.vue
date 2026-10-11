<script setup lang="ts">
const { style, setStyle } = useDashboardStyle()
</script>
<template>
  <label class="dashboard-style-switcher">
    <span>Style</span>
    <select
      :value="style"
      aria-label="Dashboard style"
      @change="setStyle(($event.target as HTMLSelectElement).value)"
    >
      <option value="flight">Flight deck</option>
      <option value="board">Release board</option>
    </select>
  </label>
</template>
<style scoped>
.dashboard-style-switcher {
  display: flex;
  align-items: center;
  gap: 8px;
  font: 12px/1.4 var(--font-ui);
  white-space: nowrap;
}
select {
  width: auto;
  min-width: 132px;
  padding: 6px 9px;
  border: 1px solid var(--rule);
  border-radius: 7px;
  background: var(--panel);
  color: var(--ink);
  font: inherit;
}
</style>
