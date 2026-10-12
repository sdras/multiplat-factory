<script setup lang="ts">
import type { DesignOption } from '@mpf/core/schemas'
const props = defineProps<{ option: DesignOption; target: string }>()
const style = computed(() => {
  const m = props.option.mockup
  return {
    '--mock-bg': m.palette.background,
    '--mock-surface': m.palette.surface,
    '--mock-ink': m.palette.ink,
    '--mock-accent': m.palette.accent,
    '--mock-radius': m.corners === 'square' ? '2px' : m.corners === 'soft' ? '8px' : '16px',
    '--mock-font':
      m.typography === 'serif'
        ? 'Georgia, serif'
        : m.typography === 'mono'
          ? 'monospace'
          : 'Arial, sans-serif',
  }
})
</script>
<template>
  <div
    class="design-mock"
    :class="[`mock-${option.mockup.layout}`, { 'mock-mobile': target !== 'web' }]"
    :style="style"
    role="img"
    :aria-label="`${option.name}: ${option.summary}`"
  >
    <div class="mock-window" aria-hidden="true">
      <i /><i /><i /><span>{{ option.mockup.appName }}</span>
    </div>
    <div class="mock-body" aria-hidden="true">
      <div class="mock-nav">
        <b>{{ option.mockup.appName }}</b
        ><span
          v-for="(label, index) in option.mockup.navigation"
          :key="index"
          :class="{ current: index === 0 }"
          >{{ label }}</span
        >
      </div>
      <div class="mock-content">
        <h4>{{ option.mockup.title }}</h4>
        <p>{{ option.mockup.subtitle }}</p>
        <span class="mock-action">{{ option.mockup.action }} <span>+</span></span>
        <div class="mock-items">
          <div v-for="(item, index) in option.mockup.items" :key="index" class="mock-item">
            <i />
            <div>
              <b>{{ item.title }}</b
              ><small>{{ item.detail }}</small>
            </div>
            <span>›</span>
          </div>
        </div>
      </div>
      <div v-if="option.mockup.layout === 'split'" class="mock-detail">
        <span class="mock-detail-dot" />
        <h4>{{ option.mockup.items[0]?.title }}</h4>
        <p>{{ option.mockup.items[0]?.detail }}</p>
        <div class="mock-rule" />
        <div class="mock-rule short" />
      </div>
    </div>
  </div>
