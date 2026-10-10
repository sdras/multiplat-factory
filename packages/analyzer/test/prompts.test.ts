import { describe, expect, it } from 'vitest'
import { BEHAVIORS_SYSTEM } from '../src/prompts.ts'

describe('behaviors prompt', () => {
  it('tells the worker to qualify a tap on a shared row hook by text instead of a custom step', () => {
    expect(BEHAVIORS_SYSTEM).toContain('give `tap` a `text`')
    expect(BEHAVIORS_SYSTEM).toContain('never write a custom step for a tap')
  })
})
