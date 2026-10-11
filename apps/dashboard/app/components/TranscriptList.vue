<script setup lang="ts">
import type { TranscriptItem } from '@mpf/core/reducer'

const props = defineProps<{ items: TranscriptItem[]; empty?: string; compact?: boolean }>()
const el = ref<HTMLElement>()

const TAG: Record<TranscriptItem['kind'], string> = {
  message: 'msg',
  tool_use: 'tool',
  tool_result: 'res',
  proc: 'proc',
  log: 'log',
}

function text(t: TranscriptItem): string {
  if (t.kind === 'tool_use') {
    const detail = toolInputSummary(t.meta?.input)
    return detail ? `${t.text}  ${detail}` : t.text
  }
  return t.text
}
function level(t: TranscriptItem): string {
  const lvl = t.meta?.level
  if (typeof lvl === 'string') return `lvl-${lvl}`
  return t.kind === 'tool_result' && t.meta?.ok === false ? 'lvl-error' : ''
}
/** A log line about what was dismissed on the device before a launch gets a device glyph instead of the log tag. */
const device = (t: TranscriptItem) => t.kind === 'log' && isDeviceNotice(t.text)

// Follow the tail while the reader is at the bottom; never yank a reader who scrolled up.
watch(
  () => props.items.length,
  async () => {
    const node = el.value
    if (!node) return
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40
    await nextTick()
    if (atBottom) node.scrollTop = node.scrollHeight
  },
)
onMounted(() => {
  if (el.value) el.value.scrollTop = el.value.scrollHeight
})
</script>

<template>
  <div ref="el" class="transcript" :class="{ compact }">
    <div v-for="t in items" :key="t.seq" class="item" :class="[`k-${t.kind}`, level(t)]">
      <span v-if="!compact" class="at">{{ timeOfDay(t.ts) }}</span>
      <span v-if="device(t)" class="k device" title="Device notice">
        <UiIcon name="device" :size="11" /><span class="sr-only">device</span>
      </span>
      <span v-else class="k">{{ TAG[t.kind] }}</span>
      <span class="txt">{{ text(t) }}</span>
    </div>
    <p v-if="!items.length" class="empty">{{ empty ?? 'Nothing yet.' }}</p>
  </div>
</template>

<style scoped>
.transcript.compact .item {
  grid-template-columns: 44px minmax(0, 1fr);
}
.k.device {
  display: inline-flex;
  align-items: center;
  padding-top: 3px;
}
</style>
