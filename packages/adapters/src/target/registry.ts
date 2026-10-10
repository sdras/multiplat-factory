import type { Target } from '@mpf/core'
import type { TargetAdapter } from '../types.ts'
import { androidTarget } from './android/index.ts'
import { iosTarget } from './ios/index.ts'
import { webTarget } from './web/index.ts'

export const TARGET_ADAPTERS: TargetAdapter[] = [androidTarget, iosTarget, webTarget]

export function getTargetAdapter(target: Target): TargetAdapter | undefined {
  return TARGET_ADAPTERS.find((a) => a.target === target)
}
