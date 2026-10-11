import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative } from 'pathe'
import { Language, Parser, type Node } from 'web-tree-sitter'
import type { AnalysisHints, FileRole, Inventory, InventoryFile, SourceSymbol } from '@mpf/core'

const require = createRequire(import.meta.url)

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  'DerivedData',
  '.gradle',
  'target',
  'coverage',
  '.turbo',
  '.cache',
  'Pods',
  '.dart_tool',
  '.idea',
  '.vscode',
  'vendor',
  '__pycache__',
  '.venv',
])

const LANG_BY_EXT: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.java': 'java',
  '.m': 'objc',
  '.mm': 'objc',
  '.h': 'objc',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.dart': 'dart',
  '.py': 'python',
  '.xml': 'xml',
  '.plist': 'plist',
  '.storyboard': 'storyboard',
  '.xib': 'xib',
  '.gradle': 'gradle',
  '.toml': 'toml',
}

/** Grammar per language; vue/svelte scripts are parsed with the typescript grammar. */
const GRAMMAR_FOR: Record<string, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  tsx: 'tsx',
  vue: 'typescript',
  svelte: 'typescript',
  swift: 'swift',
  kotlin: 'kotlin',
  java: 'java',
  objc: 'objc',
}

/** Node types that count as symbols, per grammar, with a normalized kind label. */
const SYMBOL_TYPES: Record<string, Record<string, string>> = {
  javascript: {
    function_declaration: 'function',
    class_declaration: 'class',
    lexical_declaration: 'const',
    variable_declaration: 'var',
    generator_function_declaration: 'function',
  },
  typescript: {
    function_declaration: 'function',
    class_declaration: 'class',
    lexical_declaration: 'const',
    variable_declaration: 'var',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    enum_declaration: 'enum',
    abstract_class_declaration: 'class',
  },
  tsx: {
    function_declaration: 'function',
    class_declaration: 'class',
    lexical_declaration: 'const',
    variable_declaration: 'var',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    enum_declaration: 'enum',
  },
  swift: {
    function_declaration: 'function',
    class_declaration: 'type',
    protocol_declaration: 'protocol',
    property_declaration: 'property',
    typealias_declaration: 'type',
  },
  kotlin: {
    function_declaration: 'function',
    class_declaration: 'class',
    object_declaration: 'object',
    property_declaration: 'property',
    type_alias: 'type',
  },
  java: {
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    record_declaration: 'record',
    method_declaration: 'method',
  },
  objc: {
    class_interface: 'interface',
    class_implementation: 'class',
    function_definition: 'function',
    method_definition: 'method',
    protocol_declaration: 'protocol',
  },
}

const IMPORT_TYPES = [
  'import_statement',
  'import_declaration',
  'import_header',
  'preproc_import',
  'preproc_include',
]
const NAME_TYPES = ['identifier', 'simple_identifier', 'type_identifier', 'property_identifier']
const BODY_TYPES = [
  'class_declaration',
  'class_implementation',
  'object_declaration',
  'abstract_class_declaration',
]

const ASSET_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.mp3',
  '.mp4',
  '.pdf',
  '.psd',
])

interface Pattern {
  label: string
  re: RegExp
}

