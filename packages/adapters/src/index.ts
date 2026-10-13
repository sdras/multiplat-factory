export {
  countByExt,
  hasFile,
  makeDetectContext,
  type DetectContext,
  type ObserveOptions,
  type PackageJson,
  type SourceAdapter,
  type TargetAdapter,
} from './types.ts'
export { SOURCE_ADAPTERS, detectSource, getSourceAdapter, type DetectResult } from './registry.ts'
export type {
  BuildResult,
  CompiledFlow,
  CoreHandoff,
  E2eResult,
  MobileObserveOptions,
  MobileSourceApp,
  SourceTestCommand,
  SourceTestOptions,
  TargetContext,
  TargetDocs,
  TestOutcome,
} from './types.ts'
export { TARGET_ADAPTERS, getTargetAdapter } from './target/registry.ts'
export { androidTarget, projectFor as androidProjectFor } from './target/android/index.ts'
export { iosTarget, iosProjectFor } from './target/ios/index.ts'
export {
  IOS_DEEP_LINK_SCHEME,
  IOS_SEED_KEY,
  IOS_VERSIONS,
  bundleIdFor,
  iosFiles,
  iosProjectNameFor,
  swiftTypeName,
} from './target/ios/template.ts'
export { parseXcodebuildOutput, parseXcodebuildTests } from './target/xcodebuild.ts'
export {
  executeBehavior,
  launchChromium,
  looseText,
  resolveElement,
  routeUrl,
  screenshotScreens,
  type Log,
  type StepResult,
} from './target/web/executor.ts'
export { parseWebBuildOutput, webProjectFor, webTarget } from './target/web/index.ts'
export {
  WEB_SEED_PARAM,
  WEB_VERSIONS,
  screenIdent,
  webFiles,
  webPackageNameFor,
  type WebFramework,
  type WebProject,
} from './target/web/template.ts'
export {
  ANDROID_VERSIONS,
  DEEP_LINK_SCHEME,
  SEED_EXTRA,
  androidDeepLinkBase,
  androidFiles,
  packageNameFor,
  screenClassName,
} from './target/android/template.ts'
export { compileMaestroFlow, type CompiledMaestro, type MaestroOptions } from './target/maestro.ts'
export { gradleArgs, parseGradleOutput } from './target/gradle.ts'
export { parseJUnitDir, parseJUnitFile, parseJUnitXml } from './target/junit.ts'
export {
  detectPackageManager,
  ensureInstalled,
  localBin,
  type PackageManager,
} from './source/pm.ts'
export { WEB_SOURCE_ADAPTERS, summarizeWebTests } from './source/web.ts'
export { MOBILE_SOURCE_ADAPTERS, xcodeContainer, xcodegenSpec } from './source/mobile.ts'
export { CROSS_PLATFORM_ADAPTERS } from './source/cross.ts'
export { logicRunnerAllow, writeCoreEmbed, type CoreEmbed } from './core/embed.ts'
export { tsBinding, tsIdent, tsParityTest, tsTypeFor } from './core/ts.ts'
export {
  CHICORY_DEPENDENCY,
  CHICORY_VERSION,
  kotlinBinding,
  kotlinIdent,
  kotlinParityTest,
} from './core/kotlin.ts'
export { WEB_CORE_DIR, webCoreConventions, webCoreEmbed } from './core/web.ts'
export {
  ANDROID_CORE_MIN_SDK,
  ORG_JSON_TEST_DEPENDENCY,
  androidCoreConventions,
  androidCoreDependencies,
  androidCoreEmbed,
} from './core/android.ts'
export {
  WASMKIT_URL,
  WASMKIT_VERSION,
  swiftBinding,
  swiftIdent,
  swiftParityTest,
} from './core/swift.ts'
export {
  IOS_CORE_RESOURCES,
  IOS_CORE_TEST_RESOURCES,
  iosCoreConventions,
  iosCoreEmbed,
  iosCoreProjectYaml,
} from './core/ios.ts'
export {
  MAESTRO_DEBUG_DIR,
  attachFlowEvidence,
  collectFlowEvidence,
  findNamedScreenshot,
  summarizeHierarchy,
  type FlowEvidence,
} from './target/maestro-evidence.ts'
export { startScreenOf } from './target/start-screen.ts'
