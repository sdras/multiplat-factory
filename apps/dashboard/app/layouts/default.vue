<script setup lang="ts">
const route = useRoute()
const { ok, checked } = useHealth()
const host = ref('')
onMounted(() => (host.value = window.location.host))

const section = computed<'runs' | 'new' | 'doctor'>(() => {
  if (route.path === '/runs/new') return 'new'
  if (route.path.startsWith('/doctor')) return 'doctor'
  return 'runs'
})
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <NuxtLink to="/" class="brand" aria-label="multiplat-factory, runs">
        <AppMark />
        <span class="lbl brand-name">Multiplat Factory</span>
      </NuxtLink>
      <nav class="nav" aria-label="Sections">
        <NuxtLink to="/" :class="{ on: section === 'runs' }">Runs</NuxtLink>
        <NuxtLink to="/runs/new" :class="{ on: section === 'new' }">New run</NuxtLink>
        <NuxtLink to="/doctor" :class="{ on: section === 'doctor' }">Doctor</NuxtLink>
      </nav>
      <div
        class="topbar-status"
        :title="ok ? 'Server reachable' : checked ? 'Server unreachable' : 'Checking the server'"
      >
        <span class="lamp" :class="ok ? 'st-succeeded' : checked ? 'st-failed' : 'st-pending'" />
        <span class="lbl">{{ ok ? 'Live' : checked ? 'Offline' : 'Checking' }}</span>
        <span class="mono muted small">{{ host }}</span>
      </div>
    </header>
    <main><slot /></main>
  </div>
</template>
