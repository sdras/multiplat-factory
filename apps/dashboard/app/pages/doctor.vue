<script setup lang="ts">
import type { ToolchainReport } from '@mpf/core/schemas'

const api = useApi()
const report = ref<ToolchainReport>()
const error = ref<string>()
const busy = ref(false)
const copied = ref<string>()
const { now } = useClock(5000)

async function load(refresh = false) {
  busy.value = true
  try {
    report.value = await api.get(`/doctor${refresh ? '?refresh=1' : ''}`)
    error.value = undefined
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
onMounted(() => load())

const TARGETS = [
  { id: 'web', name: 'web' },
  { id: 'ios', name: 'iOS' },
  { id: 'android', name: 'android' },
] as const
const available = computed(() => new Set(report.value?.availableTargets ?? []))
const checkedAgo = computed(() => {
  if (!report.value) return ''
  const s = Math.max(
    0,
    Math.round((now.value - new Date(report.value.generatedAt).getTime()) / 1000),
  )
  return s < 60 ? 'just now' : `${Math.round(s / 60)} min ago`
})
const fixOf = (c: ToolchainReport['checks'][number]) =>
  c.fix?.brew ?? c.fix?.apt ?? c.fix?.winget ?? c.fix?.manual

async function copy(text: string, id: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = id
    setTimeout(() => (copied.value = undefined), 1500)
  } catch {
    copied.value = undefined
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="title">Doctor</h1>
        <p class="subtitle">
          Toolchains found on this machine and what each one unlocks. Nothing here is configured by
          hand; overrides live in <code>~/.mpf/config.json</code>.
        </p>
      </div>
      <div class="grow" />
      <div v-if="report" class="readouts">
        <div class="readout">
          <span class="k">Host</span
          ><span class="v mono"
            >{{ report.host.os }} / {{ report.host.arch }} · node {{ report.host.node }}</span
          >
        </div>
        <div class="readout">
          <span class="k">Targets available</span>
          <span class="v row" style="gap: 14px">
            <StatusLamp
              v-for="t in TARGETS"
              :key="t.id"
              :status="available.has(t.id) ? 'ok' : 'missing'"
              :label="t.name"
              :hollow="!available.has(t.id)"
            />
          </span>
        </div>
        <div class="readout">
          <span class="k">Claude backend</span><span class="v mono">{{ report.llmBackend }}</span>
        </div>
        <div class="readout">
          <span class="k">Checked</span><span class="v">{{ checkedAgo }}</span>
        </div>
      </div>
      <button class="btn" type="button" :disabled="busy" @click="load(true)">
        <UiIcon name="refresh" />{{ busy ? 'Checking' : 'Re-check' }}
      </button>
    </div>

    <div v-if="error" class="callout bad" style="margin-bottom: 16px">
      <span class="lamp" />
      <div>
        <div class="head">Cannot reach the server</div>
        <div class="body">{{ error }}. Start it with <code>pnpm mpf serve</code>.</div>
      </div>
    </div>

    <div v-if="report" class="boxed">
      <div class="head-row check-head">
        <span>Status</span><span>Check</span><span>Detail · fix</span
        ><span class="affects">Affects</span>
      </div>
      <div v-for="c in report.checks" :key="c.id" class="check">
        <StatusLamp :status="c.status" strong :hollow="c.status !== 'ok'" />
        <div class="cell" style="line-height: 1.35">
          <span style="font-size: 13.5px; font-weight: 700">{{ c.label }}</span>
          <span v-if="c.version" class="mono small muted">{{ c.version }}</span>
        </div>
        <div class="stack" style="gap: 6px">
          <span
            style="font-size: 13px; line-height: 1.45"
            :class="c.status === 'ok' ? 'dim' : ''"
            >{{ c.detail }}</span
          >
          <div v-if="c.status !== 'ok' && fixOf(c)" class="fix">
            <code>{{ fixOf(c) }}</code>
            <button
              class="btn tiny"
              type="button"
              :aria-label="`Copy the fix for ${c.label}`"
              @click="copy(fixOf(c)!, c.id)"
            >
              <UiIcon name="copy" :size="11" />{{ copied === c.id ? 'Copied' : 'Copy' }}
            </button>
          </div>
        </div>
        <div class="tags affects">
          <span v-for="a in c.affects" :key="a" class="tag">{{ a }}</span>
        </div>
      </div>
    </div>
    <p v-else-if="!error" class="muted">Checking toolchains…</p>
  </div>
</template>

<style scoped>
.check-head {
  grid-template-columns: 130px 200px minmax(0, 1fr) 190px;
  gap: 18px;
}
.cell {
  display: flex;
  flex-direction: column;
}
@media (max-width: 1100px) {
  .check-head {
    grid-template-columns: 110px minmax(0, 1fr);
  }
  .check-head .affects {
    display: none;
  }
}
</style>
