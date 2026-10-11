<script setup lang="ts">
const route = useRoute()
const { style, isBoard } = useDashboardStyle()
const { ok, checked } = useHealth()
const host = ref('')
onMounted(() => (host.value = window.location.host))
useHead(() => ({ htmlAttrs: { 'data-dashboard-style': style.value } }))
const runId = computed(() =>
  typeof route.params.id === 'string'
    ? route.params.id
    : typeof route.query.from === 'string'
      ? route.query.from
      : undefined,
)
const section = computed(() =>
  route.path === '/runs/new' ? 'new' : route.path.startsWith('/doctor') ? 'doctor' : 'runs',
)
const runLinks = computed(() =>
  runId.value
    ? [
        [`/runs/${runId.value}`, 'Build progress'],
        [`/runs/${runId.value}/plan`, 'Plan'],
        [`/runs/${runId.value}/tests`, 'Tests & previews'],
        [`/runs/${runId.value}/release`, 'Release checklist'],
        [`/runs/new?from=${runId.value}`, 'Next version'],
      ]
    : [],
)
const detailHero = computed(() => {
  if (!runId.value) return undefined
  const last = route.path.split('/').pop()
  return (
    {
      plan: ['Build plan', 'Review how each version will be built.', 'plan'],
      spec: [
        'App specification',
        'The screens, features, and behavior identified in your source app.',
        'plan',
      ],
      critic: [
        'Quality review',
        'Issues and differences found during review, including anything that needs your attention.',
        'tests',
      ],
      core: [
        'Shared app logic',
        'Logic used across platforms, with tests to check that it produces the same results.',
        'plan',
      ],
    } as Record<string, string[]>
  )[last ?? '']
})
</script>
<template>
  <div class="shell" :class="{ 'release-board': isBoard }">
    <header class="topbar">
      <NuxtLink to="/" class="brand" aria-label="Multiplat Factory, projects"
        ><AppMark /><span class="lbl brand-name">Multiplat Factory</span></NuxtLink
      >
      <nav v-if="!isBoard" class="nav" aria-label="Sections">
        <NuxtLink to="/" :class="{ on: section === 'runs' }">Runs</NuxtLink
        ><NuxtLink to="/runs/new" :class="{ on: section === 'new' }">New run</NuxtLink
        ><NuxtLink to="/doctor" :class="{ on: section === 'doctor' }">Doctor</NuxtLink>
      </nav>
      <div class="topbar-status">
        <span
          class="lamp"
          :class="ok ? 'st-succeeded' : checked ? 'st-failed' : 'st-pending'"
        /><span class="lbl">{{ ok ? 'Live' : checked ? 'Offline' : 'Checking' }}</span
        ><span v-if="!isBoard" class="mono muted small">{{ host }}</span>
      </div>
      <DashboardStyleSwitcher />
    </header>
    <nav v-if="isBoard" class="board-nav" aria-label="Workspace">
      <NuxtLink to="/" :aria-current="route.path === '/' ? 'page' : undefined">Projects</NuxtLink>
      <NuxtLink
        to="/runs/new"
        :aria-current="route.path === '/runs/new' && !route.query.from ? 'page' : undefined"
        >New project</NuxtLink
      >
      <NuxtLink
        v-for="[path, label] in runLinks"
        :key="path"
        :to="path!"
        :aria-current="route.fullPath === path ? 'page' : undefined"
        >{{ label }}</NuxtLink
      >
      <NuxtLink
        to="/doctor"
        :aria-current="section === 'doctor' ? 'page' : undefined"
        class="board-readiness"
        >Doctor</NuxtLink
      >
    </nav>
    <main>
      <BoardHero
        v-if="isBoard && detailHero"
        :title="detailHero[0]!"
        :description="detailHero[1]"
        :art="detailHero[2]"
      /><slot />
    </main>
  </div>
</template>
