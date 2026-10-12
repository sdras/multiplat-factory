import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import {
  gradleJdkRange,
  gradleWrapperVersion,
  jdkFormulaFor,
} from '../src/toolchain/checks/android.ts'

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
    expect(gradleJdkRange('6.9')).toEqual({ min: 8, max: 15 })
    expect(gradleJdkRange('5.6.4')).toEqual({ min: 8, max: 12 })
    expect(gradleJdkRange('4.6')).toEqual({ min: 8, max: 9 })
  })

  it('names the Homebrew JDK that fits a range', () => {
    expect(jdkFormulaFor({ min: 17, max: 24 })).toBe('openjdk@21')
    expect(jdkFormulaFor({ min: 11, max: 16 })).toBe('openjdk@11')
    expect(jdkFormulaFor({ min: 8, max: 10 })).toBe('openjdk@8')
    expect(jdkFormulaFor({ min: 8, max: 8 })).toBe('openjdk@8')
  })
})
