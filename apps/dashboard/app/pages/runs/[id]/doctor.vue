<script setup lang="ts">
const route = useRoute()
const base = computed(() => `/runs/${String(route.params.id)}`)
const returnTo = computed(() => {
  const section = typeof route.query.returnTo === 'string' ? route.query.returnTo : ''
  return ['plan', 'tests', 'release', 'spec', 'critic', 'core'].includes(section)
    ? `${base.value}/${section}`
    : base.value
})
</script>

<template>
  <div>
    <NuxtLink :to="returnTo" class="inline small">Back to project</NuxtLink>
    <DoctorView />
  </div>
</template>
