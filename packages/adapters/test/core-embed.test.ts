import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CoreManifest } from '@mpf/core'
import { androidCoreEmbed } from '../src/core/android.ts'
import { logicRunnerAllow, writeCoreEmbed } from '../src/core/embed.ts'
import { iosCoreEmbed } from '../src/core/ios.ts'
import { kotlinBinding, kotlinIdent } from '../src/core/kotlin.ts'
import { swiftBinding, swiftIdent } from '../src/core/swift.ts'
import { tsBinding, tsIdent, tsTypeFor } from '../src/core/ts.ts'
import { webCoreEmbed } from '../src/core/web.ts'
import { androidFiles } from '../src/target/android/template.ts'
import { iosFiles } from '../src/target/ios/template.ts'
import { webFiles } from '../src/target/web/template.ts'
import type { CoreHandoff } from '../src/types.ts'

const manifest: CoreManifest = {
  abiVersion: 1,
  functions: [
    {
      name: 'computeTotal',
      description: 'Sum items',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { price: { type: 'number' } },
              required: ['price'],
            },
          },
          taxRate: { type: 'number' },
        },
        required: ['items'],
      },
      outputSchema: {
        type: 'object',
        properties: { total: { type: 'number' } },
        required: ['total'],
      },
    },
    {
      name: '2fa-setup',
      description: '',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string', enum: ['ok', 'fail'] },
    },
  ],
}

