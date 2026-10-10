/**
 * Green Jetpack Compose scaffold. Everything here builds before an LLM touches it.
 * Conventions the generation worker must keep are documented in MPF.md (also
 * fed into its system prompt): routes = AppSpec screen ids, deep links
 * `mpf://<screenId>`, testTag = AppSpec testId with testTagsAsResourceId, state
 * persisted as JSON strings in DataStore under the source app's keys, and a
 * debug-only `mpf_seed` intent extra that loads a state snapshot.
 */

/**
 * Pinned to the last AndroidX train that compiles against SDK 36 with AGP 8.13.
 * Newer trains (Compose 1.12+, navigation 2.10+, lifecycle 2.11+) require
 * compileSdk 37 and AGP 9.1; move all of these together when platform 37 lands.
 */
import { androidCoreDependencies } from '../../core/android.ts'
export const ANDROID_VERSIONS = {
  gradle: '8.14.3',
  agp: '8.13.2',
  kotlin: '2.4.20',
  composeBom: '2026.06.01',
  activityCompose: '1.12.4',
  navigationCompose: '2.9.8',
  lifecycle: '2.10.0',
  datastore: '1.2.1',
  serialization: '1.11.0',
  coroutines: '1.11.0',
  coreKtx: '1.18.0',
  junit: '4.13.2',
}

export const DEEP_LINK_SCHEME = 'mpf'
export const SEED_EXTRA = 'mpf_seed'

/**
 * Deep links are qualified by the application id (`mpf://<applicationId>/<screenId>`) so several
 * ported apps on one device never compete for the same implicit intent, which would show
 * Android's "Open with" chooser and stall automated flows.
 */
export function androidDeepLinkBase(packageName: string): string {
  return `${DEEP_LINK_SCHEME}://${packageName}`
}

export interface AndroidScreen {
  id: string
  name: string
}

export interface AndroidProject {
  packageName: string
  appName: string
  minSdk: number
  compileSdk: number
  screens: AndroidScreen[]
  rootScreen: string
  /** Embed the shared WebAssembly core (Chicory runtime, parity test). */
  core?: boolean
}

export function packageNameFor(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^[0-9]+/, '')
  return `app.mpf.${slug || 'ported'}`
}

/** PascalCase Kotlin identifier from a screen id; unique within the project. */
export function screenClassName(id: string, taken = new Set<string>()): string {
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

export function androidFiles(p: AndroidProject): Record<string, string> {
  const v = ANDROID_VERSIONS
  const pkgPath = p.packageName.replace(/\./g, '/')
  const taken = new Set<string>()
  const screens = p.screens.map((s) => ({ ...s, className: screenClassName(s.id, taken) }))
  const root = screens.find((s) => s.id === p.rootScreen) ?? screens[0]
  if (!root) throw new Error('an Android scaffold needs at least one screen')
  const files: Record<string, string> = {}

  files['settings.gradle.kts'] = `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = ${kstr(p.appName)}
include(":app")
`

  files['build.gradle.kts'] = `plugins {
    id("com.android.application") version "${v.agp}" apply false
    id("org.jetbrains.kotlin.android") version "${v.kotlin}" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "${v.kotlin}" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "${v.kotlin}" apply false
}
`

  files['gradle.properties'] = `org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8
org.gradle.caching=true
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
`

  files['.gitignore'] = `.gradle/
build/
local.properties
.idea/
*.iml
.kotlin/
`

  files['app/build.gradle.kts'] = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "${p.packageName}"
    compileSdk = ${p.compileSdk}

    defaultConfig {
        applicationId = "${p.packageName}"
        minSdk = ${p.minSdk}
        targetSdk = ${p.compileSdk}
        versionCode = 1
        versionName = "1.0"
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:${v.composeBom}")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:${v.activityCompose}")
    implementation("androidx.navigation:navigation-compose:${v.navigationCompose}")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:${v.lifecycle}")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:${v.lifecycle}")
    implementation("androidx.datastore:datastore-preferences:${v.datastore}")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:${v.serialization}")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:${v.coroutines}")
    implementation("androidx.core:core-ktx:${v.coreKtx}")

    testImplementation("junit:junit:${v.junit}")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:${v.coroutines}")
