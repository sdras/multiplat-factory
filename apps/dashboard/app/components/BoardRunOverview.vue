<script setup lang="ts">
import type { RunView } from '@mpf/core/reducer'
import type { Stage } from '@mpf/core/schemas'
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
/** A lane or step status in the board's words. */
const STEP_LABELS: Record<string, string> = {
  succeeded: 'Done',
  skipped: 'Skipped',
  running: 'In progress',
  waiting_human: 'Needs your input',
  paused: 'Paused',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  queued: 'Up next',
  pending: 'Up next',
}
const LANE_LABELS: Record<string, string> = {
  ...STEP_LABELS,
  succeeded: 'Build complete',
  failed: 'Needs attention',
  blocked: 'Needs attention',
}
type StepState = 'done' | 'live' | 'needs' | 'bad' | 'next'
function stepState(s: Stage): StepState {
  if (s.status === 'succeeded' || s.status === 'skipped') return 'done'
  if (s.status === 'running') return 'live'
  if (s.status === 'waiting_human' || s.status === 'paused') return 'needs'
  if (s.status === 'failed' || s.status === 'blocked' || s.status === 'cancelled') return 'bad'
  return 'next'
}
function stepNote(s: Stage): string {
  const note = STEP_LABELS[s.status] ?? statusLabel(s.status)
  return s.costUsd > 0 ? `${note} · ${money(s.costUsd)}` : note
}
const { now } = useClock(30_000)
/** The last things that happened, newest first, read off the stages' own timestamps so no log needs opening. */
const activity = computed(() =>
  props.view.stages
    .filter((s) => s.startedAt)
    .map((s) => {
      const at = s.endedAt ?? s.startedAt!
      const name = `${boardStage[s.kind] ?? s.kind}${s.target ? ` · ${boardPlatform[s.target]}` : ''}`
      const label = STEP_LABELS[s.status] ?? statusLabel(s.status)
      const what = s.error?.message ? `${label}: ${s.error.message}` : label
      return { id: s.id, at, text: `${name}: ${what.toLowerCase()}` }
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5),
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
          ><StatusLamp
            :status="lane.status"
            :label="LANE_LABELS[lane.status] ?? statusLabel(lane.status)"
          />
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
        <ol v-if="lane.stages.length" class="board-lane-steps">
          <li v-for="s in lane.stages" :key="s.id" :data-state="stepState(s)">
            <b>
              <UiIcon v-if="stepState(s) === 'done'" name="check" :size="12" />
              <UiIcon v-else-if="stepState(s) === 'bad'" name="x" :size="12" />
              <span
                v-else
                class="lamp"
                :class="{ live: stepState(s) === 'live', hollow: stepState(s) === 'next' }"
              />
              {{ boardStage[s.kind] ?? s.kind }}
            </b>
            <span class="board-step-note">{{ stepNote(s) }}</span>
          </li>
        </ol>
      </div>
    </section>
    <aside class="board-aside">
      <section class="board-card">
        <h2>Run budget</h2>
        <h2 class="board-serif">
          {{ money(run.costUsd) }}
          <span class="hint">of {{ money(run.options.budgetUsd, 0) }}</span>
        </h2>
        <progress :value="run.costUsd" :max="run.options.budgetUsd" aria-label="Run budget used" />
        <p class="hint">Work stops at your run limit. You can raise it when the run pauses.</p>
        <div class="board-toolbar small">
          <span>Elapsed</span><span>{{ elapsed }}</span>
        </div>
        <NuxtLink class="inline small" :to="`/runs/${run.id}/plan`">Review the plan</NuxtLink>
      </section>
      <section class="board-card">
        <h2>Recent activity</h2>
        <ol v-if="activity.length" class="board-activity">
          <li v-for="t in activity" :key="t.id">
            <time :datetime="t.at">{{ when(t.at, now) }}</time
            ><span>{{ t.text }}</span>
          </li>
        </ol>
        <p v-else class="hint">Nothing recorded for this run yet.</p>
        <a href="#run-technical" class="inline small">Open the technical log</a>
      </section>
    </aside>
  </div>
</template>
