import { z } from 'zod'
import { Platform } from './common.ts'

export const ElementKind = z.enum([
  'text',
  'input',
  'button',
  'link',
  'list',
  'toggle',
  'image',
  'picker',
  'slider',
  'chart',
  'custom',
])

export const Element = z.object({
  id: z.string().describe('Stable id, used as the cross-platform test hook'),
  kind: ElementKind,
  label: z.string().describe('Visible label or accessible name'),
  testId: z
    .string()
    .describe(
      'Value for data-testid / accessibilityIdentifier / testTag; the hook every port adds',
    ),
  sourceSelector: z
    .string()
    .optional()
    .describe(
      'How to find this element on the original app when it has no test hook: a CSS selector for web (class, id, placeholder, role); the visible label text for mobile',
    ),
  bindsTo: z.string().optional().describe('State path this element reads or writes'),
  action: z.string().optional().describe('What interacting does, in plain words'),
})

export const Screen = z.object({
  id: z.string(),
  name: z.string(),
  route: z.string().optional(),
  purpose: z.string(),
  elements: z.array(Element),
  navigatesTo: z.array(z.string()).default([]),
})

export const PersistenceMechanism = z.enum([
  'localstorage',
  'sessionstorage',
  'indexeddb',
  'cookies',
  'userdefaults',
  'keychain',
  'coredata',
  'swiftdata',
  'datastore',
  'sharedprefs',
  'room',
  'sqlite',
  'file',
  'remote',
  'memory',
])

export const PersistedKey = z.object({
  key: z.string(),
  shape: z.string().describe('JSON shape or type description'),
  wireFormatPins: z
    .array(z.string())
    .default([])
    .describe('Formats that must not change, e.g. date keys, id casing'),
})

export const LogicUnit = z.object({
  id: z.string(),
  file: z.string(),
  symbol: z.string(),
  purity: z.enum(['pure', 'io', 'ui']),
  loc: z.number().int().nonnegative(),
  inputs: z.string(),
  outputs: z.string(),
  description: z.string(),
  coreCandidate: z.boolean(),
})

export const IntegrationKind = z.enum([
  'auth',
  'db',
  'analytics',
  'push',
  'payments',
  'http-api',
  'maps',
  'storage',
  'ads',
  'ml',
  'other',
])

export const Integration = z.object({
  kind: IntegrationKind,
  vendor: z.string().optional(),
  required: z.boolean(),
  sourceFiles: z.array(z.string()).default([]),
  notes: z.string().optional(),
})

export const AppSpec = z.object({
  name: z.string(),
  source: z.object({
    platform: Platform,
    framework: z.string(),
    language: z.string(),
    entry: z.string().describe('Entry file or scheme/module'),
  }),
  screens: z.array(Screen).min(1),
  navigation: z.object({
    style: z.enum(['stack', 'tabs', 'drawer', 'routes', 'single', 'mixed']),
    root: z.string(),
    edges: z.array(z.object({ from: z.string(), to: z.string(), trigger: z.string() })).default([]),
  }),
  state: z.object({
    entities: z.record(z.string(), z.string()).describe('entity name -> shape description'),
    storeStyle: z.string(),
    persistence: z.array(
      z.object({ mechanism: PersistenceMechanism, keys: z.array(PersistedKey) }),
    ),
  }),
  logic: z.array(LogicUnit).default([]),
  integrations: z.array(Integration).default([]),
  assets: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  theming: z.string().optional(),
  i18n: z.string().optional(),
  platformFeatures: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
})
export type AppSpec = z.infer<typeof AppSpec>
export type Screen = z.infer<typeof Screen>
export type Element = z.infer<typeof Element>
export type LogicUnit = z.infer<typeof LogicUnit>
