import { existsSync } from 'node:fs'
import { tryOutput, which } from '../../exec.ts'
import { type CheckFn, missing, ok, warn } from '../types.ts'

export const xcodeCheck: CheckFn = async ({ env, platform, toolchain }) => {
  if (platform !== 'darwin') {
    return missing('xcode', 'Xcode', 'iOS targets require macOS with Xcode', { affects: ['ios'] })
  }
  const devDir =
    toolchain.developerDir ?? env.DEVELOPER_DIR ?? (await tryOutput('xcode-select', ['-p'], env))
  if (!devDir || !existsSync(devDir)) {
    return missing('xcode', 'Xcode', 'No developer directory; install Xcode from the App Store', {
      affects: ['ios'],
      fix: { manual: 'Install Xcode, then `sudo xcode-select -s /Applications/Xcode.app`' },
    })
  }
  // The harness runs every Xcode tool with DEVELOPER_DIR, so a full Xcode is usable even when
  // xcode-select still points at the Command Line Tools; only its absence blocks iOS.
  let resolved = devDir
  let selectNote = ''
  if (!/Xcode.*\.app\/Contents\/Developer$/.test(devDir)) {
    const candidates = ['/Applications/Xcode.app', '/Applications/Xcode-beta.app'].filter((p) =>
      existsSync(p),
    )
    if (!candidates.length) {
      return missing(
        'xcode',
        'Xcode',
        `Developer directory is ${devDir} (Command Line Tools only) and no Xcode.app was found. Install Xcode.`,
        {
          affects: ['ios'],
          fix: { manual: 'Install Xcode, then `sudo xcode-select -s /Applications/Xcode.app`' },
        },
      )
    }
    resolved = `${candidates[0]}/Contents/Developer`
    selectNote = ` (used through DEVELOPER_DIR; xcode-select still points at ${devDir}, run \`sudo xcode-select -s ${candidates[0]}\` to make it the default)`
  }
  const xenv = { ...env, DEVELOPER_DIR: resolved }
  const version = (await tryOutput('xcodebuild', ['-version'], xenv))?.split('\n')[0] ?? 'Xcode'
  const runtimes = await tryOutput('xcrun', ['simctl', 'list', '-j', 'runtimes'], xenv, 30_000)
  const hasIos = runtimes ? /"platform"\s*:\s*"iOS"/.test(runtimes) : false
  if (!hasIos) {
    return warn('xcode', 'Xcode', `${version}; no iOS simulator runtime installed`, {
      version,
      affects: ['ios'],
      fix: { manual: 'Xcode > Settings > Components: install an iOS simulator runtime' },
    })
  }
  const xcodegen = await which('xcodegen', xenv)
  if (!xcodegen) {
    return warn(
      'xcode',
      'Xcode',
      `${version} with iOS simulators; xcodegen missing (needed to generate projects)`,
      {
        version,
        affects: ['ios'],
        fix: { brew: 'brew install xcodegen', manual: 'https://github.com/yonaskolb/XcodeGen' },
      },
    )
  }
  return ok('xcode', 'Xcode', `${version}, iOS simulators, xcodegen${selectNote}`, {
    version,
    affects: ['ios'],
  })
}
