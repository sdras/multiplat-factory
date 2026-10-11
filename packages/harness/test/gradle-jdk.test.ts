import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { gradleJdkRange, gradleWrapperVersion } from '../src/toolchain/checks/android.ts'

describe('gradleWrapperVersion', () => {
  it('reads the pinned Gradle version from the wrapper properties', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mpf-gradle-'))
    mkdirSync(join(dir, 'gradle', 'wrapper'), { recursive: true })
    writeFileSync(
      join(dir, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
      'distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-7.2-bin.zip\n',
    )
    expect(gradleWrapperVersion(dir)).toBe('7.2')
    expect(gradleWrapperVersion(join(dir, 'nope'))).toBeUndefined()
  })
})

describe('gradleJdkRange', () => {
  it('follows the Gradle compatibility table', () => {
    expect(gradleJdkRange('7.2')).toEqual({ min: 11, max: 16 })
    expect(gradleJdkRange('7.3.3')).toEqual({ min: 11, max: 17 })
    expect(gradleJdkRange('7.6')).toEqual({ min: 11, max: 19 })
    expect(gradleJdkRange('8.4')).toEqual({ min: 17, max: 20 })
    expect(gradleJdkRange('8.14.3')).toEqual({ min: 17, max: 24 })
    expect(gradleJdkRange('6.9')).toEqual({ min: 11, max: 15 })
  })
})