const PERSISTENCE: Pattern[] = [
  { label: 'localStorage', re: /\blocalStorage\b/ },
  { label: 'sessionStorage', re: /\bsessionStorage\b/ },
  { label: 'indexedDB', re: /\bindexedDB\b|\bidb\b/ },
  { label: 'cookies', re: /document\.cookie|\bcookies?\(/ },
  { label: 'UserDefaults', re: /\b(?:NS)?UserDefaults\b|@AppStorage|@SceneStorage/ },
  { label: 'SwiftData', re: /\bSwiftData\b|@Model\b|ModelContainer/ },
  { label: 'CoreData', re: /\bCoreData\b|NSManagedObject|NSPersistentContainer/ },
  { label: 'Keychain', re: /\bKeychain\b|SecItemAdd/ },
  { label: 'DataStore', re: /\bDataStore\b|preferencesDataStore/ },
  { label: 'SharedPreferences', re: /\bSharedPreferences\b/ },
  { label: 'Room', re: /androidx\.room|@Dao\b|@Entity\b/ },
  { label: 'SQLite', re: /\bsqlite3?\b|SQLiteDatabase/i },
]

const INTEGRATIONS: Pattern[] = [
  { label: 'firebase', re: /\bfirebase\b|FirebaseCore|FirebaseFirestore/i },
  { label: 'supabase', re: /\bsupabase\b/i },
  { label: 'payments', re: /\bstripe\b|StoreKit|BillingClient/i },
  { label: 'analytics', re: /\banalytics\b|amplitude|mixpanel|posthog/i },
  { label: 'error-reporting', re: /\bsentry\b|crashlytics|bugsnag/i },
  { label: 'maps', re: /\bMapKit\b|google\.maps|mapbox|GoogleMap\b/ },
  {
    label: 'auth',
    re: /AuthenticationServices|GoogleSignIn|@auth\/|next-auth|clerk|auth0|FirebaseAuth/,
  },
  {
    label: 'http-api',
    re: /\bfetch\(|\baxios\b|URLSession|OkHttp|Retrofit|\bky\b|graphql|apollo/i,
  },
  {
    label: 'push',
    re: /UNUserNotificationCenter|FirebaseMessaging|PushNotification|serviceWorker\.register/,
  },
]

const STATE: Pattern[] = [
  { label: 'redux', re: /\bredux\b|@reduxjs/i },
  { label: 'zustand', re: /\bzustand\b/ },
  { label: 'pinia/vuex', re: /\bpinia\b|\bvuex\b/ },
  { label: 'mobx', re: /\bmobx\b/ },
  { label: 'signals', re: /\bsignal\(|createSignal|\$state\b/ },
  {
    label: 'swift-observation',
    re: /@Observable\b|ObservableObject|@StateObject|@EnvironmentObject/,
  },
  { label: 'viewmodel', re: /ViewModel\b|StateFlow|LiveData/ },
]

const ROUTES: Pattern[] = [
  { label: 'react-router', re: /react-router|createBrowserRouter|<Route\b/ },
  { label: 'vue-router', re: /vue-router|createRouter\(/ },
  { label: 'hash-routing', re: /location\.hash|hashchange/ },
  { label: 'history-api', re: /pushState\(|popstate/ },
  {
    label: 'swiftui-navigation',
    re: /NavigationStack|NavigationView|NavigationLink|TabView|\.sheet\(|\.fullScreenCover\(/,
  },
  {
    label: 'uikit-navigation',
    re: /UINavigationController|UITabBarController|performSegue|pushViewController/,
  },
  { label: 'compose-navigation', re: /NavHost\b|composable\(|rememberNavController/ },
  {
    label: 'android-intents',
    re: /startActivity\(|Intent\(|FragmentTransaction|findNavController/,
  },
]

let parserReady: Promise<void> | undefined
const languages = new Map<string, Promise<Language>>()

/** `tree-sitter-wasm` ships grammars as out/<lang>/tree-sitter-<lang>.wasm next to its index.js. */
function grammarDir(): string {
  return join(dirname(require.resolve('tree-sitter-wasm')), 'out')
}

async function loadLanguage(name: string): Promise<Language> {
  parserReady ??= Parser.init()
  await parserReady
  let p = languages.get(name)
  if (!p) {
    p = Language.load(join(grammarDir(), name, `tree-sitter-${name}.wasm`))
    languages.set(name, p)
  }
  return p
}

export interface BuildInventoryOptions {
  maxFiles?: number
  maxFileBytes?: number
  /** Adapter-provided hints merged into the result. */
  hints?: Partial<AnalysisHints>
  framework?: string
}

/** Walk a source tree, classify files, parse symbols with tree-sitter, and collect hints. */
export async function buildInventory(
  root: string,
  opts: BuildInventoryOptions = {},
): Promise<Inventory> {
  const maxFiles = opts.maxFiles ?? 3000
  const maxBytes = opts.maxFileBytes ?? 512 * 1024
  const files: InventoryFile[] = []
  const skipped: string[] = []
  const testHooks = new Set<string>()
  const hits = {
    persistence: new Map<string, number>(),
    integration: new Map<string, number>(),
    state: new Map<string, number>(),
    route: new Map<string, number>(),
  }
  const routeFiles: string[] = []
  const entryFiles = new Set(opts.hints?.entryFiles ?? [])

  const all: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(abs)
      else if (all.length < maxFiles) all.push(abs)
      else skipped.push(relative(root, abs))
    }
  }
  walk(root)

  for (const abs of all) {
    const rel = relative(root, abs)
    const ext = extname(rel).toLowerCase()
    const language = LANG_BY_EXT[ext] ?? (ASSET_EXT.has(ext) ? 'asset' : 'other')
    if (language === 'asset' || classify(rel, language) === 'asset') {
      files.push({
        path: rel,
        language: 'asset',
        loc: 0,
        role: 'asset',
        symbols: [],
        imports: [],
        parsed: false,
      })
      continue
    }
    let text: string
    try {
      if (statSync(abs).size > maxBytes) {
        skipped.push(`${rel} (too large)`)
        continue
      }
      text = readFileSync(abs, 'utf8')
    } catch {
      skipped.push(rel)
      continue
    }
    const role = classify(rel, language, text)
    const lines = text.split('\n')
    const loc = lines.filter((l) => l.trim().length > 0).length
    const minified = loc > 0 && text.length / Math.max(1, lines.length) > 300
    const entry: InventoryFile = {
      path: rel,
      language,
      loc,
      role,
      symbols: [],
      imports: [],
      parsed: false,
    }
    const scan = ['entry', 'component', 'route', 'state', 'logic', 'other'].includes(role)
    if (!minified && scan) {
      for (const p of PERSISTENCE)
        if (p.re.test(text)) bump(hits.persistence, `${p.label} @ ${rel}`)
      for (const p of INTEGRATIONS)
        if (p.re.test(text)) bump(hits.integration, `${p.label} @ ${rel}`)
      for (const p of STATE) if (p.re.test(text)) bump(hits.state, `${p.label} @ ${rel}`)
      for (const p of ROUTES) if (p.re.test(text)) bump(hits.route, `${p.label} @ ${rel}`)
      for (const re of TEST_HOOKS)
        for (const m of text.matchAll(re))
          if (m[1] && testHooks.size < 400) testHooks.add(normalizeHook(m[1]))
      if (HTML_ID_LANGUAGES.has(language))
        for (const m of text.matchAll(HTML_ID))
          if (m[1] && testHooks.size < 400) testHooks.add(normalizeHook(m[1]))
    }
    if (role === 'route') routeFiles.push(rel)
    if (role === 'entry') entryFiles.add(rel)
    const grammar = GRAMMAR_FOR[language]
    if (grammar && !minified) {
      try {
        const { symbols, imports } = await parseSymbols(text, language, grammar)
        entry.symbols = symbols
        entry.imports = imports
        entry.parsed = true
      } catch (err) {
        skipped.push(`${rel} (parse: ${(err as Error).message})`)
      }
    }
    files.push(entry)
  }

  const byLanguage: Record<string, number> = {}
  const byRole: Record<string, number> = {}
  let loc = 0
  for (const f of files) {
    byLanguage[f.language] = (byLanguage[f.language] ?? 0) + 1
    byRole[f.role] = (byRole[f.role] ?? 0) + 1
    loc += f.loc
  }
  const top = (m: Map<string, number>, n = 40) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => (v > 1 ? `${k} (${v})` : k))

  return {
    root,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    totals: { files: files.length, loc, byLanguage, byRole },
    hints: {
      framework: opts.framework ?? opts.hints?.framework ?? 'unknown',
      entryFiles: [...entryFiles],
      routeHints: [
        ...(opts.hints?.routeHints ?? []),
        ...routeFiles.slice(0, 60).map((f) => `route file: ${f}`),
        ...top(hits.route),
      ],
      stateHints: [...(opts.hints?.stateHints ?? []), ...top(hits.state)],
      persistenceHints: [...(opts.hints?.persistenceHints ?? []), ...top(hits.persistence)],
      integrationHints: [...(opts.hints?.integrationHints ?? []), ...top(hits.integration)],
      testHooks: [...new Set([...(opts.hints?.testHooks ?? []), ...testHooks])].sort(),
      notes: opts.hints?.notes ?? [],
    },
    skipped,
  }
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

const CONFIG_FILES =
  /^(package\.json|tsconfig.*|vite\.config.*|next\.config.*|nuxt\.config.*|svelte\.config.*|angular\.json|.*\.gradle(\.kts)?|settings\.gradle.*|gradle\.properties|local\.properties|proguard.*|podfile|package\.swift|info\.plist|.*\.entitlements|.*\.xcconfig|.*\.plist|eslint.*|prettier.*|\.babelrc|babel\.config.*|jest\.config.*|vitest\.config.*|playwright\.config.*|tailwind\.config.*|postcss\.config.*|manifest\.json|androidmanifest\.xml|project\.pbxproj)$/

/** Test hooks the source already exposes; the AppSpec must reuse them as element testIds. */
const TEST_HOOKS: RegExp[] = [
  /data-testid=["']([^"'{}$]+)["']/g,
  /\btestID=["']([^"'{}$]+)["']/g,
  // SwiftUI modifier and UIKit assignment
  /accessibilityIdentifier\(\s*["']([^"']+)["']/g,
  /accessibilityIdentifier\s*=\s*@?["']([^"']+)["']/g,
  // Objective-C setter and literal forms: `[x setAccessibilityIdentifier:@"id"]`, `.accessibilityIdentifier = @"id"`
  /setAccessibilityIdentifier:\s*@?["']([^"']+)["']/g,
  // Objective-C format strings: `cell.accessibilityIdentifier = [NSString stringWithFormat:@"note-row-%ld", row]`
  /accessibilityIdentifier\s*=\s*\[NSString stringWithFormat:\s*@"([^"]+)"/g,
  // Compose modifier and semantics block
  /\.testTag\(\s*["']([^"']+)["']/g,
  /\btestTag\s*=\s*["']([^"']+)["']/g,
  // Components that take the hook as a named argument or prop (`testId = "nav-counter"`, `testId: 'x'`)
  /\btestId\s*[=:]\s*["']([^"']+)["']/g,
  /android:id="@\+id\/([^"]+)"/g,
]

/**
 * Web markup where an HTML `id` attribute is a stable hook a test can address (`#toggle-all`).
 * Storyboards and Android layouts carry ids of their own kind, handled above; placeholders are
 * copy, not hooks, and stay out.
 */
const HTML_ID_LANGUAGES = new Set(['html', 'vue', 'svelte', 'javascript', 'typescript', 'tsx'])
/** `id="toggle-all"` in markup or a template literal; not `data-testid=`, `android:id=`, a bound `:id=`, or `el.id=`. */
const HTML_ID = /(?<![\w:.-])id=["']([^"'{}$]+)["']/g

/** `note-row-\(indexPath.row)` and `row-${id}` become `note-row-<indexPath.row>` and `row-<id>`, the spec's placeholder form. */
function normalizeHook(hook: string): string {
  return hook
    .replace(/%(?:l{0,2}[di]|[@su])/g, '<arg>')
    .replace(/\\\(([^)]*)\)/g, '<$1>')
    .replace(/\$\{([^}]*)\}/g, '<$1>')
    .replace(/\$(\w+)/g, '<$1>')
}

/** Source that touches no UI or platform API is logic wherever it lives; the core candidacy looks for it. */
const UI_MARKERS =
  /\b(document|window|navigator|localStorage|sessionStorage|fetch|XMLHttpRequest)\b|from ['"](react|vue|svelte|@angular|solid-js|lit)|import (SwiftUI|UIKit|AppKit)\b|androidx\.|android\.(content|view|widget|os)\b|@Composable|\bView\b.*\{/

export function classify(rel: string, language: string, text?: string): FileRole {
  const byPath = classifyByPath(rel, language)
  if (byPath !== 'other' || !text) return byPath
  if (!['javascript', 'typescript', 'kotlin', 'java', 'swift'].includes(language)) return byPath
  const body = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  return UI_MARKERS.test(body) ? byPath : 'logic'
}

function classifyByPath(rel: string, language: string): FileRole {
  const lower = rel.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  if (/\.(test|spec)\.|__tests__\/|(^|\/)tests?\/|androidtest\/|uitests?\//.test(lower))
    return 'test'
  if (language === 'asset') return 'asset'
  if (language === 'css') return 'style'
  if (CONFIG_FILES.test(base)) return 'config'
  if (['json', 'yaml', 'toml', 'markdown', 'plist', 'gradle'].includes(language)) return 'config'
  if (
    /(^|\/)(pages|routes|screens|views|features)\//.test(lower) ||
    /(^|\/)app\/.*page\.(tsx|jsx|ts|js|vue)$/.test(lower) ||
    /\+page\.svelte$/.test(lower)
  )
    return 'route'
  if (
    /(^|\/)(store|stores|state|redux|slices|reducers|viewmodels?)\//.test(lower) ||
    /viewmodel\.(kt|java|swift)$/.test(base) ||
    /store\.(t|j)sx?$/.test(base)
  )
    return 'state'
  if (/(^|\/)(utils?|lib|helpers?|logic|domain|services?|core|models?|data|api)\//.test(lower))
    return 'logic'
  if (
    /^(main|index|app)\.(tsx?|jsx?|vue|svelte)$/.test(base) ||
    /app\.swift$/.test(base) ||
    /appdelegate\.(swift|m)$/.test(base) ||
    /mainactivity\.(kt|java)$/.test(base) ||
    /application\.(kt|java)$/.test(base) ||
    base === 'index.html'
  )
    return 'entry'
  if (
    /(^|\/)(components?|ui|widgets|layouts?)\//.test(lower) ||
    /\.(vue|svelte)$/.test(base) ||
    (/\.(tsx|jsx)$/.test(base) && /^[a-z]/.test(base) === false) ||
    /(view|screen|activity|fragment|controller)\.(swift|kt|java)$/.test(base)
  )
    return 'component'
  if (['html', 'xml', 'storyboard', 'xib'].includes(language)) return 'component'
  return 'other'
}

async function parseSymbols(
  text: string,
  language: string,
  grammar: string,
): Promise<{ symbols: SourceSymbol[]; imports: string[] }> {
  let source = text
  let lineOffset = 0
  if (language === 'vue' || language === 'svelte') {
    const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(text)
    if (!m || m.index === undefined) return { symbols: [], imports: [] }
    lineOffset = text.slice(0, m.index).split('\n').length - 1
    source = m[1] ?? ''
  }
  const lang = await loadLanguage(grammar)
  const parser = new Parser()
  parser.setLanguage(lang)
  const tree = parser.parse(source)
  if (!tree) {
    parser.delete()
    return { symbols: [], imports: [] }
  }
  const kinds = SYMBOL_TYPES[grammar] ?? {}
  const symbols: SourceSymbol[] = []

  const record = (node: Node, kind: string, exported: boolean) => {
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const d of node.namedChildren) {
        if (d?.type !== 'variable_declarator') continue
        const name = nameOf(d)
        if (!name) continue
        const isFn = /=>|\bfunction\b/.test(d.text.slice(0, 200))
        symbols.push({
          name,
          kind: isFn ? 'function' : kind,
          line: d.startPosition.row + 1 + lineOffset,
          exported,
        })
      }
      return
    }
    const name = nameOf(node)
    if (!name) return
    const visible = exported || /\b(public|open)\b/.test(node.text.slice(0, 80))
    symbols.push({ name, kind, line: node.startPosition.row + 1 + lineOffset, exported: visible })
  }

  const visitChildren = (children: (Node | null)[], exported: boolean, depth: number) => {
    for (const child of children) {
      if (!child || symbols.length > 400) continue
      if (child.type === 'export_statement') {
        const decl = child.childForFieldName('declaration')
        if (decl) visitChildren([decl], true, depth)
        continue
      }
      const kind = kinds[child.type]
      if (!kind) continue
      record(child, kind, exported)
      if (depth === 0 && BODY_TYPES.includes(child.type)) {
        const body =
          child.childForFieldName('body') ??
          child.namedChildren.find((c) => c && /body/.test(c.type)) ??
          null
        if (body) visitChildren(body.namedChildren, false, depth + 1)
      }
    }
  }
  visitChildren(tree.rootNode.namedChildren, false, 0)

  const imports = tree.rootNode
    .descendantsOfType(IMPORT_TYPES)
    .slice(0, 60)
    .map((n) => n?.text.split('\n')[0]?.trim() ?? '')
    .filter(Boolean)
  tree.delete()
  parser.delete()
  return { symbols, imports }
}

function nameOf(node: Node): string | undefined {
  const field = node.childForFieldName('name')
  if (field?.text) return field.text
  for (const c of node.namedChildren) {
    if (c && NAME_TYPES.includes(c.type)) return c.text
  }
  return undefined
}

/** Compact, LLM-friendly rendering of an inventory (bounded size). */
export function summarizeInventory(inv: Inventory, maxFiles = 220): string {
  const lines: string[] = []
  lines.push(`Root: ${inv.root}`)
  lines.push(`Files: ${inv.totals.files}, non-blank lines: ${inv.totals.loc}`)
  lines.push(
    `By language: ${Object.entries(inv.totals.byLanguage)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  )
  lines.push(
    `By role: ${Object.entries(inv.totals.byRole)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  )
  const order: FileRole[] = [
    'entry',
    'route',
    'component',
    'state',
    'logic',
    'other',
    'test',
    'config',
    'style',
  ]
  let shown = 0
  for (const role of order) {
    const group = inv.files.filter((f) => f.role === role && f.language !== 'asset')
    if (!group.length) continue
    lines.push(`\n## ${role} (${group.length})`)
    for (const f of group) {
      if (shown++ >= maxFiles) {
        lines.push(`… ${inv.totals.files - shown} more files omitted`)
        break
      }
      const syms = f.symbols
        .slice(0, 12)
        .map((s) => `${s.exported ? 'export ' : ''}${s.kind} ${s.name}`)
        .join(', ')
      lines.push(`- ${f.path} (${f.language}, ${f.loc} loc)${syms ? `: ${syms}` : ''}`)
    }
  }
  const h = inv.hints
  lines.push('\n## hints')
  lines.push(`framework: ${h.framework}`)
  if (h.entryFiles.length) lines.push(`entry: ${h.entryFiles.join(', ')}`)
  if (h.routeHints.length) lines.push(`routes: ${h.routeHints.slice(0, 40).join('; ')}`)
  if (h.stateHints.length) lines.push(`state: ${h.stateHints.slice(0, 20).join('; ')}`)
  if (h.persistenceHints.length)
    lines.push(`persistence: ${h.persistenceHints.slice(0, 20).join('; ')}`)
  if (h.integrationHints.length)
    lines.push(`integrations: ${h.integrationHints.slice(0, 20).join('; ')}`)
  for (const n of h.notes) lines.push(`note: ${n}`)
  return lines.join('\n')
}
