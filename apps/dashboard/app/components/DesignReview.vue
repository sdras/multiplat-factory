<script setup lang="ts">
import type { ReviewEntry } from '@mpf/core/schemas'
const review = useProjectReview()
const dialog = ref<HTMLDialogElement>()
const brief = ref('')
const impeccable = ref<'yes' | 'no' | ''>('')
const target = ref<'web' | 'ios' | 'android'>('web')
const choosing = ref('')
const requestId = ref(crypto.randomUUID())
const reviewTab = useState<'chat' | 'feedback'>('review-tab', () => 'chat')
const entry = computed(() =>
  review.state.value?.entries.find(
    (e): e is Extract<ReviewEntry, { kind: 'design' }> =>
      e.kind === 'design' && e.id === review.designId.value,
  ),
)
const targets = computed(() => review.state.value?.run.targets ?? [])
onMounted(async () => {
  dialog.value?.showModal()
  await review.refresh()
  target.value = targets.value.includes('web') ? 'web' : (targets.value[0] ?? 'web')
})
async function generate() {
  if (!impeccable.value) return
  try {
    await review.generateDesign(
      brief.value.trim() ||
        'Review this app and propose three distinct design directions. Preserve its functionality and adapt the layout to the selected platform.',
      target.value,
      requestId.value,
      impeccable.value === 'yes',
    )
  } catch {
    /* shared error, same request id allows a safe retry */
  }
}
function another() {
  review.designId.value = ''
  requestId.value = crypto.randomUUID()
  impeccable.value = ''
}
async function choose(optionId: string) {
  if (!entry.value) return
  choosing.value = optionId
  try {
    await review.action(`designs/${entry.value.id}/choose`, { optionId })
    review.open.value = true
    reviewTab.value = 'chat'
    dialog.value?.close()
  } catch {
    /* shared error */
  } finally {
    choosing.value = ''
  }
}
function viewProposal() {
  review.open.value = true
  reviewTab.value = 'chat'
  dialog.value?.close()
}
</script>
<template>
  <dialog
    ref="dialog"
    class="design-review-dialog"
    aria-labelledby="design-review-title"
    @close="review.designOpen.value = false"
  >
    <header class="review-dialog-head">
      <div>
        <h2 id="design-review-title">
          {{ entry ? 'Choose a design direction' : 'Design review' }}
        </h2>
        <p>Three small mockups to compare before changing your app.</p>
      </div>
      <button class="btn" @click="dialog?.close()">Close</button>
    </header>
    <div class="design-review-body">
      <p v-if="review.error.value" class="review-error" role="alert">{{ review.error.value }}</p>
      <template v-if="entry">
        <p class="design-review-intro">{{ entry.text }}</p>
        <fieldset
          class="design-skill-choice"
          :disabled="review.sending.value"
          aria-describedby="impeccable-description"
        >
          <legend>Would you like to add Impeccable?</legend>
          <p id="impeccable-description">
            Impeccable is an optional design skill that guides layout, typography, color, and
            accessibility. We’ll add it to Factory’s project files and use it for these mockups and
            the version you build.
          </p>
          <a href="https://impeccable.style" target="_blank" rel="noopener noreferrer"
            >About Impeccable ↗</a
          >
          <label for="impeccable-yes"
            ><input
              id="impeccable-yes"
              v-model="impeccable"
              name="impeccable"
              type="radio"
              value="yes"
              required
            /><span>Yes, add Impeccable</span></label
          >
          <label for="impeccable-no"
            ><input
              id="impeccable-no"
              v-model="impeccable"
              name="impeccable"
              type="radio"
              value="no"
              required
            /><span>No, continue without it</span></label
          >
        </fieldset>
        <p class="small muted">
          {{ entry.target }} · Concept previews, not working screens. Your app is unchanged.
        </p>
        <p v-if="entry.impeccable" class="small muted">
          {{
            entry.impeccableVersion
              ? `Impeccable ${entry.impeccableVersion} added to this review and its selected revision.`
              : 'Impeccable selected for this demo. No skill was downloaded.'
          }}
        </p>
        <div class="design-options">
          <article
            v-for="option in entry.options"
            :key="option.id"
            class="design-option"
            :class="{ selected: entry.selectedOption === option.id }"
          >
            <div class="design-option-title">
              <span>{{ option.id.toUpperCase() }}</span>
              <h3>{{ option.name }}</h3>
            </div>
            <DesignMockup :option="option" :target="entry.target" />
            <p>{{ option.summary }}</p>
            <p class="small muted">{{ option.tradeoff }}</p>
            <button
              v-if="!entry.selectedOption && entry.runId === review.runId.value"
              class="btn primary"
              :disabled="!!choosing || review.sending.value"
              @click="choose(option.id)"
            >
              {{ choosing === option.id ? 'Selecting…' : `Choose ${option.id.toUpperCase()}` }}
            </button>
            <p v-else-if="entry.selectedOption === option.id" class="design-chosen">
              ✓ Selected direction
            </p>
          </article>
        </div>
        <footer class="design-review-footer">
          <p class="muted">
            Choosing a direction prepares a proposal. You’ll review the changes and budget before a
            build starts.
          </p>
          <div class="row">
            <button v-if="entry.selectedOption" class="btn primary" @click="viewProposal">
              View proposal in chat</button
            ><button class="btn" :disabled="review.sending.value" @click="another">
              Explore three more
            </button>
          </div>
        </footer>
      </template>
      <form v-else class="design-review-form" @submit.prevent="generate">
        <h3>Start with three options</h3>
        <p>
          We’ll use your project’s plan and available screenshots to suggest different layouts. Pick
          a favorite, then refine it in chat.
        </p>
        <label for="design-target">Platform</label
        ><select id="design-target" v-model="target" :disabled="review.sending.value">
          <option v-for="platform in targets" :key="platform" :value="platform">
            {{ platform === 'web' ? 'Web' : platform === 'ios' ? 'iOS' : 'Android' }}
          </option>
        </select>
        <label for="design-brief"
          >What should we keep or change? <span class="muted">Optional</span></label
        ><textarea
          id="design-brief"
          v-model="brief"
          rows="4"
          maxlength="6000"
          :disabled="review.sending.value"
          placeholder="Keep the colors and familiar controls. Make better use of desktop space."
        />
        <fieldset
          class="design-skill-choice"
          :disabled="review.sending.value"
          aria-describedby="impeccable-description"
        >
          <legend>Would you like to add Impeccable?</legend>
          <p id="impeccable-description">
            Impeccable is an optional design skill that guides layout, typography, color, and
            accessibility. We’ll add it to Factory’s project files and use it for these mockups and
            the version you build.
          </p>
          <a href="https://impeccable.style" target="_blank" rel="noopener noreferrer"
            >About Impeccable ↗</a
          >
          <label for="impeccable-yes"
            ><input
              id="impeccable-yes"
              v-model="impeccable"
              name="impeccable"
              type="radio"
              value="yes"
              required
            /><span>Yes, add Impeccable</span></label
          >
          <label for="impeccable-no"
            ><input
              id="impeccable-no"
              v-model="impeccable"
              name="impeccable"
              type="radio"
              value="no"
              required
            /><span>No, continue without it</span></label
          >
        </fieldset>
        <p class="small muted">
          {{
            review.state.value?.run.options.fake
              ? 'Demo mode: shows three example task-app layouts. No model calls or skill downloads.'
              : `Uses your configured model and up to ${money(review.state.value?.chatCapUsd ?? 0)} of this version’s budget.`
          }}
        </p>
        <button
          class="btn primary"
          :disabled="
            review.sending.value || review.state.value?.busy || !targets.length || !impeccable
          "
          type="submit"
        >
          {{
            review.sending.value
              ? impeccable === 'yes'
                ? 'Adding Impeccable & preparing directions…'
                : 'Preparing three directions…'
              : 'Create 3 mockups'
          }}
        </button>
        <p v-if="review.sending.value" role="status" class="muted">
          You can close this window. The options will appear in project chat when they’re ready.
        </p>
      </form>
    </div>
  </dialog>