</template>
<style scoped>
.design-mock {
  container-type: inline-size;
  background: var(--mock-bg);
  color: var(--mock-ink);
  font-family: var(--mock-font);
  border-radius: 10px;
  overflow: hidden;
  text-align: left;
  box-shadow: 0 5px 18px #0001;
}
.mock-window {
  height: 25px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--mock-ink) 12%, transparent);
  background: var(--mock-surface);
  font-size: 8px;
}
.mock-window i {
  width: 4px;
  height: 4px;
  background: var(--mock-ink);
  opacity: 0.25;
  border-radius: 50%;
}
.mock-window span {
  margin: 0 auto;
}
.mock-body {
  display: grid;
  grid-template-columns: 27% 1fr;
  min-height: 245px;
}
.mock-nav {
  padding: 16px 8px;
  background: var(--mock-surface);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 9px;
  border-right: 1px solid color-mix(in srgb, var(--mock-ink) 10%, transparent);
}
.mock-nav b {
  font-size: 11px;
  margin-bottom: 14px;
  overflow-wrap: anywhere;
}
.mock-nav span {
  padding: 7px 5px;
  border-radius: var(--mock-radius);
  overflow-wrap: anywhere;
}
.mock-nav .current {
  background: color-mix(in srgb, var(--mock-accent) 13%, var(--mock-surface));
  font-weight: bold;
}
.mock-content {
  padding: 20px 12px;
  min-width: 0;
}
.design-mock h4 {
  font-family: inherit;
  font-size: 17px;
  line-height: 1.2;
  margin: 0 0 7px;
  overflow-wrap: anywhere;
}
.design-mock p {
  font-size: 9px;
  line-height: 1.5;
  margin: 0 0 12px;
  opacity: 0.8;
}
.mock-action {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 9px;
  padding: 8px;
  border: 1px solid var(--mock-accent);
  color: var(--mock-ink);
  border-radius: var(--mock-radius);
  margin-bottom: 14px;
  background: var(--mock-surface);
}
.mock-items {
  display: grid;
  gap: 6px;
}
.mock-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 6px;
  background: var(--mock-surface);
  border-radius: var(--mock-radius);
  font-size: 9px;
}
.mock-item div {
  flex: 1;
  min-width: 0;
}
.mock-item b {
  display: block;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.mock-item small {
  display: block;
  font-size: 7px;
  opacity: 0.7;
  margin-top: 5px;
}
.mock-item i {
  flex: 0 0 8px;
  width: 8px;
  height: 8px;
  border: 1px solid var(--mock-accent);
  border-radius: 50%;
}
.mock-topbar .mock-body {
  display: block;
}
.mock-topbar .mock-nav {
  flex-direction: row;
  align-items: center;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--mock-ink) 12%, transparent);
  gap: 4px;
  padding: 8px;
}
.mock-topbar .mock-nav b {
  margin: 0 auto 0 0;
}
.mock-topbar .mock-content {
  padding: 18px 24px;
}
.mock-topbar .mock-item {
  background: transparent;
  border-radius: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--mock-ink) 15%, transparent);
}
.design-mock.mock-topbar h4 {
  font-size: 23px;
}
.mock-split .mock-body {
  grid-template-columns: 55% 45%;
}
.mock-split .mock-nav {
  grid-column: 1 / -1;
  flex-direction: row;
  align-items: center;
  padding: 8px;
  border: 0;
  gap: 4px;
}
.mock-split .mock-nav b {
  margin: 0 auto 0 0;
}
.mock-split .mock-content {
  padding: 16px 8px;
}
.design-mock.mock-split h4 {
  font-size: 15px;
}
.mock-detail {
  margin: 14px 10px 14px 0;
  padding: 12px;
  border-radius: var(--mock-radius);
  background: var(--mock-surface);
}
.mock-detail-dot {
  display: block;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--mock-accent) 20%, var(--mock-surface));
  margin-bottom: 16px;
}
.mock-rule {
  height: 4px;
  background: var(--mock-ink);
  opacity: 0.1;
  margin: 8px 0;
  border-radius: 4px;
}
.mock-rule.short {
  width: 65%;
}
.mock-mobile {
  max-width: 240px;
  margin-inline: auto;
}
.mock-mobile .mock-body {
  display: flex;
  flex-direction: column;
  min-height: 340px;
}
.mock-mobile .mock-nav {
  order: 2;
  flex-direction: row;
  justify-content: space-around;
  margin-top: auto;
  border: 0;
  padding: 8px;
}
.mock-mobile .mock-nav b {
  display: none;
}
.mock-mobile .mock-content {
  padding: 24px 16px;
}
.mock-mobile .mock-detail {
  margin: 0 16px 16px;
}
.mock-mobile.mock-split .mock-items {
  display: none;
}
@container (max-width: 140px) {
  .mock-body {
    min-height: 140px;
  }
  .mock-content {
    padding: 8px;
  }
  .design-mock h4 {
    font-size: 9px !important;
  }
  .mock-nav {
    padding: 5px !important;
  }
  .mock-nav span,
  .mock-nav b {
    font-size: 5px;
    padding: 2px;
  }
  .mock-window {
    height: 15px;
  }
  .mock-item {
    padding: 3px;
    font-size: 5px;
  }
  .mock-item small,
  .mock-action,
  p {
    font-size: 5px;
  }
  .mock-detail {
    padding: 5px;
  }
  .mock-detail-dot {
    width: 10px;
    height: 10px;
  }
  .mock-mobile .mock-body {
    min-height: 160px;
  }
}
</style>
