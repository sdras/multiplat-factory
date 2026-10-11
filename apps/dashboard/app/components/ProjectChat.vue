<script setup lang="ts">
import type { Artifact, ReviewEntry } from '@mpf/core/schemas'
const review = useProjectReview()
const { open, state, error, context, draft, sending } = review
const api = useApi()
const agentActivity = useState('webmcp-activity', () => '')
const tab = useState<'chat' | 'feedback'>('review-tab', () => 'chat')
const budget = ref(15)
const chatBudget = ref(30)
watch(
  () => state.value?.run.options.budgetUsd,
  (value) => {
    if (value) chatBudget.value = value
  },
)
const applying = ref('')
const composer = ref<HTMLTextAreaElement>()
const transcript = ref<HTMLDivElement>()
const selected = ref<{
  artifact: Artifact
  feedback: Extract<ReviewEntry, { kind: 'feedback' }>
  comparison?: { runId: string; artifact: Artifact }
}>()
const messages = computed(
  () =>
    state.value?.entries.filter(
      (e) => e.kind === 'message' || e.kind === 'proposal' || e.kind === 'design',
    ) ?? [],
)
const feedback = computed(
  () =>
    state.value?.entries.filter(
      (e): e is Extract<ReviewEntry, { kind: 'feedback' }> => e.kind === 'feedback',
    ) ?? [],
)
const direction = ref('adapt')
const directionNotes = ref('')
watch(
  () => JSON.stringify(state.value?.entries.findLast((e) => e.kind === 'direction') ?? null),
  (raw) => {
    const value = JSON.parse(raw)
    direction.value = value?.value ?? 'adapt'
    directionNotes.value = value?.notes ?? ''
  },
)
watch(open, async (value) => {
  if (value) {
    await nextTick()
    composer.value?.focus()
  } else {
    await nextTick()
    document.querySelector<HTMLButtonElement>('[aria-controls="project-chat"]')?.focus()
  }
})
watch(
  () => messages.value.length,
  async () => {
    await nextTick()
    if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight
  },
)
async function apply(id: string) {
  applying.value = id
  try {
    const result = await review.action<{ runId: string }>(`proposals/${id}/apply`, {
      confirmed: true,
      budgetUsd: budget.value,
    })
    await navigateTo(`/runs/${result.runId}`)
  } catch {
    /* shared error */
  } finally {
    applying.value = ''
  }
}
function discussFeedback(id: string) {
  review.discuss('tests', 'Please review this feedback and propose the changes.', [id])
  tab.value = 'chat'
}
async function inspect(entry: Extract<ReviewEntry, { kind: 'feedback' }>) {
  try {
    const snap = await api.get<{ artifacts: Artifact[] }>(`/runs/${entry.runId}`)
    const artifact = snap.artifacts.find((a) => a.id === entry.snapshotId)
    let comparison: { runId: string; artifact: Artifact } | undefined
    if (entry.runId !== review.runId.value) {
      const current = await api.get<{ artifacts: Artifact[] }>(`/runs/${review.runId.value}`)
      const updated = current.artifacts.findLast(
        (a) =>
          a.kind === 'target-screenshot' &&
          a.meta.screenId === entry.screenId &&
          (a.meta.target === entry.target || entry.target === 'source'),
      )
      if (updated) comparison = { runId: review.runId.value, artifact: updated }
    }
    if (artifact) selected.value = { artifact, feedback: entry, comparison }
  } catch (e) {
    error.value = (e as Error).message
  }
}
async function answer(choice: string) {
  try {
    await review.action('answer', { choice, confirmed: true })
  } catch {
    /* shared error */
  }
}
async function dismiss(id: string) {
  try {
    await review.action(`proposals/${id}/dismiss`)
  } catch {
    /* shared error */
  }
}
async function resolve(entry: Extract<ReviewEntry, { kind: 'feedback' }>) {
  try {
    await review.action(`feedback/${entry.id}`, { resolved: entry.status !== 'resolved' })
  } catch {
    /* shared error */
  }
}
async function saveBudget() {
  try {
    await review.action('budget', { budgetUsd: chatBudget.value })
  } catch {
    /* shared error */
  }
}
async function saveDirection() {
  try {
    await review.action('direction', { value: direction.value, notes: directionNotes.value })
  } catch {
    /* shared error */
  }
}
</script>
<template>
  <aside
    v-if="open"
    id="project-chat"
    class="project-chat"
    aria-labelledby="project-chat-title"
    @keydown.esc="open = false"
  >
    <header class="project-chat-head">
      <div>
        <h2 id="project-chat-title">Project chat</h2>
        <p>
          Version {{ review.runId.value.slice(-6) }} ·
          {{ context.page === 'project' ? 'Build progress' : context.page }}
        </p>
      </div>
      <button class="btn" aria-label="Close project chat" @click="open = false">×</button>
    </header>
    <div class="review-tabs" role="group" aria-label="Chat and feedback">
      <button :aria-pressed="tab === 'chat'" @click="tab = 'chat'">Conversation</button
      ><button :aria-pressed="tab === 'feedback'" @click="tab = 'feedback'">
        Feedback <span>{{ feedback.filter((f) => f.status === 'open').length }}</span>
      </button>
    </div>
    <div class="review-design-launch">
      <button class="btn" :disabled="sending" @click="review.showDesign()">
        Design review · 3 directions
      </button>
    </div>
    <p v-if="agentActivity" class="small muted" role="status" style="padding: 8px 20px">
      {{ agentActivity }}
    </p>
    <p v-if="error" class="review-error" role="alert">
      {{ error }} <button class="btn" @click="review.refresh">Retry</button>
    </p>
    <template v-if="tab === 'chat'">
      <div
        ref="transcript"
        class="review-transcript"
        role="log"
        aria-label="Project conversation"
        aria-live="polite"
        :aria-busy="sending"
      >
        <div v-if="!messages.length" class="review-empty">
          <h3>What would you like to work on?</h3>
          <p>
            Ask about the plan, work through an issue, or describe a change. Your conversation stays
            with this project.
          </p>
          <button class="btn" @click="draft = 'Explain the plan and any decisions I need to make.'">
            Explain the plan</button
          ><button
            class="btn"
            @click="draft = 'What needs my attention, and what do you recommend?'"
          >
            Help me decide
          </button>
        </div>
        <div v-if="state?.pending" class="review-attention">
          <h3>Needs your attention</h3>
          <p>{{ state.pending.reason }}</p>
          <button class="btn" @click="draft = 'Explain this issue and recommend what I should do.'">
            Discuss this</button
          ><button
            v-for="choice in state.pending.choices.filter((c) => c.id !== 'reject')"
            :key="choice.id"
            class="btn"
            :disabled="sending"
            @click="answer(choice.id)"
          >
            {{ choice.label }}
          </button>
        </div>
        <template v-for="entry in messages" :key="entry.id">
          <article v-if="entry.kind === 'message'" class="review-message" :class="entry.role">
            <span class="review-speaker"
              >{{
                entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Factory' : 'Update'
              }}
              <span v-if="entry.runId !== review.runId.value"
                >· Version {{ entry.runId.slice(-6) }}</span
              ></span
            >
            <p class="review-prose">{{ entry.text }}</p>
            <small v-if="entry.costUsd">{{ money(entry.costUsd) }}</small>
          </article>
          <article v-else-if="entry.kind === 'design'" class="review-proposal">
            <h3>
              {{ entry.selectedOption ? 'Selected design direction' : 'Choose a design direction' }}
            </h3>
            <p>{{ entry.text }}</p>
            <div class="design-thumbnails">
              <button
                v-for="option in entry.options"
                :key="option.id"
                class="design-thumbnail"
                :aria-label="`View option ${option.id.toUpperCase()}: ${option.name}`"
                @click="review.showDesign(entry.id)"
              >
                <DesignMockup :option="option" :target="entry.target" />
                <span
                  >{{ option.id.toUpperCase()
                  }}{{ entry.selectedOption === option.id ? ' · Selected' : '' }}</span
                >
              </button>
            </div>
            <button class="btn" @click="review.showDesign(entry.id)">
              Compare the three options
            </button>
          </article>
          <article v-else-if="entry.kind === 'proposal'" class="review-proposal">
            <h3>{{ entry.proposal.title }}</h3>
            <p>
              {{ entry.proposal.targets.join(', ') }} ·
              {{ entry.proposal.kind === 'plan' ? 'Revise plan' : 'Rebuild & test' }}
            </p>
            <p class="review-prose">{{ entry.proposal.instructions }}</p>
            <template v-if="entry.status === 'proposed'"
              ><p class="small muted">
                Creates a new version from the captured source. The current version stays available.
                {{
                  entry.proposal.kind === 'plan'
                    ? 'The revised plan will wait for approval.'
                    : 'The selected platforms will be regenerated and checked.'
                }}
              </p>
              <label class="review-budget"
                >New version budget
                <span
                  >$
                  <input
                    v-model.number="budget"
                    type="number"
                    min="0.1"
                    max="100"
                    step="0.1" /></span
              ></label>
              <div class="row">
                <button
                  class="btn primary"
                  :disabled="!!applying || sending || !(budget > 0 && budget <= 100)"
                  @click="apply(entry.id)"
                >
                  {{ applying === entry.id ? 'Starting…' : 'Apply changes' }}</button
                ><button class="btn" :disabled="!!applying" @click="dismiss(entry.id)">
                  Dismiss
                </button>
              </div></template
            ><NuxtLink v-else-if="entry.revisionRunId" :to="`/runs/${entry.revisionRunId}`"
              >View new version →</NuxtLink
            >
            <p v-else class="muted">Dismissed</p>
          </article>
        </template>
        <p v-if="sending || state?.busy" role="status" class="muted">Reviewing your project…</p>
      </div>
      <form class="review-composer" @submit.prevent="review.send">
        <p v-if="context.feedbackIds.length" class="review-context-chip">
          {{ context.feedbackIds.length }} annotated notes attached
          <button
            type="button"
            aria-label="Remove attached feedback"
            @click="context.feedbackIds = []"
          >
            ×
          </button>
        </p>
        <label for="project-message" class="sr-only">Message about your project</label
        ><textarea
          id="project-message"
          ref="composer"
          v-model="draft"
          rows="3"
          maxlength="12000"
          placeholder="Ask a question or describe a change…"
          @keydown.meta.enter.prevent="review.send"
          @keydown.ctrl.enter.prevent="review.send"
        />
        <div class="review-compose-footer">
          <details>
            <summary>Model &amp; usage</summary>
            <p>
              {{ state?.run.options.models.cheap }}<br />Uses your existing Claude connection.<br />{{
                money(state?.run.costUsd ?? 0)
              }}
              used of {{ money(state?.run.options.budgetUsd ?? 0) }}.<br />Up to
              {{ money(state?.chatCapUsd ?? 0) }} per reply, included in this version’s budget.
            </p>
            <label class="review-budget"
              >Total budget
              <input v-model.number="chatBudget" type="number" min="1" max="100" /></label
            ><button class="btn" type="button" @click="saveBudget">Update budget</button>
          </details>
          <button
            class="btn primary"
            :disabled="sending || state?.busy || !draft.trim() || !state"
            type="submit"
          >
            {{ sending ? 'Replying…' : 'Send' }}
          </button>
        </div>
      </form>
    </template>
    <div v-else class="review-transcript">
      <details class="review-direction">
        <summary>Visual direction</summary>
        <label for="visual-direction">How should the port look?</label
        ><select id="visual-direction" v-model="direction">
          <option value="adapt">Adapt to the platform</option>
          <option value="match">Match the original closely</option>
          <option value="explore">Explore a new direction</option></select
        ><label for="direction-notes">Guidance for future revisions</label
        ><textarea
          id="direction-notes"
          v-model="directionNotes"
          rows="3"
          maxlength="6000"
          placeholder="Keep the colors, but use a wider desktop layout."
        /><button class="btn" @click="saveDirection">Save direction</button>
      </details>
      <p v-if="!feedback.length" class="review-empty">
        Open Tests &amp; previews and choose “Annotate” on a screen to leave feedback.
      </p>
      <article
        v-for="(entry, index) in feedback"
        :key="entry.id"
        class="review-feedback"
        :class="{ resolved: entry.status === 'resolved' }"
      >
        <div class="row">
          <b>{{ index + 1 }} · {{ entry.screenId }}</b
          ><span class="muted">{{ entry.target }} · {{ entry.status }}</span>
        </div>
        <p class="review-prose">{{ entry.text }}</p>
        <small class="muted"
          >Version {{ entry.runId.slice(-6) }} · {{ entry.marks.length }} marks</small
        >
        <div class="row">
          <button class="btn" @click="inspect(entry)">View annotation</button
          ><button class="btn" @click="discussFeedback(entry.id)">Discuss</button
          ><button class="btn" @click="resolve(entry)">
            {{ entry.status === 'resolved' ? 'Reopen' : 'Resolve' }}
          </button>
        </div>
      </article>
    </div>
    <PreviewAnnotator
      v-if="selected"
      :run-id="selected.feedback.runId"
      :artifact="selected.artifact"
      :feedback="selected.feedback"
      :comparison="selected.comparison"
      @close="selected = undefined"
    />
  </aside>
</template>