${
  p.core
    ? androidCoreDependencies()
        .map((d) => `    ${d}`)
        .join('\n')
    : ''
}
}
`

  files['app/src/main/AndroidManifest.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="false"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${DEEP_LINK_SCHEME}" android:host="${p.packageName}" />
            </intent-filter>
        </activity>
    </application>

</manifest>
`

  files['app/src/main/res/values/strings.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${xml(p.appName)}</string>
</resources>
`

  files[`app/src/main/kotlin/${pkgPath}/MainActivity.kt`] = `package ${p.packageName}

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.navigation.NavHostController
import ${p.packageName}.data.AppStore
import ${p.packageName}.ui.AppRoot

class MainActivity : ComponentActivity() {
    private var navController: NavHostController? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applySeed(intent)
        setContent {
            AppRoot(onNavController = { navController = it })
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applySeed(intent)
        navController?.handleDeepLink(intent)
    }

    /** Debug builds accept an \`${SEED_EXTRA}\` extra: a JSON object of persisted key -> value. */
    private fun applySeed(intent: Intent?) {
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val seed = intent?.getStringExtra(AppStore.SEED_EXTRA)
        if (debuggable && seed != null) {
            AppStore.get(this).seedBlocking(seed)
        }
    }
}
`

  files[`app/src/main/kotlin/${pkgPath}/ui/AppRoot.kt`] = `package ${p.packageName}.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController

/**
 * Root of the app. testTagsAsResourceId makes every Modifier.testTag visible to
 * UI automation as a resource id, which is how the factory's flows find elements.
 *
 * Apps targeting SDK 35+ draw edge to edge, so the system status bar overlaps the top of
 * the window and swallows taps there. safeDrawingPadding keeps every control inside the
 * area that receives touches; keep it (or an equivalent Scaffold inset) on the root.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun AppRoot(onNavController: (NavHostController) -> Unit = {}) {
    val navController = rememberNavController()
    LaunchedEffect(navController) { onNavController(navController) }
    MaterialTheme {
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .semantics { testTagsAsResourceId = true }
                .testTag("mpf-root"),
        ) {
            Box(modifier = Modifier.fillMaxSize().safeDrawingPadding()) {
                AppNav(navController)
            }
        }
    }
}
`

  files[`app/src/main/kotlin/${pkgPath}/ui/AppNav.kt`] = `package ${p.packageName}.ui

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
${screens.map((s) => `import ${p.packageName}.ui.screens.${s.className}Screen`).join('\n')}

/** Routes are the AppSpec screen ids. Each screen is reachable by deep link \`${androidDeepLinkBase(p.packageName)}/<route>\`. */
object Routes {
${screens.map((s) => `    const val ${constName(s.id)} = "${s.id}"`).join('\n')}
    const val ROOT = ${constName(root.id)}
}

@Composable
fun AppNav(navController: NavHostController) {
    NavHost(navController = navController, startDestination = Routes.ROOT) {
${screens
  .map(
    (s) => `        composable(
            route = Routes.${constName(s.id)},
            deepLinks = listOf(navDeepLink { uriPattern = "${androidDeepLinkBase(p.packageName)}/${s.id}" }),
        ) { ${s.className}Screen(navController) }`,
  )
  .join('\n')}
    }
}
`

  for (const s of screens) {
    files[`app/src/main/kotlin/${pkgPath}/ui/screens/${s.className}Screen.kt`] =
      `package ${p.packageName}.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.navigation.NavHostController

/** Placeholder for the "${s.name}" screen (AppSpec id "${s.id}"). Replace the body; keep the testTag. */
@Composable
fun ${s.className}Screen(navController: NavHostController) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .testTag("screen-${s.id}"),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = ${kstr(s.name)})
    }
}
`
  }

  files[`app/src/main/kotlin/${pkgPath}/data/AppStore.kt`] = `package ${p.packageName}.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "app")

/**
 * Persistence with the same keys and JSON shapes as the source app, so data stays
 * interchangeable. Values are stored as strings; JSON documents use [json].
 */
class AppStore private constructor(private val context: Context) {

    fun string(key: String): Flow<String?> = context.dataStore.data.map { it[stringPreferencesKey(key)] }

    suspend fun getString(key: String): String? = context.dataStore.data.first()[stringPreferencesKey(key)]

    suspend fun putString(key: String, value: String?) {
        context.dataStore.edit { prefs ->
            val k = stringPreferencesKey(key)
            if (value == null) prefs.remove(k) else prefs[k] = value
        }
    }

