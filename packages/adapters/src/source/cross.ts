import type { SourceAdapter } from '../types.ts'

/**
 * Cross-platform sources are recognized so the factory can say clearly that they are
 * not supported yet, instead of misclassifying them as plain web or mobile projects.
 * Implementing one means: a detector, analysis hints, and an observe() that runs the app.
 */
const NOT_YET = 'is recognized but not supported in this build; see docs/ADAPTERS.md to add it'

export const flutter: SourceAdapter = {
  id: 'cross-flutter',
  platform: 'web',
  async detect(ctx) {
    const pubspec = ctx.read('pubspec.yaml')
    if (!pubspec || !/flutter:/.test(pubspec)) return undefined
    return {
      adapterId: 'cross-flutter',
      platform: 'web',
      framework: 'flutter',
      language: 'dart',
      entry: 'lib/main.dart',
      score: 0.99,
      evidence: ['pubspec.yaml with flutter'],
      supported: false,
      unsupportedReason: `Flutter ${NOT_YET}`,
    }
  },
}

export const reactNative: SourceAdapter = {
  id: 'cross-react-native',
  platform: 'web',
  async detect(ctx) {
    if (!ctx.deps['react-native']) return undefined
    return {
      adapterId: 'cross-react-native',
      platform: 'web',
      framework: ctx.deps.expo ? 'expo' : 'react-native',
      language: ctx.files.some((f) => /\.tsx?$/.test(f)) ? 'typescript' : 'javascript',
      entry: ctx.exists('App.tsx') ? 'App.tsx' : 'index.js',
      score: 0.99,
      evidence: ['react-native in dependencies'],
      supported: false,
      unsupportedReason: `React Native ${NOT_YET}`,
    }
  },
}

export const capacitor: SourceAdapter = {
  id: 'cross-capacitor',
  platform: 'web',
  async detect(ctx) {
    if (!ctx.deps['@capacitor/core']) return undefined
    return {
      adapterId: 'cross-capacitor',
      platform: 'web',
      framework: 'capacitor',
      language: ctx.files.some((f) => /\.tsx?$/.test(f)) ? 'typescript' : 'javascript',
      entry: 'capacitor.config',
      score: 0.98,
      evidence: ['@capacitor/core in dependencies'],
      supported: false,
      unsupportedReason: `Capacitor ${NOT_YET} (the inner web app can be ported by pointing at its web root)`,
    }
  },
}

export const CROSS_PLATFORM_ADAPTERS: SourceAdapter[] = [flutter, reactNative, capacitor]
