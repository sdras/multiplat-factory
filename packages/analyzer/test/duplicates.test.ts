import { describe, expect, it } from 'vitest'
import type { AppSpec } from '@mpf/core'
import { duplicateTestIdRepairPrompt, duplicateTestIds } from '../src/prompts.ts'

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
