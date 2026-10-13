import { describe, expect, it } from 'vitest'
import { MpfConfig } from '@mpf/core'
import { sourceToolEnv } from '../src/source-tools.ts'

const config = MpfConfig.parse({})

describe('sourceToolEnv', () => {
  it('hands an Android source the resolved JDK and the Gradle cache', async () => {
    const r = await sourceToolEnv(
      'android',
      config,
      '/src',
      { PATH: '/usr/bin', HOME: '/home/u' },
      {
        androidTools: async (_c, env = {}) => ({
          sdk: '/sdk',
          adb: '/sdk/platform-tools/adb',
          emulator: '/sdk/emulator/emulator',
          javaHome: '/jdk/21',
          javaMajor: 21,
          javaInRange: true,
          env: { ...env, JAVA_HOME: '/jdk/21', PATH: `/jdk/21/bin:${env.PATH}` },
        }),
        exists: (p) => p === '/home/u/.gradle/caches',
        home: () => '/home/u',
      },
    )
    expect(r.env.JAVA_HOME).toBe('/jdk/21')
    expect(r.env.PATH).toMatch(/^\/jdk\/21\/bin:/)
    expect(r.readDirs).toEqual(['/home/u/.gradle/caches'])
    expect(r.note).toMatch(/JAVA_HOME is \/jdk\/21 \(JDK 21\)/)
    expect(r.note).toMatch(/modules-2\/files-2\.1/)
  })

  it('says so when no JDK or Xcode is available instead of leaving the worker to hunt', async () => {
    const none = await sourceToolEnv(
      'android',
      config,
      '/src',
      { PATH: '/usr/bin' },
      { androidTools: async () => undefined, exists: () => false, home: () => '/home/u' },
    )
    expect(none.env.JAVA_HOME).toBeUndefined()
    expect(none.note).toMatch(/No JDK/)
    const ios = await sourceToolEnv(
      'ios',
      config,
      '/src',
      { PATH: '/usr/bin' },
      { xcodeTools: async () => undefined },
    )
    expect(ios.note).toMatch(/No Xcode/)
  })

  it('puts the Xcode toolchain on an iOS source worker’s PATH', async () => {
    const r = await sourceToolEnv(
      'ios',
      config,
      '/src',
      { PATH: '/usr/bin' },
      {
        xcodeTools: async (_c, env = {}) => ({
          developerDir: '/Applications/Xcode.app/Contents/Developer',
          env: { ...env, DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' },
        }),
      },
    )
    expect(r.env.DEVELOPER_DIR).toBe('/Applications/Xcode.app/Contents/Developer')
    expect(r.env.PATH).toBe(
      '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin:/Applications/Xcode.app/Contents/Developer/usr/bin:/usr/bin',
    )
    expect(r.readDirs).toEqual([])
  })

  it('leaves a web source alone', async () => {
    const r = await sourceToolEnv('web', config, '/src', { PATH: '/usr/bin' })
    expect(r).toEqual({ env: { PATH: '/usr/bin' }, readDirs: [], note: '' })
  })
})
