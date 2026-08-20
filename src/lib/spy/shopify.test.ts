import { describe, it, expect } from 'vitest'
import { normalizeStoreUrl, normalizeDomain, tagsToArray, priceSummary, externalProductId } from './shopify'

describe('spy shopify helpers', () => {
  it('normalizeStoreUrl adds protocol and strips path', () => {
    expect(normalizeStoreUrl('foo.com/collections/all')).toBe('https://foo.com')
  })
  it('normalizeStoreUrl rejects private hosts', () => {
    expect(() => normalizeStoreUrl('192.168.0.1')).toThrow()
    expect(() => normalizeStoreUrl('localhost')).toThrow()
  })
  it('normalizeDomain returns bare lowercased host', () => {
    expect(normalizeDomain('https://Foo.com/')).toBe('foo.com')
    expect(normalizeDomain('foo.com')).toBe('foo.com')
  })
  it('tagsToArray splits strings and passes arrays', () => {
    expect(tagsToArray('a, b ,c')).toEqual(['a','b','c'])
    expect(tagsToArray(['x','y'])).toEqual(['x','y'])
  })
  it('priceSummary returns min/max', () => {
    expect(priceSummary([{ price: '10' }, { price: '25' }])).toEqual({ min: 10, max: 25 })
    expect(priceSummary([])).toBeNull()
  })
  it('externalProductId prefers numeric id, falls back to handle', () => {
    expect(externalProductId({ id: 123, handle: 'h' } as any)).toBe('123')
    expect(externalProductId({ handle: 'h' } as any)).toBe('handle:h')
  })
})
