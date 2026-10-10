<script setup lang="ts">
import type { Verdict } from '@mpf/core/schemas'

const route = useRoute()
const id = String(route.params.id)
const api = useApi()
const { view, error } = useRunView(id)
const note = ref('')

const byTarget = computed(() => {
  const m = new Map<string, Verdict[]>()
  for (const v of view.value.verdicts) m.set(v.target, [...(m.get(v.target) ?? []), v])
  return [...m.entries()].map(([target, verdicts]) => ({
    target,
    verdicts: verdicts.sort((a, b) => a.round - b.round),
  }))
})
const waiting = computed(() =>
  view.value.stages.filter((s) => s.kind === 'critique' && s.status === 'waiting_human'),
)

async function answer(stageId: string, choice: string) {
  await api
    .post(`/runs/${id}/stages/${stageId}/answer`, { choice, note: note.value || undefined })
    .catch((e) => alert((e as Error).message))
  note.value = ''
}
const score = (v: Verdict) =>
  `fidelity ${v.scores.fidelity} · idiomatic ${v.scores.idiomatic} · tests ${v.scores.testAdequacy} · parity docs ${v.scores.parityDocs} · build ${v.scores.buildHealth}`
</script>

<template>
  <div>
    <p class="muted">
      <NuxtLink :to="`/runs/${id}`">← Run</NuxtLink> ·
      <NuxtLink :to="`/runs/${id}/tests`">Tests</NuxtLink> ·
      <NuxtLink :to="`/runs/${id}/plan`">Plan</NuxtLink>
    </p>
    <h1>Critic</h1>
    <p v-if="error" class="callout">{{ error }}</p>
    <div v-for="s in waiting" :key="s.id" class="callout" style="margin-bottom: 14px">
      <b>{{ s.target }}: the critic needs your decision.</b>
      <div class="row" style="margin-top: 8px">
        <input v-model="note" type="text" placeholder="Optional note" style="max-width: 420px" />
        <button class="primary" @click="answer(s.id, 'accept')">
          Accept remaining findings as deviations
        </button>
        <button @click="answer(s.id, 'reject')">Reject and cancel</button>
      </div>
    </div>
    <p v-if="!view.verdicts.length && !error" class="muted">
      No verdicts yet. The critic reviews each target after its tests run.
    </p>
    <div v-for="t in byTarget" :key="t.target" class="panel" style="margin-bottom: 14px">
      <h2>{{ t.target }}</h2>
      <div v-for="v in t.verdicts" :key="v.round" style="margin-bottom: 14px">
        <div class="row">
          <b>Round {{ v.round }}</b>
          <span
            class="badge"
            :class="v.decision === 'pass' ? 'ok' : v.decision === 'fix' ? 'warn' : 'bad'"
            >{{ v.decision }}</span
          >
          <span class="muted">confidence {{ Math.round(v.confidence * 100) }}%</span>
          <span class="muted">{{ score(v) }}</span>
        </div>
        <p>{{ v.summary }}</p>
        <table v-if="v.findings.length">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Category</th>
              <th>Where</th>
              <th>Finding</th>
              <th>Suggested fix</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in v.findings" :key="f.id">
              <td>
                <span
                  class="badge"
                  :class="
                    f.severity === 'blocking' ? 'bad' : f.severity === 'advisory' ? 'warn' : ''
                  "
                  >{{ f.severity }}</span
                >
              </td>
              <td>{{ f.category }}</td>
              <td>
                <code v-if="f.file"
                  >{{ f.file }}<span v-if="f.line">:{{ f.line }}</span></code
                >
                <code v-if="f.behaviorId" class="muted">{{ f.behaviorId }}</code>
              </td>
              <td>
                {{ f.description }}
                <div class="muted" style="font-size: 12px">{{ f.evidence }}</div>
              </td>
              <td class="muted">{{ f.suggestedFix }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">No findings.</p>
      </div>
    </div>
  </div>
</template>
