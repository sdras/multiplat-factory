<script setup lang="ts">
import type { RunView } from '@mpf/core/reducer'
const props = defineProps<{ view: RunView; connected: boolean; elapsed: string }>()
const emit = defineEmits<{ action: [path: string] }>()
const run = computed(() => props.view.run!)
const done = computed(
  () => props.view.stages.filter((s) => ['succeeded', 'skipped'].includes(s.status)).length,
)
const latest = computed(
  () =>
    props.view.stages.find((s) => s.status === 'running') ??
    props.view.stages.find((s) => s.status === 'waiting_human'),
)
const lanes = computed(() =>
  run.value.targets.map((target) => {
    const stages = props.view.stages.filter((s) => s.target === target)
    return {
      target,
      stages,
      done: stages.filter((s) => ['succeeded', 'skipped'].includes(s.status)).length,
      status: groupStatus(stages),
    }
  }),
)
const statusDescription = computed(
  () =>
    ({
      queued: 'Waiting to start. Progress will appear here when the run begins.',
      running: 'The port is running. You can follow each platform below or pause the run.',
      succeeded:
        'The build is complete. Review the test results and any reported differences before publishing.',
      partial: 'Some platforms did not finish. Review their results and the details below.',
      failed:
        'The run stopped because a step failed. Open the details below to review the error and available controls.',
      waiting_human: 'The run needs your input. Review the request below to continue.',
      paused: 'The run is paused. You can resume it when you’re ready.',
      cancelled: 'The run was cancelled. Its results and logs are still available below.',
    })[run.value.status],
)
</script>
<template>
  <BoardHero
    title="Build progress"
    :description="`${projectName(run.source.locator)}. ${statusDescription}`"
    art="progress"
  />
  <div class="board-toolbar board-run-toolbar">
    <div class="row">
      <StatusLamp :status="run.status" :label="boardStatus[run.status]" /><span
        v-if="run.options.fake"
        class="tag"
        >Demo run</span
      ><StatusLamp
        :status="connected ? 'ok' : 'warn'"
        :label="connected ? 'Live updates' : 'Reconnecting'"
      />
    </div>
    <div class="row">
      <button v-if="run.status === 'running'" class="btn" @click="emit('action', '/pause')">
        <UiIcon name="pause" />Pause</button
      ><button v-if="run.status === 'paused'" class="btn" @click="emit('action', '/resume')">
        <UiIcon name="play" />Resume</button
      ><NuxtLink :to="`/runs/${run.id}/tests`" class="btn">Tests &amp; previews</NuxtLink
      ><NuxtLink :to="`/runs/${run.id}/release`" class="btn primary"
        >Release checklist<UiIcon name="arrow-right"
      /></NuxtLink>
    </div>
  </div>
  <div class="board-columns board-build-summary">
    <section class="board-card">
      <div class="board-toolbar">
        <h2>Platform progress</h2>
        <span class="hint">{{ done }} / {{ view.stages.length }} steps</span>
      </div>
      <progress :value="done" :max="view.stages.length || 1" aria-label="Build stages complete" />
      <p v-if="latest" class="hint">
        Now: {{ boardStage[latest.kind] ?? latest.kind
        }}{{ latest.target ? ' · ' + boardPlatform[latest.target] : '' }}
      </p>
      <div v-for="lane in lanes" :key="lane.target" class="board-lane">
        <div class="board-toolbar">
          <strong>{{ boardPlatform[lane.target] }}</strong
          ><StatusLamp :status="lane.status" />
        </div>
        <progress
          :value="lane.done"
          :max="lane.stages.length || 1"
          :aria-label="`${boardPlatform[lane.target]} progress`"
        />
        <p class="hint">
          {{
            lane.stages.length
              ? `${lane.done} of ${lane.stages.length} steps complete`
              : 'Waiting for the build plan'
          }}
        </p>
      </div>
    </section>
    <aside class="board-card board-aside">
      <h2>Run budget</h2>
      <h2 class="board-serif">
        {{ money(run.costUsd) }} <span class="hint">of {{ money(run.options.budgetUsd, 0) }}</span>
      </h2>
      <progress :value="run.costUsd" :max="run.options.budgetUsd" aria-label="Run budget used" />
      <p class="hint">Work stops at your run limit.</p>
      <div class="board-toolbar small">
        <span>Elapsed</span><span>{{ elapsed }}</span>
      </div>
      <NuxtLink class="inline small" :to="`/runs/${run.id}/plan`">Review the plan</NuxtLink>
    </aside>
  </div>
</template>