function handoff(): CoreHandoff {
  const dir = mkdtempSync(join(tmpdir(), 'mpf-core-handoff-'))
  mkdirSync(join(dir, 'vectors'))
  writeFileSync(join(dir, 'mpf_core.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]))
  writeFileSync(
    join(dir, 'vectors', 'computeTotal.json'),
    JSON.stringify({ function: 'computeTotal', vectors: [] }),
  )
  return { wasm: join(dir, 'mpf_core.wasm'), manifest, vectorsDir: join(dir, 'vectors') }
}

describe('binding generators', () => {
  it('derive identifiers per language', () => {
    expect(tsIdent('2fa-setup')).toBe('_2faSetup')
    expect(kotlinIdent('computeTotal')).toBe('computeTotal')
    expect(kotlinIdent('object')).toBe('`object`')
    expect(swiftIdent('default')).toBe('`default`')
  })

  it('turn JSON Schemas into TypeScript types', () => {
    expect(tsTypeFor(manifest.functions[0]!.inputSchema)).toBe(
      '{ "items": { "price": number }[]; "taxRate"?: number }',
    )
    expect(tsTypeFor(manifest.functions[1]!.outputSchema)).toBe('"ok" | "fail"')
  })

  it('emit one typed wrapper per manifest function in every language', () => {
    const ts = tsBinding(manifest)
    expect(ts).toContain(
      'export function computeTotal(input: computeTotalInput): Promise<computeTotalOutput>',
    )
    expect(ts).toContain('export function _2faSetup(')
    expect(ts).toContain("import wasmUrl from './mpf_core.wasm?url'")
    const kt = kotlinBinding(manifest, 'app.mpf.cart')
    expect(kt).toContain('package app.mpf.cart.core')
    expect(kt).toContain('fun computeTotal(input: Any?): Any? = call("computeTotal", input)')
    expect(kt).toContain('Instance.builder(Parser.parse(wasmBytes)).build()')
    const swift = swiftBinding(manifest)
    expect(swift).toContain(
      'public func computeTotal(_ input: Any) throws -> Any { try call("computeTotal", input) }',
    )
    expect(swift).toContain('instance.exports[function: "mpf_call"]')
    expect(swift).toContain('guard case .i32(1) = try versionFn([])[0]')
  })
})

describe('logic runner allowlist', () => {
  const allows = (platform: string, cmd: string) =>
    logicRunnerAllow(platform).some((re) => re.test(cmd))

  it('ios: swift scripts, a swiftc harness build, and running the binary it produced', () => {
    for (const cmd of [
      'swift vectors.swift',
      'swift run harness',
      'xcrun swift vectors.swift',
      'swiftc -o harness A.swift main.swift',
      'xcrun swiftc -o harness Pricing.swift main.swift',
      './harness',
      './harness < inputs.json',
      './scratch/harness',
      '.build/debug/harness',
      '.build/arm64-apple-macosx/release/harness',
    ])
      expect(allows('ios', cmd), cmd).toBe(true)
    for (const cmd of [
      'swift-frontend -frontend -c A.swift',
      'swiftc-wrapper A.swift',
      'xcrun swift-frontend -c A.swift',
      'sh -c ./harness',
      'bash harness.sh',
      './harness.sh',
      './scratch/run.py',
      './../harness',
      '.build/../harness',
      'xcrun simctl list devices',
      'xcrun xcodebuild -list',
      'xcodebuild test',
    ])
      expect(allows('ios', cmd), cmd).toBe(false)
  })

  it('android: kotlinc and javac harness builds and running them through java', () => {
    for (const cmd of [
      'javac -d out A.java Main.java',
      'kotlinc A.kt Main.kt -include-runtime -d harness.jar',
      'kotlinc-jvm A.kt -d out',
      'java -jar harness.jar',
      'java -cp out Main',
      'kotlin -cp harness.jar MainKt',
      'jshell',
    ])
      expect(allows('android', cmd), cmd).toBe(true)
    for (const cmd of [
      'gradle test',
      './gradlew assembleDebug',
      'javac-wrapper A.java',
      'java-launcher Main',
      'sh -c "java -jar harness.jar"',
      'adb shell am start',
    ])
      expect(allows('android', cmd), cmd).toBe(false)
  })

  it('web keeps the interpreters only; other platforms get nothing', () => {
    expect(allows('web', 'node vectors.mjs')).toBe(true)
    expect(allows('web', 'npx tsx vectors.ts')).toBe(true)
    expect(allows('web', 'node-gyp rebuild')).toBe(false)
    expect(allows('web', 'npm test')).toBe(false)
    expect(logicRunnerAllow('desktop')).toEqual([])
  })
})

describe('embedding the core in target scaffolds', () => {
  it('web: binding, parity test, module, and vectors next to each other; Node typings in the scaffold', () => {
    const ws = mkdtempSync(join(tmpdir(), 'mpf-web-'))
    const written = writeCoreEmbed(ws, handoff(), webCoreEmbed(handoff()))
    expect(written).toEqual(
      expect.arrayContaining([
        'src/core/mpf-core.ts',
        'src/core/parity.test.ts',
        'src/core/mpf_core.wasm',
        'src/core/vectors/computeTotal.json',
      ]),
    )
    expect(readFileSync(join(ws, 'src/core/mpf_core.wasm')).length).toBe(4)
    const files = webFiles({
      name: 'cart',
      appName: 'Cart',
      framework: 'vanilla',
      screens: [{ id: 'home', name: 'Home' }],
      rootScreen: 'home',
      core: true,
    })
    expect(files['package.json']).toContain('"@types/node"')
    expect(files['tsconfig.json']).toContain('"node"')
    expect(files['MPF.md']).toContain('Shared core')
  })

  it('android: Chicory dependency, assets copy, JVM parity resources with an index', () => {
    const ws = mkdtempSync(join(tmpdir(), 'mpf-android-'))
    const written = writeCoreEmbed(ws, handoff(), androidCoreEmbed(handoff(), 'app.mpf.cart'))
    expect(written).toEqual(
      expect.arrayContaining([
        'app/src/main/kotlin/app/mpf/cart/core/MpfCore.kt',
        'app/src/test/kotlin/app/mpf/cart/core/CoreParityTest.kt',
        'app/src/main/assets/mpf_core.wasm',
        'app/src/test/resources/core/mpf_core.wasm',
        'app/src/test/resources/core/vectors/computeTotal.json',
        'app/src/test/resources/core/vectors/index.txt',
      ]),
    )
    expect(readFileSync(join(ws, 'app/src/test/resources/core/vectors/index.txt'), 'utf8')).toBe(
      'computeTotal.json\n',
    )
    const files = androidFiles({
      packageName: 'app.mpf.cart',
      appName: 'Cart',
      minSdk: 28,
      compileSdk: 36,
      screens: [{ id: 'home', name: 'Home' }],
      rootScreen: 'home',
      core: true,
    })
    expect(files['app/build.gradle.kts']).toContain(
      'implementation("com.dylibso.chicory:runtime:1.7.5")',
    )
    expect(files['app/build.gradle.kts']).toContain('testImplementation("org.json:json:')
    expect(files['app/src/main/kotlin/app/mpf/cart/ui/AppRoot.kt']).toContain(
      'safeDrawingPadding()',
    )
    expect(
      androidFiles({
        packageName: 'app.mpf.cart',
        appName: 'Cart',
        minSdk: 26,
        compileSdk: 36,
        screens: [{ id: 'home', name: 'Home' }],
        rootScreen: 'home',
      })['app/build.gradle.kts'],
    ).not.toContain('chicory')
  })

  it('ios: WasmKit package, iOS 18 deployment target, resources for app and tests', () => {
    const ws = mkdtempSync(join(tmpdir(), 'mpf-ios-'))
    const written = writeCoreEmbed(ws, handoff(), iosCoreEmbed(handoff(), 'Cart'))
    expect(written).toEqual(
      expect.arrayContaining([
        'App/Core/MpfCore.swift',
        'AppTests/CoreParityTests.swift',
        'Resources/mpf_core.wasm',
        'TestResources/mpf_core.wasm',
        'TestResources/computeTotal.json',
        'TestResources/index.txt',
      ]),
    )
    const project = {
      name: 'Cart',
      appName: 'Cart',
      bundleId: 'app.mpf.cart',
      screens: [{ id: 'home', name: 'Home' }],
      rootScreen: 'home',
    }
    const withCore = iosFiles({ ...project, core: true })['project.yml']!
    expect(withCore).toContain('iOS: "18.0"')
    expect(withCore).toContain('url: https://github.com/swiftwasm/WasmKit.git')
    expect(withCore).toContain('- package: WasmKit')
    expect(withCore).toContain('- path: Resources\n        buildPhase: resources')
    expect(withCore).toContain('- path: TestResources\n        buildPhase: resources')
    const without = iosFiles(project)['project.yml']!
    expect(without).toContain('iOS: "17.0"')
    expect(without).not.toContain('WasmKit')
  })
})

describe('logicRunnerAllow for Objective-C', () => {
  it('admits clang through xcrun or bare, but not clang++ or clang-format', () => {
    const allowed = (cmd: string) => logicRunnerAllow('ios').some((re) => re.test(cmd))
    expect(
      allowed('xcrun clang -fobjc-arc -framework Foundation mpf-harness/*.m -o mpf-harness/run'),
    ).toBe(true)
    expect(allowed('clang -fobjc-arc main.m')).toBe(true)
    expect(allowed('clang++ main.mm')).toBe(false)
    expect(allowed('clang-format -i main.m')).toBe(false)
    expect(allowed('./mpf-harness/run')).toBe(true)
  })
})
