import { describe, expect, it } from 'vitest'
import type { AppSpec } from '@mpf/core'
import { behaviorsBudgetShare } from '../src/stages/behaviors.ts'
import { specBudgetShare } from '../src/stages/spec.ts'
import {
  duplicateTestIdRepairPrompt,
  duplicateTestIds,
  proseSelectorRepairPrompt,
  proseSelectors,
} from '../src/prompts.ts'

const spec = {
  screens: [
    {
      id: 'todos',
      elements: [
        { id: 'new-todo', testId: 'text-input' },
        { id: 'edit-input', testId: 'text-input', sourceSelector: 'li.editing input.edit' },
        { id: 'count', testId: 'todo-count' },
      ],
    },
    { id: 'other', elements: [{ id: 'field', testId: 'text-input' }] },
  ],
} as unknown as AppSpec

describe('duplicateTestIds', () => {
  it('lists a test id shared by several elements of one screen, not across screens', () => {
    expect(duplicateTestIds(spec)).toEqual([
      { screen: 'todos', testId: 'text-input', elements: ['new-todo', 'edit-input'] },
    ])
  })

  it('asks the worker for distinct ids and a scoped selector for the shared hook', () => {
    const prompt = duplicateTestIdRepairPrompt(duplicateTestIds(spec))
    expect(prompt).toContain('screen todos: testId "text-input" on new-todo, edit-input')
    expect(prompt).toMatch(/distinct testId/)
    expect(prompt).toMatch(/sourceSelector scoped by an ancestor/)
  })
})

describe('proseSelectors', () => {
  const mobile = {
    screens: [
      {
        id: 'tasks',
        elements: [
          {
            id: 'filter-active',
            testId: 'filter-active',
            sourceSelector: 'Popup menu item with resource id `active`; opens from the filter icon',
          },
          { id: 'drawer', testId: 'drawer-button', sourceSelector: 'Open navigation drawer' },
          { id: 'save', testId: 'save', sourceSelector: 'Save' },
          {
            id: 'row',
            testId: 'task-row',
            sourceSelector: 'clickable row LinearLayout inside tasks_list',
          },
        ],
      },
    ],
  } as unknown as AppSpec

  it('flags explanations on mobile and keeps captions and content descriptions', () => {
    expect(proseSelectors(mobile, 'android').map((p) => p.element)).toEqual([
      'filter-active',
      'row',
    ])
    expect(proseSelectors(mobile, 'web')).toEqual([])
  })

  it('asks for the exact caption or content description, or no selector at all', () => {
    const prompt = proseSelectorRepairPrompt(proseSelectors(mobile, 'android'))
    expect(prompt).toContain('screen tasks, element filter-active')
    expect(prompt).toMatch(/exactly the text shown on screen or the content description/)
  })
})

describe('specBudgetShare', () => {
  it('grows with the inventory and caps at 35%', () => {
    expect(specBudgetShare(40)).toBe(0.15)
    expect(specBudgetShare(150)).toBe(0.15)
    expect(specBudgetShare(250)).toBeCloseTo(0.25)
    expect(specBudgetShare(551)).toBe(0.35)
  })
})

describe('behaviorsBudgetShare', () => {
  it('grows with the number of elements in the spec and caps at 35%', () => {
    const withElements = (n: number) => ({
      screens: [{ elements: Array.from({ length: n }, () => 0) }],
    })
    expect(behaviorsBudgetShare(withElements(20))).toBe(0.15)
    expect(behaviorsBudgetShare(withElements(60))).toBe(0.15)
    expect(behaviorsBudgetShare(withElements(100))).toBeCloseTo(0.25)
    expect(behaviorsBudgetShare(withElements(400))).toBe(0.35)
  })
})
