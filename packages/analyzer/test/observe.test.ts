import { describe, expect, it } from 'vitest'
import { looseText, routeUrl } from '../src/observe/web.ts'

describe('routeUrl', () => {
  it('handles hash routes, absolute routes, relative routes, and missing screens', () => {
    const base = 'http://127.0.0.1:5000/'
    expect(
      routeUrl(base, {
        id: 'a',
        name: 'A',
        route: '#/settings',
        purpose: '',
        elements: [],
        navigatesTo: [],
      }),
    ).toBe('http://127.0.0.1:5000/#/settings')
    expect(
      routeUrl(base, {
        id: 'a',
        name: 'A',
        route: '/about',
        purpose: '',
        elements: [],
        navigatesTo: [],
      }),
    ).toBe('http://127.0.0.1:5000/about')
    expect(
      routeUrl('http://127.0.0.1:5000', {
        id: 'a',
        name: 'A',
        route: 'about',
        purpose: '',
        elements: [],
        navigatesTo: [],
      }),
    ).toBe('http://127.0.0.1:5000/about')
    expect(routeUrl(base, undefined)).toBe('http://127.0.0.1:5000/')
  })
})

describe('looseText', () => {
  it('matches across dash and quote variants, case, whitespace, and trailing parentheticals', () => {
    expect(looseText('Step size (1–10)').test('Step size (1-10)')).toBe(true)
    expect(looseText('Step size (1-10)').test('step   size (1–10)')).toBe(true)
    expect(looseText('Save').test('Save')).toBe(true)
    expect(looseText('Reset').test('Rest')).toBe(false)
    expect(looseText("Don't").test('Don’t')).toBe(true)
    expect(looseText('Count:').test('count')).toBe(true)
  })
  it('escapes regex metacharacters', () => {
    expect(looseText('+1').test('+1')).toBe(true)
    expect(looseText('+1').test('11')).toBe(false)
  })
})
