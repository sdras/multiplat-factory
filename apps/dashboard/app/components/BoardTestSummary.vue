<script setup lang="ts">
import type { RunView } from '@mpf/core/reducer'
const props = defineProps<{ view: RunView }>()
const kinds = [
  ['build', 'Builds successfully'],
  ['unit', 'Individual functions'],
  ['launch', 'App opens'],
  ['e2e', 'Complete user flows'],
  ['parity', 'Same inputs, same results'],
  ['screenshot', 'Screens & layout'],
] as const
const columns = computed(() => ['source', ...(props.view.run?.targets ?? [])])
function result(target: string, kind: string) {
  const test = [...props.view.tests].reverse().find((t) => t.target === target && t.kind === kind)
  if (test)
    return {
      status: test.status,
      text:
        test.status === 'skip'
          ? 'Not checked'
          : `${test.status === 'pass' ? 'Passed' : 'Needs review'} · ${test.summary.passed} / ${test.summary.total}`,
      hint: test.skipReason,
    }
  if (kind === 'build' && target !== 'source') {
    const build = props.view.stages.find((s) => s.kind === 'build' && s.target === target)
    if (build)
      return {
        status: build.status,
        text:
          build.status === 'succeeded'
            ? 'Passed'
            : build.status === 'running'
              ? 'Building'
              : build.status === 'failed'
                ? 'Failed'
                : 'Not completed',
        hint: build.error?.message,
      }
  }
  return {
    status: 'pending',
    text: target === 'source' ? 'Reference' : 'Not checked',
    hint: undefined,
  }
}
const issueCount = computed(
  () =>
    [...new Map(props.view.tests.map((t) => [`${t.target}:${t.kind}`, t])).values()].filter((t) =>
      ['fail', 'flaky', 'error'].includes(t.status),
    ).length,
)
</script>
<template>
  <section class="board-card board-tests-summary">
    <div class="board-toolbar">
      <h2>Test results</h2>
      <span class="hint">{{
        issueCount
          ? `${issueCount} ${issueCount === 1 ? 'check needs' : 'checks need'} review`
          : view.tests.length
            ? 'Review the recorded coverage below'
            : 'Waiting for test results'
      }}</span>
    </div>
    <div class="board-table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">What we check</th>
            <th v-for="target in columns" :key="target" scope="col">{{ boardPlatform[target] }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="[kind, label] in kinds" :key="kind">
            <th scope="row">{{ label }}</th>
            <td v-for="target in columns" :key="target">
              <span class="row" style="gap: 8px"
                ><StatusLamp
                  v-if="result(target, kind).status !== 'pending'"
                  :status="result(target, kind).status"
                  :label="result(target, kind).text"
                /><span v-else class="hint">{{ result(target, kind).text }}</span></span
              >
              <details v-if="result(target, kind).hint" class="board-test-note">
                <summary>Details</summary>
                <p class="hint">{{ result(target, kind).hint }}</p>
              </details>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="hint">
      “Not checked” means there’s no recorded result. Build completion does not imply every behavior
      passed.
    </p>
  </section>
</template>
