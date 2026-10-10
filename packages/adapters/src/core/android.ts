import { CORE_WASM_FILE } from '@mpf/core'
import type { CoreHandoff } from '../types.ts'
import type { CoreEmbed } from './embed.ts'
import { CHICORY_DEPENDENCY, kotlinBinding, kotlinParityTest } from './kotlin.ts'

/** Chicory needs Android 9+ (API 28) at runtime. */
export const ANDROID_CORE_MIN_SDK = 28
/** org.json on the JVM for unit tests (android.jar only stubs it). */
export const ORG_JSON_TEST_DEPENDENCY = 'org.json:json:20250517'

export function androidCoreEmbed(core: CoreHandoff, packageName: string): CoreEmbed {
  const pkgPath = packageName.replace(/\./g, '/')
  return {
    files: {
      [`app/src/main/kotlin/${pkgPath}/core/MpfCore.kt`]: kotlinBinding(core.manifest, packageName),
      [`app/src/test/kotlin/${pkgPath}/core/CoreParityTest.kt`]: kotlinParityTest(packageName),
    },
    wasmCopies: [
      `app/src/main/assets/${CORE_WASM_FILE}`,
      `app/src/test/resources/core/${CORE_WASM_FILE}`,
    ],
    vectorDirs: ['app/src/test/resources/core/vectors'],
    vectorIndex: 'app/src/test/resources/core/vectors/index.txt',
  }
}

/** Gradle dependency lines the template adds when the core is embedded. */
export function androidCoreDependencies(): string[] {
  return [
    `implementation("${CHICORY_DEPENDENCY}")`,
    `testImplementation("${ORG_JSON_TEST_DEPENDENCY}")`,
  ]
}

export function androidCoreConventions(core: CoreHandoff, packageName: string): string {
  return `- Shared core: \`core/MpfCore.kt\` (package \`${packageName}.core\`) runs \`${CORE_WASM_FILE}\` from assets through Chicory and exposes ${core.manifest.functions.map((f) => `\`${f.name}\``).join(', ')} (JSON in, JSON out via org.json). Create one \`MpfCore.fromAssets(context)\` per process (e.g. in the Application or a ViewModel factory) and call it for that logic instead of reimplementing it; calls are synchronous and cheap. \`CoreParityTest\` must stay green; do not edit generated files under \`core/\` or \`src/test/resources/core/\`.`
}
