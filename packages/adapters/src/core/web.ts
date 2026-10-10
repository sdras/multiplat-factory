import { CORE_WASM_FILE } from '@mpf/core'
import type { CoreHandoff } from '../types.ts'
import type { CoreEmbed } from './embed.ts'
import { tsBinding, tsParityTest } from './ts.ts'

export const WEB_CORE_DIR = 'src/core'

/** Module next to the binding (Vite serves it through the `?url` import), vectors and a vitest parity suite beside them. */
export function webCoreEmbed(core: CoreHandoff): CoreEmbed {
  return {
    files: {
      [`${WEB_CORE_DIR}/mpf-core.ts`]: tsBinding(core.manifest, `./${CORE_WASM_FILE}?url`),
      [`${WEB_CORE_DIR}/parity.test.ts`]: tsParityTest(),
      [`${WEB_CORE_DIR}/README.md`]: `Shared core: \`${CORE_WASM_FILE}\` is the WebAssembly module every port of this app runs. \`mpf-core.ts\` is generated from its manifest; import the typed wrappers from it instead of reimplementing the logic. \`parity.test.ts\` asserts the golden vectors in \`vectors/\`.\n`,
    },
    wasmCopies: [`${WEB_CORE_DIR}/${CORE_WASM_FILE}`],
    vectorDirs: [`${WEB_CORE_DIR}/vectors`],
  }
}

/** Conventions appended to MPF.md and the worker prompt when the core is present. */
export function webCoreConventions(core: CoreHandoff): string {
  return `- Shared core: \`${WEB_CORE_DIR}/mpf-core.ts\` exposes ${core.manifest.functions.map((f) => `\`${f.name}\``).join(', ')} backed by \`${WEB_CORE_DIR}/${CORE_WASM_FILE}\`. Call them for that logic instead of reimplementing it; they are async (the module loads once). \`${WEB_CORE_DIR}/parity.test.ts\` must stay green; do not edit generated files under \`${WEB_CORE_DIR}/\`.`
}
