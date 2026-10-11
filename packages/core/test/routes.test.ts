import { describe, expect, it } from 'vitest'
import { concreteRoute, routeParameter } from '../src/schemas/appspec.ts'

describe('routeParameter', () => {
  it('finds a placeholder in the path in any of the common spellings', () => {
    expect(routeParameter('/article/[slug]')).toBe('[slug]')
    expect(routeParameter('/profile/@[user]/favorites')).toBe('[user]')
    expect(routeParameter('/items/<id>')).toBe('<id>')
    expect(routeParameter('/items/{id}')).toBe('{id}')
    expect(routeParameter('/items/:id')).toBe(':id')
    expect(routeParameter('#/active')).toBeUndefined()
    expect(routeParameter('/?tab=all|feed&tag=<tag>')).toBeUndefined()
    expect(routeParameter(undefined)).toBeUndefined()
  })
})

describe('concreteRoute', () => {
  it('drops a query string made of placeholders or alternatives and keeps a real one', () => {
    expect(concreteRoute('/?tab=all|feed&tag=<tag>&page=<n>')).toBe('/')
    expect(concreteRoute('/search?q=milk')).toBe('/search?q=milk')
    expect(concreteRoute('#/completed')).toBe('#/completed')
  })
})
