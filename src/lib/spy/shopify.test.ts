import { describe, it, expect } from 'vitest'
import { normalizeStoreUrl, normalizeDomain, tagsToArray, priceSummary, externalProductId, mapShopifyProduct } from './shopify'

describe('spy shopify helpers', () => {
  it('normalizeStoreUrl adds protocol and strips path', () => {
    expect(normalizeStoreUrl('foo.com/collections/all')).toBe('https://foo.com')
  })
  it('normalizeStoreUrl rejects private hosts', () => {
    expect(() => normalizeStoreUrl('192.168.0.1')).toThrow()
    expect(() => normalizeStoreUrl('localhost')).toThrow()
  })
  it('normalizeStoreUrl rejects cloud metadata endpoint (169.254.x)', () => {
    expect(() => normalizeStoreUrl('169.254.169.254')).toThrow()
  })
  it('normalizeStoreUrl rejects IPv6 loopback ::1', () => {
    expect(() => normalizeStoreUrl('http://[::1]/')).toThrow()
  })
  it('normalizeStoreUrl rejects IPv6-mapped IPv4 loopback ::ffff:127.0.0.1', () => {
    expect(() => normalizeStoreUrl('http://[::ffff:127.0.0.1]/')).toThrow()
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

describe('mapShopifyProduct', () => {
  it('maps fields and derives publishedAt/dateSource', () => {
    const raw = {
      id: 42, title: 'Tee', handle: 'tee', vendor: 'V', product_type: 'Shirt',
      tags: 'a,b', created_at: '2026-08-01T00:00:00Z', published_at: '2026-08-10T00:00:00Z',
      variants: [{ price: '19.99', available: true }, { price: '24.99', available: false }],
      images: [{ src: 'http://img/1.jpg' }],
    }
    const p = mapShopifyProduct(raw as any, 'https://foo.com')
    expect(p.externalProductId).toBe('42')
    expect(p.url).toBe('https://foo.com/products/tee')
    expect(p.priceMin).toBe(19.99)
    expect(p.priceMax).toBe(24.99)
    expect(p.variantCount).toBe(2)
    expect(p.availableVariantCount).toBe(1)
    expect(p.dateSource).toBe('published_at')
    expect(p.publishedAt?.toISOString()).toBe('2026-08-10T00:00:00.000Z')
  })
  it('falls back to created_at when published_at missing', () => {
    const p = mapShopifyProduct({ id: 1, created_at: '2026-08-01T00:00:00Z' } as any, 'https://foo.com')
    expect(p.dateSource).toBe('created_at')
  })
})
