<script setup lang="ts">
import type { Artifact } from '@mpf/core/schemas'
const id = String(useRoute().params.id)
const api = useApi()
const { view, error, connected } = useRunView(id)
const { isBoard } = useDashboardStyle()
const target = ref('')
const checked = ref<Record<string, boolean>>({})
const storageNotice = ref('')
const key = `mpf.release-checklist.v1.${id}`
onMounted(() => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved))
      checked.value = Object.fromEntries(
        Object.entries(saved).filter(([, v]) => typeof v === 'boolean'),
      )
  } catch {
    storageNotice.value = 'Checklist progress is available for this visit only.'
  }
})
watch(
  checked,
  (value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      storageNotice.value =
        'Your browser couldn’t save the checklist. Changes remain for this visit.'
    }
  },
  { deep: true },
)
watch(
  () => view.value.run?.targets,
  (targets) => {
    if (targets && !targets.includes(target.value as 'web' | 'ios' | 'android'))
      target.value = targets[0] ?? ''
  },
  { immediate: true },
)
const guides: Record<
  string,
  { title: string; url: string; steps: { id: string; title: string; description: string }[] }
> = {
  ios: {
    title: 'App Store checklist',
    url: 'https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app',
    steps: [
      {
        id: 'review',
        title: 'Review the app and its screenshots',
        description:
          'Try the main flows on a physical device and prepare your store description and screenshots.',
      },
      {
        id: 'privacy',
        title: 'Complete your listing and privacy information',
        description:
          'Set up the app in App Store Connect, including age rating, privacy details, support information, and reviewer access.',
      },
      {
        id: 'sign',
        title: 'Create a signed distribution build',
        description:
          'Open the generated iOS project in Xcode, choose your team, and archive for distribution. A simulator build is not a store archive.',
      },
      {
        id: 'submit',
        title: 'Upload and submit for review',
        description:
          'Select the uploaded build in App Store Connect, complete the required information, and submit. Store approval is a separate step.',
      },
    ],
  },
  android: {
    title: 'Google Play checklist',
    url: 'https://support.google.com/googleplay/android-developer/answer/9859348?hl=en-EN',
    steps: [
      {
        id: 'review',
        title: 'Review the app on a device',
        description: 'Try your key flows and check screenshots, text, and permissions.',
      },
      {
        id: 'listing',
        title: 'Prepare the listing and app content',
        description:
          'Complete the store description, screenshots, privacy policy, Data safety, content rating, and any account-specific requirements in Play Console.',
      },
      {
        id: 'sign',
        title: 'Build a signed Android App Bundle',
        description:
          'Configure release signing and version codes in the generated project. A test APK is not the production bundle.',
      },
      {
        id: 'submit',
        title: 'Test the release and submit it',
        description:
          'Upload the bundle to a testing track, meet the testing requirements shown for your account, and follow Play Console’s release review.',
      },
    ],
  },
  web: {
    title: 'Web deployment checklist',
    url: 'https://vercel.com/docs/deployments/overview',
    steps: [
      {
        id: 'review',
        title: 'Review the site in a browser',
        description:
          'Check the important flows, mobile layouts, accessibility, and any known differences.',
      },
      {
        id: 'config',
        title: 'Set up your hosting environment',
        description:
          'Choose your host, configure the build command and output folder, and add the environment variables the app needs.',
      },
      {
        id: 'preview',
        title: 'Deploy a preview and test it',
        description:
          'Follow your host’s deployment steps. Verify links, authentication, API connections, and data storage on the hosted version.',
      },
      {
        id: 'publish',
        title: 'Publish and check the live URL',
        description:
          'Promote the verified preview, connect your domain if needed, and confirm HTTPS and the main user flows.',
      },
    ],
  },
}
const guide = computed(() => guides[target.value])
const steps = computed(() => guide.value?.steps ?? [])
const complete = computed(
  () => steps.value.filter((s) => checked.value[`${target.value}:${s.id}`]).length,
)
const artifacts = computed(() => [
  ...new Map(
    view.value.artifacts
      .filter(
        (a) =>
          a.meta.target === target.value ||
          (!a.meta.target && ['run-report', 'port-readme'].includes(a.kind)),
      )
      .map((a) => [a.relPath, a]),
  ).values(),
])
const build = computed(() =>
  view.value.stages.find((s) => s.kind === 'build' && s.target === target.value),
)
const tests = computed(() => [
  ...new Map(
    view.value.tests.filter((t) => t.target === target.value).map((t) => [t.kind, t]),
  ).values(),
])
const needsReview = computed(() => tests.value.some((t) => t.status !== 'pass'))
const testNames: Record<string, string> = {
  unit: 'Individual functions',
  launch: 'App opens',
  e2e: 'User flows',
  parity: 'Same results',
  screenshot: 'Screens & layout',
  build: 'Build',
  lint: 'Code checks',
}
const artifactNames: Record<string, string> = {
  'android-apk': 'Android test build',
  'ios-app': 'iOS simulator build',
  'web-dist': 'Web build',
  'port-readme': 'Platform release guide',
  'run-report': 'Run report',
  'target-screenshot': 'Screenshot',
}
const releaseFiles = computed(() => artifacts.value.filter((a) => a.kind in artifactNames))
const otherFiles = computed(() => artifacts.value.filter((a) => !(a.kind in artifactNames)))
const report = computed(() => artifacts.value.find((a) => a.kind === 'port-readme'))
const url = (a: Artifact) => `${api.base}/runs/${id}/artifacts/${a.id}/content`
</script>
<template>
  <div>
    <BoardHero
      v-if="isBoard"
      title="Release checklist"
      :description="
        view.run
          ? `Review the build files for ${projectName(view.run.source.locator)} and complete the publishing steps for each platform.`
          : 'Review the build files and complete the publishing steps for each platform.'
      "
      art="release"
    />
    <div v-else class="page-head">
      <h1 class="title">Release checklist</h1>
      <NuxtLink :to="`/runs/${id}`" class="btn">Back to run</NuxtLink>
    </div>
    <p v-if="error" class="callout bad" role="alert">{{ error }}</p>
    <p v-else-if="!view.run" role="status">Loading release information…</p>
    <template v-else>
      <div class="board-toolbar">
        <div class="seg-group" role="group" aria-label="Release platform">
          <button
            v-for="t in view.run.targets"
            :key="t"
            class="seg"
            :class="{ on: target === t }"
            :aria-pressed="target === t"
            @click="target = t"
          >
            {{ boardPlatform[t] }}
          </button>
        </div>
        <StatusLamp :status="view.run.status" :label="boardStatus[view.run.status]" />
      </div>
      <p v-if="view.run.options.fake" class="callout quiet">
        This is a demo run. Its simulated outputs are not a publishable app.
      </p>
      <p v-else-if="view.run.status !== 'succeeded'" class="callout">
        This run is {{ boardStatus[view.run.status]?.toLowerCase() }}. Resolve open issues and
        review the tests before publishing.
      </p>
      <p v-if="needsReview" class="callout">
        Some checks failed, were skipped, or need review. Read the test evidence and documented
        differences before publishing.
      </p>
      <div class="board-columns">
        <section class="board-card">
          <div class="board-toolbar">
            <h2>{{ guide?.title }}</h2>
            <span class="hint">{{ complete }} of {{ steps.length }} manual steps done</span>
          </div>
          <progress
            :value="complete"
            :max="steps.length || 1"
            aria-label="Manual release checklist completion"
          />
          <h3>Build results</h3>
          <ul class="board-check-results">
            <li><StatusLamp :status="build?.status ?? 'pending'" /><span>Platform build</span></li>
            <li>
              <span>{{
                tests.length
                  ? tests.map((t) => `${testNames[t.kind] ?? t.kind}: ${t.status}`).join(' · ')
                  : 'No test results yet'
              }}</span>
            </li>
            <li>
              {{
                report
                  ? 'Platform release guide available'
                  : 'Platform release guide not available yet'
              }}
            </li>
          </ul>
          <NuxtLink :to="`/runs/${id}/tests`" class="inline small"
            >Review test evidence &amp; previews</NuxtLink
          >
          <h3>Publishing steps</h3>
          <label
            v-for="step in steps"
            :key="target + step.id"
            class="board-check board-release-step"
            ><input v-model="checked[`${target}:${step.id}`]" type="checkbox" /><span
              ><strong>{{ step.title }}</strong
              ><span class="hint">{{ step.description }}</span></span
            ></label
          >
          <p class="hint" role="status">
            {{
              storageNotice ||
              'Your checklist is saved in this browser, separately for each run and platform.'
            }}
          </p>
          <p class="hint">
            Checking a step records your progress. Factory does not upload, publish, or verify store
            approval.
          </p>
          <details class="board-details">
            <summary>Official publishing instructions</summary>
            <a v-if="guide" :href="guide.url" target="_blank" rel="noopener" class="inline"
              >{{
                target === 'web'
                  ? 'Example hosting guide: Vercel'
                  : target === 'ios'
                    ? 'Apple App Store Connect guide'
                    : 'Google Play release guide'
              }}
              ↗</a
            >
            <p v-if="target === 'web'" class="hint">
              Use the equivalent steps for your preferred host.
            </p>
          </details>
        </section>
        <aside class="board-aside">
          <section class="board-card">
            <h2>Your release files</h2>
            <p class="hint">
              Outputs recorded for this run. Folder outputs are shown as paths on your computer.
            </p>
            <div v-for="a in releaseFiles" :key="a.id" class="board-artifact">
              <code v-if="a.mime === 'inode/directory'">{{ view.run.runDir }}/{{ a.relPath }}</code
              ><a v-else :href="url(a)" target="_blank" rel="noopener" class="inline"
                >{{ artifactNames[a.kind] || a.relPath }} ↗</a
              ><span class="hint">{{ a.relPath }}</span>
            </div>
            <details v-if="otherFiles.length" class="board-details">
              <summary>Other build outputs ({{ otherFiles.length }})</summary>
              <div v-for="a in otherFiles" :key="a.id" class="board-artifact">
                <code v-if="a.mime === 'inode/directory'"
                  >{{ view.run.runDir }}/{{ a.relPath }}</code
                ><a v-else :href="url(a)" target="_blank" rel="noopener" class="inline"
                  >{{ a.relPath }} ↗</a
                >
              </div>
            </details>
            <p v-if="!artifacts.length" class="hint">
              No release outputs yet. They’ll appear as the build progresses.
            </p>
            <StatusLamp
              :status="connected ? 'ok' : 'warn'"
              :label="connected ? 'Live updates' : 'Reconnecting'"
            />
          </section>
          <section class="board-card">
            <h2>Create another version</h2>
            <p class="hint">
              After changing the original project, start a new run to update the ports.
            </p>
            <NuxtLink :to="`/runs/new?from=${id}`" class="btn"
              >Prepare the next version <UiIcon name="arrow-right"
            /></NuxtLink>
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>
