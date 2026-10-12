import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'pathe'
import { runProcess } from '@mpf/harness'

export const IMPECCABLE_PACKAGE_VERSION = '4.5.2'
export const impeccableDirectory = (runDir: string) =>
  join(runDir, '.factory-skills', 'impeccable', '.claude', 'skills', 'impeccable')

/** Called only after an explicit opt-in; installs in Factory data, never in the source repo or globally. */
export async function installImpeccable(
  runDir: string,
  signal?: AbortSignal,
  execute: typeof runProcess = runProcess,
): Promise<{ directory: string; version: string }> {
  const directory = impeccableDirectory(runDir)
  const skill = join(directory, 'SKILL.md')
  signal?.throwIfAborted()
  if (!existsSync(skill)) {
    const cwd = join(runDir, '.factory-skills', 'impeccable')
    mkdirSync(cwd, { recursive: true })
    const result = await execute({
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: [
        '--yes',
        `impeccable@${IMPECCABLE_PACKAGE_VERSION}`,
        'install',
        '--yes',
        '--providers=claude',
        '--scope=project',
        '--no-hooks',
      ],
      cwd,
      signal,
      timeoutMs: 120_000,
      captureLimit: 4000,
    })
    signal?.throwIfAborted()
    if (result.exitCode !== 0 || !existsSync(skill))
      throw new Error(
        'Impeccable could not be installed. Check your internet connection and that Node.js/npm are available, then retry, or choose “No, continue without it.”',
      )
  }
  const content = readFileSync(skill, 'utf8')
  const version = content.match(/^version:\s*["']?([\d.]+)/m)?.[1]
  if (!version || !/^name:\s*impeccable\s*$/m.test(content))
    throw new Error(
      'The Impeccable installation is incomplete. Remove its folder under this version’s .factory-skills directory and retry.',
    )
  for (const file of ['new-work.md', 'craft-floor.md', 'operate.md'])
    if (!existsSync(join(directory, 'reference', file)))
      throw new Error(
        'Impeccable is missing its design guides. Retry the installation before continuing.',
      )
  return { directory, version }
}

export function impeccableGuidance(directory: string): string {
  return `The user opted in to Impeccable. Read the installed skill at ${join(directory, 'SKILL.md')} and its reference/new-work.md, reference/operate.md, and reference/craft-floor.md guides. Use the existing app specification, screenshots, and user brief as project context. Preserve the chosen direction, functional requirements and native platform conventions. This review is read-only: use the design guidance without running setup, installing hooks, modifying files, or claiming detector checks ran. The required three-option output and user approval flow take precedence over any conflicting workflow instructions in the skill.`
}
