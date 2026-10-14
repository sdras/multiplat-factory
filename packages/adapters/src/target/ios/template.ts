/**
 * Green SwiftUI scaffold generated through XcodeGen (project.yml instead of a pbxproj,
 * so workers edit YAML). Conventions mirror the Android scaffold: routes = AppSpec screen
 * ids, deep links `mpf://<screenId>`, accessibilityIdentifier = AppSpec testId,
 * UserDefaults-backed store with the source app's keys, and a debug-only `mpf_seed`
 * launch environment/argument that loads a state snapshot.
 */

import { iosCoreProjectYaml } from '../../core/ios.ts'
export const IOS_VERSIONS = {
  deploymentTarget: '17.0',
  /** WasmKit's minimum; applied when the shared core is embedded. */
  coreDeploymentTarget: '18.0',
  swift: '5.10',
  xcodeVersion: '16.0',
}

export const IOS_DEEP_LINK_SCHEME = 'mpf'
export const IOS_SEED_KEY = 'mpf_seed'
export const IOS_ROUTE_KEY = 'mpf_route'

export interface IosScreen {
  id: string
  name: string
}

export interface IosProject {
  /** Xcode project and app target name: letters and digits only. */
  name: string
  appName: string
  bundleId: string
  screens: IosScreen[]
  rootScreen: string
  /** Embed the shared WebAssembly core (WasmKit package, resources, parity test). */
  core?: boolean
}

export function iosProjectNameFor(appName: string): string {
  const n = appName.replace(/[^a-zA-Z0-9]+/g, '')
  return /^[a-zA-Z]/.test(n) && n ? n : `App${n}`
}

export function bundleIdFor(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^[0-9]+/, '')
  return `app.mpf.${slug || 'ported'}`
}

export function swiftTypeName(id: string, taken = new Set<string>()): string {
  let base = id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('')
  if (!base || /^[0-9]/.test(base)) base = `Screen${base}`
  let name = base
  let i = 2
  while (taken.has(name)) name = `${base}${i++}`
  taken.add(name)
  return name
}

