import { CORE_WASM_FILE } from '@mpf/core'
import type { CoreHandoff } from '../types.ts'
import type { CoreEmbed } from './embed.ts'
import { WASMKIT_URL, WASMKIT_VERSION, swiftBinding, swiftParityTest } from './swift.ts'

/** App resources (the module) and test resources (module + vectors) live outside the source folders so XcodeGen copies them as resources. */
export const IOS_CORE_RESOURCES = 'Resources'
export const IOS_CORE_TEST_RESOURCES = 'TestResources'

export function iosCoreEmbed(core: CoreHandoff, moduleName: string): CoreEmbed {
  return {
    files: {
      'App/Core/MpfCore.swift': swiftBinding(core.manifest),
      'AppTests/CoreParityTests.swift': swiftParityTest(moduleName),
    },
    wasmCopies: [
      `${IOS_CORE_RESOURCES}/${CORE_WASM_FILE}`,
      `${IOS_CORE_TEST_RESOURCES}/${CORE_WASM_FILE}`,
    ],
    vectorDirs: [IOS_CORE_TEST_RESOURCES],
    vectorIndex: `${IOS_CORE_TEST_RESOURCES}/index.txt`,
  }
}

/** project.yml fragments (top-level packages, app target extras, test target extras). */
export function iosCoreProjectYaml(): { packages: string; appTarget: string; testTarget: string } {
  return {
    packages: `packages:
  WasmKit:
    url: ${WASMKIT_URL}
    from: ${WASMKIT_VERSION}
`,
    appTarget: `      - path: ${IOS_CORE_RESOURCES}
        buildPhase: resources
`,
    testTarget: `      - path: ${IOS_CORE_TEST_RESOURCES}
        buildPhase: resources
`,
  }
}

export function iosCoreConventions(core: CoreHandoff): string {
  return `- Shared core: \`App/Core/MpfCore.swift\` runs \`${CORE_WASM_FILE}\` (an app resource) through WasmKit and exposes ${core.manifest.functions.map((f) => `\`${f.name}\``).join(', ')} (JSON in, JSON out via Foundation types). Create one \`try MpfCore.bundled()\` per process (e.g. in the app's environment or a model) and call it for that logic instead of reimplementing it; calls are synchronous. \`CoreParityTests\` must stay green; do not edit generated files under \`App/Core/\`, \`${IOS_CORE_RESOURCES}/\`, or \`${IOS_CORE_TEST_RESOURCES}/\`. The WasmKit package needs Swift 6.3 tools (Xcode 26.3+) and raises the deployment target to iOS 18; the project resolves it from the network on first build.`
}
