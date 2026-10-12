<script setup lang="ts">
const props = defineProps<{ folder?: string; ready: boolean; demo: boolean }>()
const review = useProjectReview()
const notice = ref('')
async function copyFolder() {
  if (!props.folder) return
  try {
    await navigator.clipboard.writeText(props.folder)
    notice.value = 'Folder path copied. Paste it into your file manager to open it.'
  } catch {
    notice.value = 'Could not copy automatically. Select and copy the folder path below.'
  }
}
function help() {
  review.discuss(
    'release',
    'Help me set up this web release on Netlify. Walk me through account setup, choosing the correct build folder, any API or environment settings, and updating the same site for future releases. Start by checking what is ready and asking where I need help.',
  )
  review.context.value = { ...review.context.value, target: 'web' }
}
</script>

<template>
  <section class="board-card netlify-setup" aria-labelledby="netlify-title">
    <h2 id="netlify-title">Host on Netlify</h2>
    <p>
      Netlify gives your web app a link people can visit. Sign in, upload your build, then check the
      live site.
    </p>
    <p v-if="demo" class="callout quiet">
      This demo has no app to upload. These steps will be available for a real web build.
    </p>
    <p v-else-if="!ready" class="callout">
      Your web build is not ready to upload yet. You can set up your Netlify account while it
      finishes.
    </p>
    <ol>
      <li>
        <strong>Set up your account</strong>
        <p>Sign in to Netlify or create an account. Choose the team that should own this app.</p>
        <a href="https://app.netlify.com/" target="_blank" rel="noopener" class="btn"
          >Open Netlify ↗</a
        >
      </li>
      <li>
        <strong>Upload your web build</strong>
        <p>
          In Netlify, choose to add a project manually and drop in the folder below. Uploading
          publishes it at a Netlify address.
        </p>
        <template v-if="ready && folder && !demo">
          <code class="netlify-folder">{{ folder }}</code>
          <button class="btn" type="button" @click="copyFolder">Copy folder path</button>
          <a href="https://app.netlify.com/drop" target="_blank" rel="noopener" class="btn"
            >Open upload page ↗</a
          >
        </template>
        <p v-else class="hint">The folder path will appear here after a successful web build.</p>
        <p class="hint">
          Use the finished build folder containing index.html. Review the tests and any known
          differences before uploading.
        </p>
      </li>
      <li>
        <strong>Check your live app</strong>
        <p>
          Open the address Netlify provides. Try signing in, saving data, and opening links on a
          phone. You can add your own domain in Netlify’s domain settings.
        </p>
      </li>
    </ol>
    <p v-if="notice" role="status" class="hint">{{ notice }}</p>
    <button type="button" class="btn" @click="help">Help me set this up</button>
    <details class="board-details">
      <summary>Publishing your next version</summary>
      <p>
        Prepare and review a new version in Factory. Open your existing project in Netlify, go to
        Deploys, and upload the new build folder there. This keeps the same site address and domain.
      </p>
      <p>
        Netlify keeps previous deployments so you can restore a working version if needed. Avoid
        creating a new Netlify project for every release.
      </p>
    </details>
    <details class="board-details">
      <summary>Test a draft before publishing</summary>
      <p>
        A draft has a separate URL and leaves the live site unchanged. It is shareable; do not
        assume it is private.
      </p>
      <p>
        In a terminal, open the generated web project (the parent of the build folder), then run:
      </p>
      <pre><code>npm install -g netlify-cli
netlify login
netlify deploy --dir=dist --no-build</code></pre>
      <p>
        Follow the prompts to create a Netlify project or select an existing one. Test the draft
        URL. When it is ready to go live, run:
      </p>
      <pre><code>netlify deploy --dir=dist --no-build --prod</code></pre>
      <p>
        For a new Factory version in a different folder, run <code>netlify link</code> there first
        and choose the same Netlify project.
      </p>
      <a
        href="https://cli.netlify.com/commands/deploy/"
        target="_blank"
        rel="noopener"
        class="inline"
        >Netlify deployment commands ↗</a
      >
    </details>
    <details class="board-details">
      <summary>Git, build settings, and connected services</summary>
      <p>
        For automatic deployments, push the generated web project to your Git provider and import
        that repository in Netlify. Set the base directory to the generated web project, build
        command to <code>npm run build</code>, and publish directory to <code>dist</code>. New
        Factory web projects include these settings in <code>netlify.toml</code>.
      </p>
      <p>
        Review automatic publishing settings before pushing changes. Git deployments build your
        code; manual uploads use files that are already built.
      </p>
      <p>
        If the app uses a separate API, database, or sign-in service, keep that service running and
        allow your Netlify URLs in its settings. A static upload does not create those services.
      </p>
      <p>
        Add required build variables in Netlify for Git builds. For local builds, configure them
        locally and rebuild before uploading. Browser-facing values are public; keep private keys on
        the server and out of chat.
      </p>
      <a
        href="https://docs.netlify.com/manage/projects/add-new-project/"
        target="_blank"
        rel="noopener"
        class="inline"
        >Netlify setup guide ↗</a
      >
    </details>
    <p class="hint">
      Factory saves your checklist. Uploads and hosting status are managed in Netlify.
    </p>
  </section>
</template>

<style scoped>
.netlify-setup p {
  line-height: 1.6;
}
.netlify-setup ol {
  padding-inline-start: 1.4rem;
}
.netlify-setup li {
  padding-inline-start: 0.3rem;
  margin-block: 1.4rem;
}
.netlify-setup li p {
  margin-block: 0.5rem;
}
.netlify-folder {
  display: block;
  overflow-wrap: anywhere;
  margin-block: 0.75rem;
}
.netlify-setup .btn {
  margin-block: 0.25rem;
  margin-inline-end: 0.4rem;
}
.netlify-setup pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 0.8rem;
}
</style>
