<script setup lang="ts">
import type { Run, ToolchainReport } from '@mpf/core/schemas'

type Target = 'web' | 'ios' | 'android'

const api = useApi()
const router = useRouter()
const doctor = ref<ToolchainReport>()
const health = ref<{ realPipeline: boolean; availableStages?: string[]; version?: string }>()
const form = reactive({
  locator: '',
  targets: { web: false, ios: true, android: true } as Record<Target, boolean>,
  coreMode: 'auto' as 'auto' | 'always' | 'never',
  webFramework: 'auto' as 'auto' | 'vanilla' | 'react' | 'vue' | 'svelte',
  budgetUsd: 30,
  planApproval: true,
  beforeFixLoop: false,
  fake: false,
})
const error = ref<string>()
const busy = ref(false)

onMounted(async () => {
  try {
    health.value = await api.get('/health')
    doctor.value = await api.get('/doctor')
    if (!health.value?.realPipeline) form.fake = true
  } catch (e) {
    error.value = (e as Error).message
  }
})

const TARGETS: { id: Target; name: string; desc: string }[] = [
  {
    id: 'web',
    name: 'Web',
    desc: 'A web port, and the reference build when the source is native.',
  },
  { id: 'ios', name: 'iOS', desc: 'A native iOS project, built and tested on a simulator.' },
  {
    id: 'android',
    name: 'Android',
    desc: 'A native Android project, built and tested on an emulator.',
  },
]
const CORE_MODES: { id: typeof form.coreMode; label: string; hint: string }[] = [
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Extracts a shared core only when the app has enough platform-independent logic to be worth one module every target calls.',
  },
  {
    id: 'always',
    label: 'Always',
    hint: 'Always extracts a shared core, even when the logic is thin. Useful when parity across targets matters more than simplicity.',
  },
  {
    id: 'never',
    label: 'Never',
    hint: 'Every target carries its own logic. Simplest projects, no Rust toolchain needed.',
  },
]
const STEPS = [
  [
    'Ingest and inventory',
    'Clone or copy the source into a workspace, detect the platform, parse it.',
  ],
  [
    'Spec and behaviors',
    'Write a framework-neutral description of the app and the list of behaviors every port must keep.',
  ],
  [
    'Observe the original',
    'Run the source app, walk the behaviors, capture screenshots as the reference.',
  ],
  [
    'Plan',
    'Decide how each target is built and whether a shared core is worth it. Pauses here if you asked to approve.',
  ],
  [
    'Generate, build, test, review',
    'Per target, in parallel: scaffold, implement, compile, test on a device, critic review, bounded fix loop.',
  ],
  [
    'Report',
    'PORT.md per target with the architecture map, wire-format pins and documented deviations.',
  ],
]

const available = computed(() => new Set(doctor.value?.availableTargets ?? []))
const chosen = computed(() => TARGETS.map((t) => t.id).filter((t) => form.targets[t]))
const coreHint = computed(() => CORE_MODES.find((m) => m.id === form.coreMode)?.hint ?? '')
const WEB_FRAMEWORKS: { id: typeof form.webFramework; label: string }[] = [
  { id: 'auto', label: 'Plan decides' },
  { id: 'vanilla', label: 'Vanilla' },
  { id: 'react', label: 'React' },
  { id: 'vue', label: 'Vue' },
  { id: 'svelte', label: 'Svelte' },
]
const webChosen = computed(() => chosen.value.includes('web'))

function readiness(t: Target): { status: string; text: string } {
  if (form.fake) return { status: 'ok', text: 'fake run, nothing needed' }
  if (!doctor.value) return { status: 'pending', text: 'checking toolchains' }
  if (available.value.has(t)) return { status: 'ok', text: 'toolchain ready' }
  const failing = doctor.value.checks.find((c) => c.affects.includes(t) && c.status !== 'ok')
  return {
    status: 'missing',
    text: failing ? `${failing.label} ${failing.status}` : 'unavailable here',
  }
}
const disabled = (t: Target) => !form.fake && !!doctor.value && !available.value.has(t)

