import { createInterface } from 'node:readline/promises'
import { defineCommand } from 'citty'
import type { ToolchainCheck } from '@mpf/core'
import { runDoctor, runProcess, which } from '@mpf/harness'
import { config, log } from './shared.ts'

type Manager = 'brew' | 'apt' | 'winget'

async function detectManager(): Promise<Manager | undefined> {
  if (process.platform === 'darwin' && (await which('brew'))) return 'brew'
  if (process.platform === 'linux') {
    if (await which('apt-get')) return 'apt'
    if (await which('brew')) return 'brew'
  }
  if (process.platform === 'win32' && (await which('winget'))) return 'winget'
  return undefined
}

function commandFor(
  check: ToolchainCheck,
  manager: Manager | undefined,
): { command?: string; manual?: string } {
  const fix = check.fix ?? {}
  const command = manager ? fix[manager] : undefined
  return { command, manual: fix.manual }
}

/**
 * Install what `doctor` reports as missing, one item at a time, with a confirmation per
 * command. Nothing runs with sudo unless the user confirms that exact command; `--yes`
 * accepts every command without sudo and prints the rest for the user to run by hand.
 */
export const setupCommand = defineCommand({
  meta: {
    name: 'setup',
    description: 'Install what doctor reports as missing, asking before each step',
  },
  args: {
    yes: {
      type: 'boolean',
      description: 'Accept every install that does not need sudo (for CI)',
      default: false,
    },
    'dry-run': { type: 'boolean', description: 'Show what would run and stop', default: false },
  },
  async run({ args }) {
    const cfg = await config()
    const report = await runDoctor(cfg)
    const gaps = report.checks.filter((c) => c.status !== 'ok')
    if (!gaps.length) {
      log.success('Nothing to set up; every check passed.')
      return
    }
    const manager = await detectManager()
    log.info(
      manager
        ? `package manager: ${manager}`
        : 'no supported package manager found (brew, apt, winget); showing manual steps',
    )
    const rl =
      args.yes || args['dry-run']
        ? undefined
        : createInterface({ input: process.stdin, output: process.stdout })
    const manual: string[] = []
    let installed = 0
    try {
      for (const check of gaps) {
        const { command, manual: hint } = commandFor(check, manager)
        console.log(`\n# ${check.label}: ${check.detail}`)
        if (!command) {
          if (hint) manual.push(`${check.label}: ${hint}`)
          console.log(hint ? `  manual: ${hint}` : '  no install hint for this platform')
          continue
        }
        console.log(`  ${command}`)
        if (args['dry-run']) continue
        const needsSudo = /\bsudo\b/.test(command)
        let go = false
        if (rl) {
          const answer = (
            await rl.question(needsSudo ? '  This needs sudo. Run it? [y/N] ' : '  Run it? [Y/n] ')
          )
            .trim()
            .toLowerCase()
          go = needsSudo
            ? answer === 'y' || answer === 'yes'
            : answer === '' || answer === 'y' || answer === 'yes'
        } else if (args.yes && !needsSudo) {
          go = true
        }
        if (!go) {
          manual.push(`${check.label}: ${command}`)
          console.log('  skipped')
          continue
        }
        const r = await runProcess({
          command: 'sh',
          args: ['-c', command],
          env: process.env,
          timeoutMs: 60 * 60_000,
          onStdout: (c) => process.stdout.write(c),
          onStderr: (c) => process.stderr.write(c),
        })
        if (r.exitCode === 0) {
          installed++
          log.success(`${check.label}: done`)
        } else {
          log.error(`${check.label}: exited ${r.exitCode}; run it by hand and check the output`)
          manual.push(`${check.label}: ${command}`)
        }
      }
    } finally {
      rl?.close()
    }
    if (args['dry-run']) {
      log.info('dry run: nothing was installed')
      return
    }
    if (manual.length) {
      console.log('\nStill to do by hand:')
      for (const m of manual) console.log(`  ${m}`)
    }
    if (installed) {
      const after = await runDoctor(cfg)
      const left = after.checks.filter((c) => c.status !== 'ok')
      log.info(
        left.length
          ? `${installed} step(s) done; ${left.length} check(s) still not ok (run mpf doctor)`
          : `${installed} step(s) done; every check passes now`,
      )
    }
  },
})
