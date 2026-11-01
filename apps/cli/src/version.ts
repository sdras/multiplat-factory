import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The CLI's version, read from apps/cli/package.json so a release bumps one number. That file
 * sits one level above both src/main.ts and the bundled dist/main.js, and npm always ships it.
 */
export function cliVersion(): string {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
