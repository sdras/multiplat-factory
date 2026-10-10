<script setup lang="ts">
import type { Artifact } from '@mpf/core/schemas'

const route = useRoute()
const id = String(route.params.id)
const api = useApi()
const { view, error } = useRunView(id)

const wasmArtifact = computed<Artifact | undefined>(() =>
  [...view.value.artifacts].reverse().find((a) => a.kind === 'wasm-module'),
)
const parityReports = computed(() => view.value.tests.filter((t) => t.kind === 'parity'))
const core = ref<BrowserCore>()
const loadError = ref<string>()
const selected = ref<string>()
const input = ref('{}')
const output = ref<string>()
const outputOk = ref<boolean>()
const elapsedMs = ref<number>()

const fn = computed(() => core.value?.manifest.functions.find((f) => f.name === selected.value))

watch(
  wasmArtifact,
  async (a) => {
    if (!a || core.value) return
    loadError.value = undefined
    try {
      const res = await fetch(`${api.base}/runs/${id}/artifacts/${a.id}/content`)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      core.value = await loadBrowserCore(await res.arrayBuffer())
      selected.value = core.value.manifest.functions[0]?.name
    } catch (e) {
      loadError.value = (e as Error).message
    }
  },
  { immediate: true },
)

watch(fn, (f) => {
  if (f) input.value = JSON.stringify(exampleInput(f.inputSchema), null, 2)
  output.value = undefined
})

function run() {
  if (!core.value || !selected.value) return
  let parsed: unknown
  try {
    parsed = JSON.parse(input.value)
  } catch (e) {
    outputOk.value = false
    output.value = `input is not JSON: ${(e as Error).message}`
    return
  }
  const t = performance.now()
  const env = core.value.call(selected.value, parsed)
  elapsedMs.value = performance.now() - t
  outputOk.value = env.ok
  output.value = env.ok
    ? JSON.stringify(env.value, null, 2)
    : `${env.error?.code}: ${env.error?.message}`
}
</script>

<template>
  <div>
    <p class="muted">
      <NuxtLink :to="`/runs/${id}`">← Run</NuxtLink> ·
      <NuxtLink :to="`/runs/${id}/tests`">Tests</NuxtLink> ·
      <NuxtLink :to="`/runs/${id}/plan`">Plan</NuxtLink>
    </p>
    <h1>Shared core</h1>
    <p v-if="error" class="callout">{{ error }}</p>
    <template v-else-if="view.run">
      <p v-if="!wasmArtifact" class="muted">
        This run has no built core yet. It appears after the core stages succeed (core mode "auto"
        enables it when the plan finds enough pure logic).
      </p>
      <p v-else-if="loadError" class="callout">Could not load the module: {{ loadError }}</p>
      <template v-else-if="core">
        <div class="panel" style="margin-bottom: 14px">
          <p>
            <code class="mono">{{ wasmArtifact.relPath }}</code>
            <span class="muted">
              · {{ ((Number(wasmArtifact.meta.bytes) || 0) / 1024).toFixed(1) }} KiB · ABI
              {{ core.manifest.abiVersion }} ·
              {{ core.manifest.functions.length }} function(s)</span
            >
            <span v-for="r in parityReports" :key="r.stageId + r.target" class="muted">
              · {{ r.target === 'core' ? 'rust' : r.target }} parity {{ r.summary.passed }}/{{
                r.summary.total
              }}</span
            >
          </p>
          <p class="muted small">
            The module runs here in your browser exactly as it runs in the ported apps. Pick a
            function, edit the JSON request, and call it.
          </p>
        </div>
        <div class="grid two" style="gap: 14px; align-items: start">
          <div class="panel">
            <label for="fn"><b>Function</b></label>
            <select id="fn" v-model="selected" style="display: block; margin: 6px 0 10px">
              <option v-for="f in core.manifest.functions" :key="f.name" :value="f.name">
                {{ f.name }}
              </option>
            </select>
            <p v-if="fn" class="muted small">{{ fn.description || 'no description' }}</p>
            <label for="input"><b>Request (JSON)</b></label>
            <textarea
              id="input"
              v-model="input"
              rows="12"
              class="mono"
              style="display: block; width: 100%; margin: 6px 0 10px"
              spellcheck="false"
            />
            <button class="btn primary" type="button" @click="run">Call</button>
            <details v-if="fn" style="margin-top: 12px">
              <summary class="muted">Schemas</summary>
              <pre class="mono small">{{
                JSON.stringify({ input: fn.inputSchema, output: fn.outputSchema }, null, 2)
              }}</pre>
            </details>
          </div>
          <div class="panel">
            <b>Response</b>
            <span v-if="elapsedMs !== undefined" class="muted small">
              · {{ elapsedMs.toFixed(2) }} ms</span
            >
            <pre
              v-if="output !== undefined"
              class="mono"
              :class="outputOk ? '' : 'callout'"
              style="white-space: pre-wrap; margin-top: 8px"
              >{{ output }}</pre>
            <p v-else class="muted">Nothing called yet.</p>
          </div>
        </div>
      </template>
      <p v-else class="muted">Loading the module…</p>
    </template>
  </div>
</template>
