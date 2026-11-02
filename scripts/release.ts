/**
 * Build the publishable CLI: static dashboard, bundled bin, dashboard copied next to it, then
 * `npm pack` for inspection. Publishing is a separate, explicit step.
 *
 *   pnpm tsx scripts/release.ts             # build + pack into dist-release/, print the tarball contents
 *   pnpm tsx scripts/release.ts --publish   # also `pnpm publish` (needs npm login)
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@mpf/harness'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'apps', 'cli')
const out = join(root, 'dist-release')
const publish = process.argv.includes('--publish')

async function step(title: string, command: string, args: string[], cwd = root): Promise<void> {
  console.log(`\n> ${title}: ${command} ${args.join(' ')}`)
  const r = await runProcess({
    command,
    args,
    cwd,
    env: process.env,
    timeoutMs: 20 * 60_000,
    onStdout: (c) => process.stdout.write(c),
    onStderr: (c) => process.stderr.write(c),
  })
  if (r.exitCode !== 0) {
    console.error(`${title} failed (exit ${r.exitCode})`)
    process.exit(1)
  }
}

await step('dashboard', 'pnpm', ['--filter', '@mpf/dashboard', 'build'])
await step('cli bundle', 'pnpm', ['--filter', './apps/cli', 'build'])
await step('smoke', 'node', [join(cli, 'dist', 'main.js'), '--help'])
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
await step('pack', 'pnpm', ['pack', '--pack-destination', out], cli)
const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'))
if (!tarball || !existsSync(join(out, tarball))) {
  console.error('no tarball produced')
  process.exit(1)
}
console.log(
  `\ntarball: ${join(out, tarball)} (${(statSync(join(out, tarball)).size / 1024).toFixed(0)} KiB)`,
)
await step('contents', 'tar', ['tzf', join(out, tarball)])
if (publish)
  await step('publish', 'pnpm', ['publish', '--access', 'public', '--no-git-checks'], cli)
else
  console.log(
    '\nnot publishing (pass --publish); try the tarball with: npm i -g ' + join(out, tarball),
  )
