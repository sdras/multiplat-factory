/**
 * Release the `multiplat-factory` CLI. The flow is: bump the version in `apps/cli/package.json`,
 * add that version's section to `CHANGELOG.md`, then run this script.
 *
 *   pnpm tsx scripts/release.ts             # build + pack into dist-release/, print the tarball contents
 *   pnpm release                            # the same, then `npm publish` the packed tarball
 *
 * Only the packed tarball is ever published, so this cannot publish the monorepo root by
 * accident. The publish step runs with the terminal attached, so npm can ask for a two-factor
 * code.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@mpf/harness'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'apps', 'cli')
const out = join(root, 'dist-release')
const publish = process.argv.includes('--publish')

const { name, version } = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')) as {
  name: string
  version: string
}

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const section = changelog.split(/^## /m).find((s) => s.startsWith(`[${version}]`))
if (!section) {
  console.error(
    `CHANGELOG.md has no "## [${version}]" section. Add one for ${name}@${version} before releasing.`,
  )
  process.exit(1)
}
console.log(`releasing ${name}@${version}\n\n## ${section.trim()}`)

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
const tarballPath = join(out, tarball)
console.log(`\ntarball: ${tarballPath} (${(statSync(tarballPath).size / 1024).toFixed(0)} KiB)`)
await step('contents', 'tar', ['tzf', tarballPath])

if (publish) {
  // The terminal stays attached here so npm can prompt for a one-time password.
  console.log(`\n> publish: npm publish ${tarballPath} --access public`)
  const r = spawnSync('npm', ['publish', tarballPath, '--access', 'public'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error(`publish failed (exit ${r.status})`)
    process.exit(1)
  }
  console.log(`\npublished ${name}@${version}. Check with: npm view ${name} version`)
} else {
  console.log(
    `\nnot publishing (run \`pnpm release\`); try the tarball with: npm i -g ${tarballPath}`,
  )
}