</template>
<style scoped>
.design-review-dialog {
  width: min(1240px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface, #292630);
  color: var(--ink);
  overflow-y: auto;
}
.design-review-dialog::backdrop {
  background: #101018bb;
  backdrop-filter: blur(5px);
}
.design-review-dialog h2 {
  font-size: 21px;
  margin: 0;
}
.design-review-body {
  padding: 24px;
}
.design-review-intro {
  max-width: 850px;
  line-height: 1.55;
  margin-top: 0;
}
.design-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
  margin-top: 24px;
}
.design-option {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.design-option-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  min-height: 45px;
}
.design-option-title > span {
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 50%;
  width: 27px;
  height: 27px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
.design-option h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}
.design-option p {
  line-height: 1.55;
  margin: 16px 0 0;
}
.design-option .small {
  margin: 8px 0 18px;
}
.design-option > .btn {
  margin-top: auto;
}
.design-chosen {
  font-weight: 600;
}
.selected .design-option-title > span {
  background: var(--accent, #c9b4e2);
  color: #24202b;
}
.design-review-footer {
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 24px;
  justify-content: space-between;
}
.design-review-footer p {
  max-width: 530px;
  font-size: 12px;
  line-height: 1.6;
}
.design-review-footer .row {
  flex-wrap: wrap;
}
.design-review-form {
  max-width: 570px;
  margin: 0 auto;
  padding: 12px 0 24px;
}
.design-review-form h3 {
  font-size: 22px;
}
.design-review-form p {
  line-height: 1.6;
}
.design-review-form label {
  display: block;
  margin: 20px 0 8px;
  font-size: 13px;
}
.design-review-form select,
.design-review-form textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  color: var(--ink);
  background: var(--bg, #242129);
  border: 1px solid var(--border);
  border-radius: 8px;
  font: inherit;
}
.design-review-form select {
  height: auto;
  min-height: 44px;
}
.design-review-form .btn {
  margin-top: 10px;
}
.design-skill-choice {
  margin: 24px 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.design-skill-choice legend {
  font-weight: 600;
  padding: 0 6px;
  font-size: 14px;
}
.design-skill-choice p,
.design-skill-choice a {
  font-size: 12px;
}
.design-review-form .design-skill-choice label {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0 0;
  min-height: 28px;
  cursor: pointer;
}
.design-skill-choice input {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}
@media (max-width: 850px) {
  .design-options {
    grid-template-columns: 1fr;
    gap: 32px;
    max-width: 480px;
    margin-inline: auto;
  }
  .design-review-footer {
    flex-direction: column;
    align-items: flex-start;
  }
  .design-review-dialog {
    max-height: calc(100dvh - 20px);
  }
  .design-review-body {
    padding: 18px;
  }
}
</style>