    /**
     * Replace all state with the given JSON object of key -> value (strings stored verbatim, others as JSON).
     * DataStore's [edit] returns only once the file is written, so the seed is on disk when this returns.
     */
    suspend fun seed(jsonObject: String) {
        val obj = json.parseToJsonElement(jsonObject).jsonObject
        context.dataStore.edit { prefs ->
            prefs.clear()
            for ((key, value) in obj) {
                prefs[stringPreferencesKey(key)] = if (value is JsonPrimitive && value.isString) value.content else value.toString()
            }
        }
    }

    /** Blocks the caller (MainActivity.onCreate) until the seed is persisted, before the first frame. */
    fun seedBlocking(jsonObject: String) = runBlocking { seed(jsonObject) }

    companion object {
        const val SEED_EXTRA = "${SEED_EXTRA}"

        /** Omit nulls and defaults so encoded documents match a typical source app encoder. */
        val json: Json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = false
            explicitNulls = false
        }

        @Volatile
        private var instance: AppStore? = null

        fun get(context: Context): AppStore =
            instance ?: synchronized(this) {
                instance ?: AppStore(context.applicationContext).also { instance = it }
            }
    }
}
`

  files[`app/src/test/kotlin/${pkgPath}/ScaffoldTest.kt`] = `package ${p.packageName}

import org.junit.Assert.assertEquals
import org.junit.Test

class ScaffoldTest {
    @Test
    fun scaffoldBuildsAndTestsRun() {
        assertEquals(4, 2 + 2)
    }
}
`

  files['MPF.md'] = `# Conventions for this generated Android project

- Package: \`${p.packageName}\`. Single \`:app\` module, Kotlin, Jetpack Compose, Material 3, minSdk ${p.minSdk}, compileSdk ${p.compileSdk}.
- Build: \`./gradlew assembleDebug\`. Unit tests: \`./gradlew testDebugUnitTest\`. Keep both green.
- Routes are the AppSpec screen ids (\`ui/AppNav.kt\`). Every screen must stay reachable by deep link \`${androidDeepLinkBase(p.packageName)}/<screenId>\` (scheme and host are fixed; only the path is the screen); the factory's flows navigate that way.
- The app targets SDK ${p.compileSdk} and therefore draws edge to edge: the status bar overlaps the top of the window and swallows taps there. Keep \`safeDrawingPadding()\` (or a Scaffold that applies its insets) around everything in \`AppRoot\`; never place controls under system bars.
- Every AppSpec element gets \`Modifier.testTag("<testId>")\` on the composable a user interacts with (the button, the text field, the text). \`AppRoot\` sets \`testTagsAsResourceId\`, so tags become resource ids for UI automation. Keep \`testTag("mpf-root")\` on the root and \`testTag("screen-<id>")\` on each screen container.
- Every icon-only control (an \`IconButton\`, or a \`Button\` whose only child is an icon or a glyph such as "+") carries a human-readable \`contentDescription\` that says what it does ("Add item", "Increase count", "Close"): on the \`Icon\` (\`Icon(Icons.Default.Add, contentDescription = "Add item")\`) or, when a glyph \`Text\` stands in for the icon, on the control through \`Modifier.semantics { contentDescription = "Add item" }\`. A screen reader must announce the action, never "plus". Controls with a visible text label need no description; decorative images pass \`contentDescription = null\`.
- Persist state through \`data/AppStore.kt\` using the source app's key names and JSON shapes exactly (wire-format pins from the AppSpec). Store JSON documents as strings encoded with \`AppStore.json\`.
- Debug builds accept an \`${SEED_EXTRA}\` intent extra (JSON object of key -> value) that replaces persisted state before the UI shows; do not remove it. A seed must be persisted before the first frame: \`MainActivity.onCreate\` calls \`AppStore.seedBlocking\` before \`setContent\`, and DataStore's \`edit\` returns only once the file is written (the equivalent of \`commit()\`, never \`apply()\`); keep it blocking and on the main thread, because a flow may stop the app as soon as the root is visible and read the stored state on relaunch.
- Pure logic goes in \`logic/\` as plain Kotlin with JUnit tests in \`app/src/test\`. UI state lives in ViewModels or remembered state, never in singletons.
- Do not add dependencies that need network access at runtime unless the port plan says the integration is ported.
${p.core ? '- Shared core: see the "Shared core" section appended below; call `core/MpfCore.kt` for that logic instead of reimplementing it, and keep `CoreParityTest` green.\n' : ''}`
  return files
}

function kstr(s: string): string {
  return JSON.stringify(s)
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, "\\'")
}

function constName(id: string): string {
  const up = id.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()
  return /^[0-9]/.test(up) ? `S_${up}` : up
}
