<script setup lang="ts">
import type { Run, Stage } from '@mpf/core/schemas'
const props = defineProps<{
  runs: Run[]
  stagesOf: Record<string, Stage[]>
  loaded: boolean
  error?: string
}>()
const filter = ref('all')
const groups = computed(() =>
  groupProjects(props.runs).filter(
    (p) =>
      filter.value === 'all' ||
      (filter.value === 'needs'
        ? ['failed', 'partial', 'waiting_human'].includes(p.history[0]!.status)
        : ACTIVE_RUN.has(p.history[0]!.status)),
  ),
)
function completion(id: string) {
  const stages = props.stagesOf[id] ?? []
  return stages.length
    ? Math.round(
        (stages.filter((s) => ['succeeded', 'skipped'].includes(s.status)).length / stages.length) *
          100,
      )
    : 0
}
</script>
<template>
  <BoardHero
    title="Projects"
    description="A list of all of your projects, ported to other platforms, and their high level status."
  />
  <div class="board-toolbar">
    <div class="seg-group board-project-filters" aria-label="Filter projects" role="group">
      <button
        v-for="option in [
          ['all', 'All projects'],
          ['active', 'In progress'],
          ['needs', 'Needs you'],
        ]"
        :key="option[0]"
        class="seg"
        :class="{ on: filter === option[0] }"
        :aria-pressed="filter === option[0]"
        @click="filter = option[0]!"
      >
        <span>{{ option[1] }}</span>
      </button>
    </div>
    <NuxtLink to="/runs/new" class="btn primary"><UiIcon name="plus" /> New project</NuxtLink>
  </div>
  <p v-if="error" class="callout bad" role="alert">Couldn’t load your projects. {{ error }}</p>
  <p v-else-if="!loaded" class="board-empty" role="status">Loading your projects…</p>
  <div v-else-if="!groups.length" class="board-card board-empty">
    <h2>
      {{ runs.length ? 'No projects match this filter.' : 'No projects yet.' }}
    </h2>
    <p>Add an existing app and choose the platforms you want to port it to.</p>
    <NuxtLink to="/runs/new" class="btn primary"
      >Create a project <UiIcon name="arrow-right"
    /></NuxtLink>
  </div>
  <div v-else class="board-project-grid">
    <article v-for="p in groups" :key="p.source" class="board-card board-project">
      <div class="board-toolbar">
        <span class="board-monogram">{{ p.name.slice(0, 1).toUpperCase() }}</span
        ><StatusLamp :status="p.history[0]!.status" :label="boardStatus[p.history[0]!.status]" />
      </div>
      <h2>
        <NuxtLink :to="`/runs/${p.history[0]!.id}`">{{ p.name }}</NuxtLink>
      </h2>
      <p class="board-path">{{ p.source }}</p>
      <div class="row">
        <span v-for="t in p.history[0]!.targets" :key="t" class="tag">{{ boardPlatform[t] }}</span
        ><span v-if="p.history[0]!.options.fake" class="tag">Demo run</span>
      </div>
      <p class="board-project-summary">
        {{
          p.history[0]!.summary ||
          'Open the project to see its current step, test results, and any issues.'
        }}
      </p>
      <div class="board-toolbar small">
        <span>Steps complete</span><span>{{ completion(p.history[0]!.id) }}%</span>
      </div>
      <progress :value="completion(p.history[0]!.id)" max="100" aria-label="Completed stages" />
      <div class="board-toolbar small dim">
        <span
          >{{ money(p.history[0]!.costUsd) }} of
          {{ money(p.history[0]!.options.budgetUsd, 0) }}</span
        ><span>{{ p.history.length }} {{ p.history.length === 1 ? 'run' : 'runs' }}</span>
      </div>
      <div class="board-toolbar">
        <NuxtLink class="btn" :to="`/runs/${p.history[0]!.id}`"
          >Open project <UiIcon name="arrow-right" /></NuxtLink
        ><NuxtLink class="inline small" :to="`/runs/${p.history[0]!.id}/release`"
          >Release checklist</NuxtLink
        >
      </div>
      <details v-if="p.history.length > 1" class="board-details">
        <summary>Previous runs</summary>
        <NuxtLink
          v-for="r in p.history.slice(1)"
          :key="r.id"
          :to="`/runs/${r.id}`"
          class="board-history-row"
          ><span>{{ new Date(r.createdAt).toLocaleString() }}</span
          ><span>{{ boardStatus[r.status] }}</span
          ><span>{{ money(r.costUsd) }}</span></NuxtLink
        >
      </details>
    </article>
  </div>
</template>
