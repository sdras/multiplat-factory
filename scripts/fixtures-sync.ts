/**
 * Sync the public fixture matrix into fixtures/.cache and pin commits in fixtures/manifest.json.
 *
 *   pnpm fixtures:sync            # clone or update everything, pin any unpinned entries
 *   pnpm fixtures:sync --id todomvc-vue
 *   pnpm fixtures:sync --repin    # move pins to the current tip of each ref
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@mpf/harness'

interface Fixture {
  id: string
  url: string
  ref: string
  subdir?: string
  platform: string
  license: string
  pin?: string
  expect?: Record<string, string>
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'fixtures', 'manifest.json')
const cache = join(root, 'fixtures', '.cache')
const args = process.argv.slice(2)
const only = args.includes('--id') ? args[args.indexOf('--id') + 1] : undefined
const repin = args.includes('--repin')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  fixtures: Fixture[]
  [k: string]: unknown
}
mkdirSync(cache, { recursive: true })

for (const f of manifest.fixtures) {
  if (only && f.id !== only) continue
  const dir = join(cache, f.id)
  if (!existsSync(dir)) {
    console.log(`clone ${f.id} (${f.url} @ ${f.ref})`)
    const r = await runProcess({
      command: 'git',
      args: ['clone', '--quiet', '--branch', f.ref, '--depth', '1', f.url, dir],
      timeoutMs: 600_000,
    })
    if (r.exitCode !== 0) {
      console.error(`  failed: ${r.stderr.trim()}`)
      continue
    }
  } else if (repin) {
    console.log(`update ${f.id}`)
    await runProcess({
      command: 'git',
      args: ['fetch', '--quiet', '--depth', '1', 'origin', f.ref],
      cwd: dir,
      timeoutMs: 600_000,
    })
    await runProcess({
      command: 'git',
      args: ['checkout', '--quiet', 'FETCH_HEAD'],
      cwd: dir,
      timeoutMs: 60_000,
    })
  }
  if (f.pin && !repin) {
    const at = await runProcess({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: dir,
      timeoutMs: 10_000,
    })
    if (at.stdout.trim() !== f.pin) {
      await runProcess({
        command: 'git',
        args: ['fetch', '--quiet', '--depth', '1', 'origin', f.pin],
        cwd: dir,
        timeoutMs: 600_000,
      })
      await runProcess({
        command: 'git',
        args: ['checkout', '--quiet', f.pin],
        cwd: dir,
        timeoutMs: 60_000,
      })
    }
  } else {
    const head = await runProcess({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: dir,
      timeoutMs: 10_000,
    })
    if (head.exitCode === 0) {
      f.pin = head.stdout.trim()
      console.log(`  pinned ${f.id} at ${f.pin.slice(0, 12)}`)
    }
  }
  console.log(`  ${f.id}: ${join(dir, f.subdir ?? '')}`)
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log('manifest updated')