async function submit() {
  error.value = undefined
  if (!form.locator && !form.fake) return (error.value = 'Enter a source path or git URL.')
  if (!chosen.value.length) return (error.value = 'Pick at least one target.')
  busy.value = true
  try {
    const run = await api.post<Run>('/runs', {
      source: { locator: form.locator || './fake-source' },
      targets: chosen.value,
      options: {
        coreMode: form.coreMode,
        ...(form.webFramework !== 'auto' && webChosen.value
          ? { webFramework: form.webFramework }
          : {}),
        budgetUsd: form.budgetUsd,
        checkpoints: { planApproval: form.planApproval, beforeFixLoop: form.beforeFixLoop },
        fake: form.fake,
      },
    })
    router.push(`/runs/${run.id}`)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="title">New run</h1>
        <p class="subtitle">
          Point the factory at an app. It ports the app to the targets you pick and pauses where you
          tell it to.
        </p>
      </div>
    </div>

    <div class="grid-hair three form-grid">
      <form class="pane" style="gap: 22px; padding: 22px 26px" @submit.prevent="submit">
        <div v-if="health && !health.realPipeline" class="callout quiet">
          <span class="lamp" style="color: var(--ink-2)" />
          <div class="body">
            This build has no real pipeline yet. A fake run exercises every stage, the live stream
            and the controls without calling an LLM or a toolchain.
          </div>
        </div>

        <div class="stack">
          <label class="k" for="locator">Source app</label>
          <input
            id="locator"
            v-model="form.locator"
            class="tall mono"
            type="text"
            placeholder="/path/to/app or https://github.com/org/app"
            :disabled="form.fake"
          />
          <p class="hint">
            A local path or a git URL. Platform and framework are detected in the first stage; if
            detection is ambiguous the run asks you.
          </p>
        </div>

        <fieldset class="stack" style="border: 0; margin: 0; padding: 0">
          <legend class="k" style="padding: 0; margin-bottom: 8px">Targets</legend>
          <div class="tiles">
            <label
              v-for="t in TARGETS"
              :key="t.id"
              class="tile"
              :class="{ on: form.targets[t.id] && !disabled(t.id), off: disabled(t.id) }"
            >
              <span class="top">
                <span class="name">{{ t.name }}</span>
                <input
                  v-model="form.targets[t.id]"
                  type="checkbox"
                  :disabled="disabled(t.id)"
                  :aria-label="`Target ${t.name}`"
                />
              </span>
              <span class="desc">{{ t.desc }}</span>
              <StatusLamp :status="readiness(t.id).status" :label="readiness(t.id).text" />
              <NuxtLink
                v-if="readiness(t.id).status === 'missing'"
                to="/doctor"
                class="inline small"
                style="align-self: flex-start"
                >See Doctor</NuxtLink
              >
            </label>
          </div>
        </fieldset>

        <div class="two" style="gap: 26px">
          <div class="stack">
            <span class="k">Shared WebAssembly core</span>
            <div class="seg-group" role="group" aria-label="Core mode">
              <button
                v-for="m in CORE_MODES"
                :key="m.id"
                type="button"
                class="seg tall"
                :class="{ on: form.coreMode === m.id }"
                @click="form.coreMode = m.id"
              >
                {{ m.label }}
              </button>
            </div>
            <p class="hint">{{ coreHint }}</p>
            <template v-if="webChosen">
              <span class="k" style="margin-top: 12px">Web flavor</span>
              <div class="seg-group" role="group" aria-label="Web framework">
                <button
                  v-for="f in WEB_FRAMEWORKS"
                  :key="f.id"
                  type="button"
                  class="seg"
                  :class="{ on: form.webFramework === f.id }"
                  @click="form.webFramework = f.id"
                >
                  {{ f.label }}
                </button>
              </div>
              <p class="hint">
                Vite + TypeScript either way; the plan picks the closest match to the source unless
                you choose here.
              </p>
            </template>
          </div>
          <div class="stack">
            <label class="k" for="budget" style="display: flex; align-items: baseline; gap: 10px"
              >Budget cap
              <span
                class="mono"
                style="
                  font-size: 18px;
                  font-weight: 700;
                  text-transform: none;
                  letter-spacing: 0;
                  color: var(--ink);
                "
                >{{ money(form.budgetUsd, 0) }}</span
              ></label
            >
            <input
              id="budget"
              v-model.number="form.budgetUsd"
              type="range"
              min="1"
              max="100"
              step="1"
            />
            <div
              class="mono small muted"
              style="display: flex; justify-content: space-between; margin-top: -6px"
            >
              <span>$1</span><span>$25</span><span>$50</span><span>$75</span><span>$100</span>
            </div>
            <p class="hint">
              The run stops cleanly at the cap and reports budget exhaustion instead of retrying.
            </p>
          </div>
        </div>

        <div class="stack" style="gap: 10px">
          <span class="k">Checkpoints</span>
          <label class="switch"
            ><input v-model="form.planApproval" type="checkbox" /><span
              class="sw"
              aria-hidden="true"
            /><span>Pause for my approval after the port plan</span></label
          >
          <label class="switch"
            ><input v-model="form.beforeFixLoop" type="checkbox" /><span
              class="sw"
              aria-hidden="true"
            /><span>Pause before each fix loop</span></label
          >
          <label class="switch"
            ><input v-model="form.fake" type="checkbox" /><span
              class="sw"
              aria-hidden="true"
            /><span
              >Fake run
              <span class="muted"
                >· every stage, the live stream and the controls, with no LLM and no toolchain</span
              ></span
            ></label
          >
        </div>

        <div v-if="error" class="callout bad">
          <span class="lamp" />
          <div class="body">{{ error }}</div>
        </div>

        <div class="row" style="gap: 14px; margin-top: auto">
          <button class="btn primary tall" type="submit" :disabled="busy">
            <UiIcon name="play" />Start run
          </button>
          <span class="hint">Opens the live run as soon as it is queued.</span>
        </div>
      </form>

      <aside class="pane" style="gap: 22px; padding: 22px 26px">
        <div class="stack">
          <PanelTitle title="What happens" />
          <ol class="steps">
            <li v-for="(s, i) in STEPS" :key="s[0]">
              <span class="n">{{ String(i + 1).padStart(2, '0') }}</span>
              <span class="stack" style="gap: 1px"
                ><span class="t">{{ s[0] }}</span
                ><span class="d">{{ s[1] }}</span></span
              >
            </li>
          </ol>
        </div>
        <div class="stack">
          <PanelTitle title="This machine"
            ><NuxtLink to="/doctor" class="inline small">Doctor</NuxtLink></PanelTitle
          >
          <div v-if="doctor" class="kv">
            <span class="k">Targets</span>
            <span class="row" style="gap: 14px">
              <StatusLamp
                v-for="t in TARGETS"
                :key="t.id"
                :status="available.has(t.id) ? 'ok' : 'missing'"
                :label="t.name"
                :hollow="!available.has(t.id)"
              />
            </span>
            <span class="k">Claude</span
            ><span>{{
              doctor.llmBackend === 'none' ? 'no backend found' : doctor.llmBackend
            }}</span>
            <span class="k">Host</span
            ><span class="mono small"
              >{{ doctor.host.os }} / {{ doctor.host.arch }} · node {{ doctor.host.node }}</span
            >
            <span class="k">Pipeline</span
            ><span>{{
              health?.realPipeline ? 'real stages available' : 'fake pipeline only in this build'
            }}</span>
          </div>
          <p v-else class="hint">Waiting for the doctor report.</p>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.form-grid {
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
}
.tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 900px) {
  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .tiles {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
