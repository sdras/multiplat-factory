import { describe, expect, it } from 'vitest'
import type { AppSpec, Platform, PortPlan } from '@mpf/core'
import { coreExtractPrompt, executedVectorsGuidance, vectorsPrompt } from '../src/prompts.ts'

function specFor(platform: Platform): AppSpec {
  return {
    name: 'Cart',
    source: { platform, framework: 'generic', language: 'x', entry: 'main' },
    screens: [{ id: 'home', name: 'Home', purpose: 'p', elements: [], navigatesTo: [] }],
    navigation: { style: 'single', root: 'home', edges: [] },
    state: { entities: {}, storeStyle: 'none', persistence: [] },
    logic: [
      {
        id: 'L1',
        file: 'pricing',
        symbol: 'computeTotal',
        purity: 'pure',
        loc: 12,
        inputs: 'items',
        outputs: 'total',
        description: 'Sum line items',
        coreCandidate: true,
      },
    ],
    integrations: [],
    assets: [],
    permissions: [],
    platformFeatures: [],
    unknowns: [],
  }
}

const plan: PortPlan = {
  targets: [
    {
      target: 'web',
      uiFramework: 'vanilla',
      layout: 'vite',
      screenMap: [],
      stateStrategy: 'store',
      persistenceMap: [],
      integrationMap: [],
      deviations: [],
    },
  ],
  core: {
    enabled: true,
    rationale: 'pure pricing',
    functions: [
      {
        name: 'computeTotal',
        description: 'Sum line items',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'number' },
        sourceSymbols: ['pricing:computeTotal'],
      },
    ],
  },
  testPlan: { unit: [], e2e: [], parity: [] },
  estimate: { stages: 1, costUsd: 1, minutes: 1 },
  questionsForHuman: [],
}

describe('executed-vector guidance', () => {
  it('tells an iOS worker to compile a swiftc harness and keep UI-bound files derived', () => {
    const text = executedVectorsGuidance('ios')
    expect(text).toContain('swiftc -o harness')
    expect(text).toContain('xcrun swiftc')
    expect(text).toContain('./harness')
    expect(text).toContain('main.swift')
    expect(text).toContain('UIKit')
    expect(text).toContain('"derived"')
    expect(text).not.toContain('kotlinc')
  })

  it('tells an Android worker to compile with kotlinc or javac and run through java', () => {
    const text = executedVectorsGuidance('android')
    expect(text).toContain('kotlinc')
    expect(text).toContain('-include-runtime -d harness.jar')
    expect(text).toContain('java -jar harness.jar')
    expect(text).toContain('javac -d out')
    expect(text).toContain('java -cp out Main')
    expect(text).toContain('androidx.*')
    expect(text).toContain('"derived"')
    expect(text).not.toContain('swiftc')
  })

  it('keeps the web guidance on node and never names an app framework', () => {
    const text = executedVectorsGuidance('web')
    expect(text).toContain('`node`')
    expect(text).toContain('npx tsx')
    for (const p of ['web', 'ios', 'android'] as const) {
      expect(executedVectorsGuidance(p)).not.toMatch(/React|Vue|Svelte|Angular|Next|Nuxt/)
    }
  })

  it('reaches both the extraction and the vectors worker for the source platform', () => {
    const extract = coreExtractPrompt({
      spec: specFor('ios'),
      plan,
      sourceDir: '/runs/x/source',
      instructions: [],
    })
    expect(extract).toContain('swiftc')
    expect(extract).not.toContain('kotlinc')
    const vectors = vectorsPrompt({
      functions: plan.core.functions,
      spec: specFor('android'),
      sourceDir: '/runs/x/source',
      instructions: [],
    })
    expect(vectors).toContain('kotlinc')
    expect(vectors).not.toContain('swiftc')
    expect(
      vectorsPrompt({
        functions: plan.core.functions,
        spec: specFor('web'),
        sourceDir: '/runs/x/source',
        instructions: [],
      }),
    ).toContain('`node`')
  })
})
