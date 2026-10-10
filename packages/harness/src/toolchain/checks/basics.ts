import { tryOutput, which } from '../../exec.ts'
import { hasWasmTarget, rustTools } from '../rust.ts'
import { type CheckFn, missing, ok, warn } from '../types.ts'

export const nodeCheck: CheckFn = async () => {
  const v = process.versions.node
  const [major = 0, minor = 0] = v.split('.').map(Number)
  const good = major > 22 || (major === 22 && minor >= 13)
  return good
    ? ok('node', 'Node.js', `v${v}`, { version: v, affects: ['all'] })
    : missing('node', 'Node.js', `v${v} is below 22.13 (node:sqlite is unflagged from 22.13)`, {
        version: v,
        affects: ['all'],
        fix: { manual: 'Install Node 24 LTS (nvm install 24, or from nodejs.org)' },
      })
}

export const gitCheck: CheckFn = async ({ env }) => {
  const v = await tryOutput('git', ['--version'], env)
  return v
    ? ok('git', 'git', v, { version: v.replace(/^git version /, ''), affects: ['all'] })
    : missing('git', 'git', 'git is required to clone sources and pin fixtures', {
        affects: ['all'],
        fix: {
          brew: 'brew install git',
          apt: 'sudo apt install git',
          winget: 'winget install Git.Git',
        },
      })
}

export const packageManagerCheck: CheckFn = async ({ env }) => {
  const pnpm = await tryOutput('pnpm', ['--version'], env)
  const npm = await tryOutput('npm', ['--version'], env)
  if (pnpm) return ok('pm', 'Package manager', `pnpm ${pnpm}`, { version: pnpm, affects: ['web'] })
  if (npm)
    return ok('pm', 'Package manager', `npm ${npm} (pnpm preferred)`, {
      version: npm,
      affects: ['web'],
    })
  return missing('pm', 'Package manager', 'Neither pnpm nor npm found', {
    affects: ['web'],
    fix: { manual: 'npm ships with Node; or `npm i -g pnpm`' },
  })
}

export const rustCheck: CheckFn = async ({ env, toolchain }) => {
  const tools = await rustTools({ toolchain }, env)
  if (!tools) {
    return missing('rust', 'Rust toolchain', 'cargo not found; the shared WASM core is disabled', {
      affects: ['core'],
      fix: {
        brew: 'brew install rustup && rustup default stable && rustup target add wasm32-unknown-unknown',
        manual: 'https://rustup.rs then `rustup target add wasm32-unknown-unknown`',
      },
    })
  }
  const v = tools.version ?? 'cargo'
  if (!(await hasWasmTarget(tools))) {
    return warn('rust', 'Rust toolchain', `${v}; wasm32-unknown-unknown target not installed`, {
      version: v,
      affects: ['core'],
      fix: { manual: 'rustup target add wasm32-unknown-unknown' },
    })
  }
  return ok('rust', 'Rust toolchain', `${v} with wasm32-unknown-unknown`, {
    version: v,
    affects: ['core'],
  })
}

export const gradleCheck: CheckFn = async ({ env }) => {
  const out = await tryOutput('gradle', ['--version'], env, 60_000)
  const v = /Gradle (\d+\.\d+(?:\.\d+)?)/.exec(out ?? '')?.[1]
  if (!v) {
    return missing(
      'gradle',
      'Gradle',
      'gradle not found; needed once per Android project to create its wrapper',
      {
        affects: ['android'],
        fix: {
          brew: 'brew install gradle',
          apt: 'sdk install gradle (SDKMAN) or your distro package',
          winget: 'winget install Gradle.Gradle',
        },
      },
    )
  }
  return ok('gradle', 'Gradle', `Gradle ${v} (generated projects pin their own wrapper)`, {
    version: v,
    affects: ['android'],
  })
}

export const maestroCheck: CheckFn = async ({ env, toolchain }) => {
  const bin = toolchain.maestro ?? (await which('maestro', env))
  if (!bin) {
    return warn('maestro', 'Maestro', 'Not found; mobile end-to-end flows will be skipped', {
      affects: ['ios-e2e', 'android-e2e'],
      fix: {
        brew: 'brew trust mobile-dev-inc/tap && brew install --formula mobile-dev-inc/tap/maestro',
        manual: 'https://maestro.dev/docs (curl installer)',
      },
    })
  }
  const v = (await tryOutput(bin, ['--version'], env, 30_000)) ?? 'installed'
  return ok('maestro', 'Maestro', `Maestro ${v}`, {
    version: v,
    affects: ['ios-e2e', 'android-e2e'],
  })
}
