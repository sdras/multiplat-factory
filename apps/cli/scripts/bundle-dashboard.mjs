// Copy the static dashboard build next to the bundled CLI so `mpf serve` finds it as dist/dashboard.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', '..', 'dashboard', '.output', 'public')
const target = join(here, '..', 'dist', 'dashboard')

if (!existsSync(join(source, 'index.html'))) {
  console.error(
    `dashboard build not found at ${source}; run \`pnpm --filter @mpf/dashboard build\` first`,
  )
  process.exit(1)
}
rmSync(target, { recursive: true, force: true })
cpSync(source, target, { recursive: true })
console.log(`dashboard bundled into ${target}`)
