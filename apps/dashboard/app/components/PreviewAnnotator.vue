<script setup lang="ts">
import type { Artifact, ReviewEntry, ReviewMark } from '@mpf/core/schemas'
const props = defineProps<{
  runId: string
  artifact: Artifact
  feedback?: Extract<ReviewEntry, { kind: 'feedback' }>
  comparison?: { runId: string; artifact: Artifact }
}>()
const emit = defineEmits<{ close: [] }>()
const api = useApi()
const review = useProjectReview()
const dialog = ref<HTMLDialogElement>()
const surface = ref<HTMLDivElement>()
const dimensions = ref({ width: 1000, height: 700 })
const tool = ref<ReviewMark['kind']>('arrow')
const marks = ref<ReviewMark[]>(props.feedback?.marks ?? [])
const undone = ref<ReviewMark[]>([])
const active = ref<ReviewMark>()
const text = ref('')
const busy = ref(false)
const error = ref('')
const saved = ref<string[]>([])
const requestId = ref(crypto.randomUUID())
const url = computed(
  () =>
    `${api.base}/runs/${props.runId}/artifacts/${props.feedback?.snapshotId ?? props.artifact.id}/content`,
)
const allMarks = computed(() => [...marks.value, ...(active.value ? [active.value] : [])])
onMounted(() => dialog.value?.showModal())
function loaded(e: Event) {
  const img = e.target as HTMLImageElement
  dimensions.value = { width: img.naturalWidth, height: img.naturalHeight }
}
function point(e: PointerEvent) {
  const r = surface.value!.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
    y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
  }
}
function start(e: PointerEvent) {
  if (props.feedback || e.button !== 0 || busy.value) return
  dialog.value?.focus()
  surface.value!.setPointerCapture(e.pointerId)
  const p = point(e)
  active.value = { kind: tool.value, points: tool.value === 'pin' ? [p] : [p, p] }
}
function move(e: PointerEvent) {
  if (!active.value) return
  const p = point(e)
  if (active.value.kind === 'pen' && active.value.points.length < 1000) active.value.points.push(p)
  else if (active.value.kind !== 'pin') active.value.points[1] = p
}
function finish(e: PointerEvent) {
  if (!active.value) return
  move(e)
  addMark(active.value)
  active.value = undefined
  if (surface.value?.hasPointerCapture(e.pointerId))
    surface.value.releasePointerCapture(e.pointerId)
}
function addMark(mark: ReviewMark) {
  if (busy.value || props.feedback || marks.value.length >= 40) return
  marks.value = [...marks.value, mark]
  undone.value = []
}
function undo() {
  if (busy.value || props.feedback) return
  if (active.value) {
    active.value = undefined
    return
  }
  const mark = marks.value.at(-1)
  if (!mark) return
  undone.value = [...undone.value, mark]
  marks.value = marks.value.slice(0, -1)
}
function redo() {
  if (busy.value || props.feedback || active.value) return
  const mark = undone.value.at(-1)
  if (!mark) return
  marks.value = [...marks.value, mark]
  undone.value = undone.value.slice(0, -1)
}
function historyKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement
  if (target.closest('input, textarea, select, [contenteditable]')) return
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return
  const key = e.key.toLowerCase()
  if (key !== 'z' && !(e.ctrlKey && key === 'y')) return
  e.preventDefault()
  if (e.shiftKey || key === 'y') redo()
  else undo()
}
function discussExisting() {
  if (props.feedback) review.discuss('tests', 'Let’s discuss this feedback.', [props.feedback.id])
  dialog.value?.close()
}
async function save(discuss = false) {
  if (busy.value || (!text.value.trim() && !saved.value.length)) return
  busy.value = true
  error.value = ''
  try {
    if (text.value.trim()) {
      const result = await api.post<ReviewEntry>(`/runs/${props.runId}/review/feedback`, {
        requestId: requestId.value,
        artifactId: props.artifact.id,
        text: text.value,
        marks: marks.value,
      })
      saved.value.push(result.id)
      text.value = ''
      marks.value = []
      undone.value = []
      requestId.value = crypto.randomUUID()
      await review.refresh()
    }
    if (discuss) {
      review.discuss(
        'tests',
        'Please review these annotations and propose the changes.',
        saved.value,
      )
      dialog.value?.close()
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <dialog
    ref="dialog"
    class="annotation-dialog"
    aria-labelledby="annotation-title"
    tabindex="-1"
    @keydown="historyKey"
    @close="emit('close')"
    @cancel="busy && $event.preventDefault()"
  >
    <header class="review-dialog-head">
      <div>
        <h2 id="annotation-title">{{ feedback ? 'Review feedback' : 'Annotate preview' }}</h2>
        <p>
          {{ artifact.meta.screenId ?? feedback?.screenId }} ·
          {{ artifact.meta.target ?? feedback?.target ?? 'Source' }} · Captured version
          {{ runId.slice(-6) }}
        </p>
      </div>
      <button class="btn" :disabled="busy" @click="dialog?.close()">Close</button>
    </header>
    <div class="annotation-layout">
      <div class="annotation-canvas-area">
        <div v-if="!feedback" class="annotation-toolbar" role="group" aria-label="Annotation tools">
          <button
            v-for="item in ['pin', 'arrow', 'rectangle', 'pen'] as const"
            :key="item"
            class="btn"
            :aria-pressed="tool === item"
            @click="tool = item"
          >
            {{
              item === 'pin'
                ? 'Pin'
                : item === 'arrow'
                  ? 'Arrow'
                  : item === 'rectangle'
                    ? 'Rectangle'
                    : 'Pen'
            }}
          </button>
          <button
            class="btn"
            :disabled="busy || (!marks.length && !active)"
            aria-keyshortcuts="Meta+Z Control+Z"
            @click="undo"
          >
            Undo
          </button>
          <button
            class="btn"
            :disabled="busy || !undone.length || !!active"
            aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z Control+Y"
            @click="redo"
          >
            Redo
          </button>
          <button
            class="btn"
            :disabled="busy || marks.length >= 40"
            @click="addMark({ kind: 'pin', points: [{ x: 0.5, y: 0.5 }] })"
          >
            Pin center
          </button>
        </div>
        <div class="annotation-compare" :class="{ paired: comparison }">
          <div>
            <p v-if="comparison" class="muted">Original feedback</p>
            <div
              ref="surface"
              class="annotation-surface"
              :class="{ drawing: !feedback }"
              @pointerdown="start"
              @pointermove="move"
              @pointerup="finish"
              @pointercancel="active = undefined"
            >
              <img
                :src="url"
                alt="Captured app screen to annotate"
                draggable="false"
                @load="loaded"
                @error="error = 'This screenshot could not be loaded.'"
              />
              <ReviewMarks :marks="allMarks" v-bind="dimensions" />
            </div>
          </div>
          <div v-if="comparison">
            <p class="muted">New version · {{ comparison.artifact.meta.target }}</p>
            <div class="annotation-surface">
              <img
                :src="`${api.base}/runs/${comparison.runId}/artifacts/${comparison.artifact.id}/content`"
                alt="New version of the reviewed screen"
              />
            </div>
          </div>
        </div>
      </div>
      <aside class="annotation-notes">
        <template v-if="feedback"
          ><h3>Your feedback</h3>
          <p class="review-prose">{{ feedback.text }}</p>
          <p class="muted">
            {{ feedback.status === 'resolved' ? 'Resolved' : 'Open' }} · Original screenshot
            retained
          </p>
          <button class="btn primary" @click="discussExisting">Discuss in chat</button></template
        >
        <template v-else>
          <h3>What would you like to change?</h3>
          <p class="muted">
            Draw on the screen, then describe the change. You can also leave a note without drawing.
          </p>
          <label for="annotation-note" class="sr-only">Feedback</label
          ><textarea
            id="annotation-note"
            v-model="text"
            rows="6"
            maxlength="6000"
            placeholder="Move this navigation into a sidebar on desktop."
          />
          <p class="small muted">{{ marks.length }} marks · {{ saved.length }} notes saved</p>
          <button class="btn" :disabled="busy || !text.trim()" @click="save(false)">
            Save note &amp; add another
          </button>
          <button
            class="btn primary"
            :disabled="busy || (!text.trim() && !saved.length)"
            @click="save(true)"
          >
            {{ busy ? 'Saving…' : 'Save & discuss' }}
          </button>
          <p class="small muted">
            Saving feedback doesn’t start a build. Chat will help you review the changes first.
          </p>
        </template>
        <p v-if="error" class="review-error" role="alert">{{ error }}</p>
      </aside>
    </div>
  </dialog>
</template>