export function iosFiles(p: IosProject): Record<string, string> {
  const v = IOS_VERSIONS
  const coreYaml = iosCoreProjectYaml()
  const taken = new Set<string>()
  const screens = p.screens.map((s) => ({ ...s, typeName: swiftTypeName(s.id, taken) }))
  const root = screens.find((s) => s.id === p.rootScreen) ?? screens[0]
  if (!root) throw new Error('an iOS scaffold needs at least one screen')
  const files: Record<string, string> = {}

  files['project.yml'] = `name: ${p.name}
options:
  bundleIdPrefix: app.mpf
  deploymentTarget:
    iOS: "${p.core ? v.coreDeploymentTarget : v.deploymentTarget}"
  xcodeVersion: "${v.xcodeVersion}"
  createIntermediateGroups: true
  generateEmptyDirectories: true
settings:
  base:
    SWIFT_VERSION: "${v.swift}"
    CODE_SIGNING_ALLOWED: "NO"
    CODE_SIGN_IDENTITY: ""
    DEVELOPMENT_TEAM: ""
    ENABLE_USER_SCRIPT_SANDBOXING: "YES"
    SWIFT_STRICT_CONCURRENCY: minimal
${p.core ? coreYaml.packages : ''}targets:
  ${p.name}:
    type: application
    platform: iOS
    sources:
      - path: App
${p.core ? coreYaml.appTarget : ''}${p.core ? '    dependencies:\n      - package: WasmKit\n' : ''}    info:
      path: App/Info.plist
      properties:
        CFBundleDisplayName: ${yamlStr(p.appName)}
        CFBundleShortVersionString: "1.0"
        CFBundleVersion: "1"
        UILaunchScreen: {}
        UISupportedInterfaceOrientations: [UIInterfaceOrientationPortrait]
        CFBundleURLTypes:
          - CFBundleURLName: ${IOS_DEEP_LINK_SCHEME}
            CFBundleURLSchemes: [${IOS_DEEP_LINK_SCHEME}]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${p.bundleId}
        TARGETED_DEVICE_FAMILY: "1"
        INFOPLIST_KEY_UIApplicationSceneManifest_Generation: "YES"
  ${p.name}Tests:
    type: bundle.unit-test
    platform: iOS
    sources:
      - path: AppTests
${p.core ? coreYaml.testTarget : ''}    dependencies:
      - target: ${p.name}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${p.bundleId}.tests
schemes:
  ${p.name}:
    build:
      targets:
        ${p.name}: all
        ${p.name}Tests: [test]
    run:
      config: Debug
    test:
      config: Debug
      targets:
        - ${p.name}Tests
`

  files['.gitignore'] = `build/
DerivedData/
*.xcodeproj
xcuserdata/
.DS_Store
`

  files[`App/${p.name}App.swift`] = `import SwiftUI

@main
struct ${p.name}App: App {
    @StateObject private var router = Router()

    init() {
        AppStore.shared.applySeedIfPresent()
    }

    var body: some Scene {
        WindowGroup {
            AppRoot()
                .environmentObject(router)
                .onOpenURL { url in router.open(url) }
        }
    }
}
`

  files['App/Router.swift'] = `import Foundation
import SwiftUI

/// Routes are the AppSpec screen ids. Deep links \`${IOS_DEEP_LINK_SCHEME}://<screenId>\` navigate to a screen.
enum Routes {
${screens.map((s) => `    static let ${camel(s.id)} = "${s.id}"`).join('\n')}
    static let root = ${camel(root.id)}
    static let all: [String] = [${screens.map((s) => camel(s.id)).join(', ')}]
}

final class Router: ObservableObject {
    @Published var path: [String] = []

    init() {
        // Tests and the factory pick the first screen through a launch argument or
        // environment variable (\`${IOS_ROUTE_KEY}\`), because opening a custom URL scheme
        // from outside the app shows a system confirmation dialog on iOS.
        if let id = LaunchValues.value(for: "${IOS_ROUTE_KEY}"), Routes.all.contains(id) {
            path = id == Routes.root ? [] : [id]
        }
    }

    func open(_ url: URL) {
        guard url.scheme == "${IOS_DEEP_LINK_SCHEME}" else { return }
        let id = url.host ?? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard Routes.all.contains(id) else { return }
        path = id == Routes.root ? [] : [id]
    }

    func go(_ id: String) {
        path = id == Routes.root ? [] : [id]
    }
}
`

  files['App/AppRoot.swift'] = `import SwiftUI

/// Root of the app. Every screen is reachable through the router by its AppSpec id.
struct AppRoot: View {
    @EnvironmentObject private var router: Router

    var body: some View {
        NavigationStack(path: $router.path) {
            screen(Routes.root)
                .navigationDestination(for: String.self) { id in screen(id) }
        }
        .accessibilityIdentifier("mpf-root")
    }

    @ViewBuilder
    func screen(_ id: String) -> some View {
        switch id {
${screens.map((s) => `        case Routes.${camel(s.id)}: ${s.typeName}Screen()`).join('\n')}
        default: ${root.typeName}Screen()
        }
    }
}
`

  for (const s of screens) {
    files[`App/Screens/${s.typeName}Screen.swift`] = `import SwiftUI

/// Placeholder for the "${s.name}" screen (AppSpec id "${s.id}"). Replace the body; keep the identifier.
struct ${s.typeName}Screen: View {
    @EnvironmentObject private var router: Router

    var body: some View {
        VStack {
            Text(${swiftStr(s.name)})
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("screen-${s.id}")
    }
}
`
  }

  files['App/Data/AppStore.swift'] = `import Foundation

/// Persistence with the same keys and JSON shapes as the source app, so data stays
/// interchangeable. Values are stored as strings; JSON documents use \`encoder\`/\`decoder\`.
final class AppStore {
    static let shared = AppStore()
    static let seedKey = "${IOS_SEED_KEY}"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Omits nothing by itself; encode optionals with \`encodeIfPresent\` so absent fields stay absent.
    let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = []
        return e
    }()

    let decoder = JSONDecoder()

    func string(_ key: String) -> String? {
        defaults.string(forKey: key)
    }

    func set(_ value: String?, for key: String) {
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }

    /// Replace all stored keys with a JSON object of key -> value (strings verbatim, others as JSON text).
    /// Written through before returning: the factory's flows may stop the app as soon as its root
    /// view is visible, and a seed that only reached the in-memory cache would be lost.
    func seed(json: String) {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        for key in defaults.dictionaryRepresentation().keys where !key.hasPrefix("Apple") && !key.hasPrefix("NS") && !key.hasPrefix("com.apple") {
            defaults.removeObject(forKey: key)
        }
        for (key, value) in object {
            if let s = value as? String {
                defaults.set(s, forKey: key)
            } else if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
                      let text = String(data: data, encoding: .utf8) {
                defaults.set(text, forKey: key)
            }
        }
        defaults.synchronize()
    }

    /// Debug builds accept \`${IOS_SEED_KEY}\` as an environment variable or launch argument
    /// so tests can start from a known state.
    func applySeedIfPresent() {
        #if DEBUG
        if let json = LaunchValues.value(for: AppStore.seedKey) {
            seed(json: json)
        }
        #endif
    }
}

/// Reads \`key\` from the environment or from launch arguments in any common form:
/// \`-key value\`, \`--key value\`, \`key=value\`, \`-key=value\`.
enum LaunchValues {
    static func value(for key: String) -> String? {
        let info = ProcessInfo.processInfo
        if let v = info.environment[key] { return v }
        let args = info.arguments
        for (i, arg) in args.enumerated() {
            if (arg == "-" + key || arg == "--" + key), i + 1 < args.count { return args[i + 1] }
            for prefix in [key + "=", "-" + key + "=", "--" + key + "="] where arg.hasPrefix(prefix) {
                return String(arg.dropFirst(prefix.count))
            }
        }
        return nil
    }
}
`

  files['AppTests/ScaffoldTests.swift'] = `import XCTest
@testable import ${p.name}

/// The factory's smoke test: the route table the router is built from is sound.
final class ScaffoldTests: XCTestCase {
    func testRouteTableIsSound() {
        XCTAssertFalse(Routes.all.isEmpty)
        XCTAssertTrue(Routes.all.contains(Routes.root))
        XCTAssertEqual(Set(Routes.all).count, Routes.all.count)
        XCTAssertTrue(Routes.all.allSatisfy { !$0.isEmpty && $0 == $0.trimmingCharacters(in: .whitespaces) })
    }
}
`

  files['MPF.md'] = `# Conventions for this generated iOS project

- Project: \`${p.name}\` generated from \`project.yml\` with XcodeGen (run \`xcodegen generate\` after changing it; never edit the .xcodeproj by hand). SwiftUI, iOS ${p.core ? v.coreDeploymentTarget : v.deploymentTarget}+, bundle id \`${p.bundleId}\`.
- Build: \`xcodebuild -project ${p.name}.xcodeproj -scheme ${p.name} -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO build\`. Unit tests: the same with \`test\` and a concrete simulator destination. Keep both green.
- Routes are the AppSpec screen ids (\`App/Router.swift\`). Every screen must stay reachable by deep link \`${IOS_DEEP_LINK_SCHEME}://<screenId>\` and through the \`${IOS_ROUTE_KEY}\` launch argument or environment variable, which the factory's flows use to open a screen at launch (\`LaunchValues\` reads both). Add new screens to \`Routes\`, \`AppRoot.screen(_:)\`, and \`App/Screens/\`.
- Every AppSpec element gets \`.accessibilityIdentifier("<testId>")\` on the view a user interacts with (the button, the text field, the text). Keep \`mpf-root\` on the root and \`screen-<id>\` (with \`.accessibilityElement(children: .contain)\`) on each screen container.
- Every icon-only control (a \`Button\` whose label is only an \`Image(systemName:)\` or a glyph such as "+", a toolbar item or \`UIBarButtonItem\` with a system image) carries \`.accessibilityLabel("…")\` that says what it does ("Add item", "Increase count", "Close"); \`Label("Add item", systemImage: "plus").labelStyle(.iconOnly)\` keeps its title as that name. VoiceOver must announce the action, never "plus" or the symbol name. Controls with a visible text label need no extra label.
- Controls repeated per row (a row's toggle, delete, or edit control) carry an \`.accessibilityLabel\` that includes the row's primary text (\`Delete Buy milk\`, not \`Delete\`), so VoiceOver and flows can tell one row's control from another's.
- A field the source submits on Enter must submit both on the keyboard's return key (\`onSubmit\`, \`submitLabel\`) and on a hardware Return key event: the flows type with \`inputText\` and then \`pressKey: Enter\`.
- Never change timings, durations, or the visibility of transient UI (a snackbar, a toast, a loading indicator) so that a flow can observe it; the port shows them for as long as the source does. A flow that cannot catch a transient element is reported as such, not accommodated.
- Tappable text (a filter pill, a "Clear completed" link, a title that navigates) is a \`Button\` or carries \`.accessibilityAddTraits(.isButton)\`, never a bare \`onTapGesture\`, so VoiceOver announces it as a control.
- Persist state through \`App/Data/AppStore.swift\` using the source app's key names and JSON shapes exactly (wire-format pins from the AppSpec). Store JSON documents as strings.
- Debug builds accept the \`${IOS_SEED_KEY}\` environment variable or launch argument (JSON object of key -> value) that replaces persisted state before the UI shows; do not remove it. A seed must be persisted before the first frame: \`AppStore.seed\` writes it synchronously and calls \`synchronize()\`, and \`applySeedIfPresent()\` runs in the app's \`init\`; keep both, because a flow may stop the app as soon as the root view is visible and read the stored state on relaunch.
- Pure logic goes in \`App/Logic/\` as plain Swift with XCTest cases in \`AppTests/\`. UI state lives in \`@State\`/\`@Observable\` models, never in globals.
- No dependencies that need network access at runtime unless the port plan says the integration is ported. No signing changes.
${p.core ? '- Shared core: see the "Shared core" section appended below; call `App/Core/MpfCore.swift` for that logic instead of reimplementing it, and keep `CoreParityTests` green.\n' : ''}`
  return files
}

function camel(id: string): string {
  const parts = id.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const name = parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1)))
    .join('')
  return /^[a-zA-Z]/.test(name) ? name : `s${name}`
}

function swiftStr(s: string): string {
  return JSON.stringify(s)
}

function yamlStr(s: string): string {
  return JSON.stringify(s)
}
