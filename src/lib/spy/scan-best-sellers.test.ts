import { describe, it, expect, vi, afterEach } from 'vitest'
import { pickBestSellerHandle, fetchStoreBestSellers } from './scan-best-sellers'

afterEach(() => vi.restoreAllMocks())

describe('pickBestSellerHandle', () => {
  it('prefers exact best-selling handle', () => {
    expect(pickBestSellerHandle([{ handle: 'all' }, { handle: 'best-selling' }])).toBe('best-selling')
  })
  it('falls back to the singular best-seller handle', () => {
    expect(pickBestSellerHandle([{ handle: 'best-seller', title: 'Best Seller' }])).toBe('best-seller')
  })
  it('matches by title containing best + sell', () => {
    expect(pickBestSellerHandle([{ handle: 'top', title: 'Our Best Sellers' }])).toBe('top')
  })
  it('returns null when nothing matches', () => {
    expect(pickBestSellerHandle([{ handle: 'all', title: 'All' }, { handle: 'new', title: 'New In' }])).toBeNull()
  })
})

describe('fetchStoreBestSellers', () => {
  it('discovers the handle then maps products in rank order', async () => {
    const collections = { collections: [{ handle: 'all', title: 'All' }, { handle: 'best-seller', title: 'Best Seller' }] }
    const products = { products: [
      { id: 10, title: 'Top', handle: 't', variants: [{ price: '9.99', available: true }] },
      { id: 11, title: 'Second', handle: 's', variants: [] },
    ] }
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => collections } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => products } as Response)
    const { products: out, totalScanned, handle } = await fetchStoreBestSellers('foo.com')
    expect(handle).toBe('best-seller')
    expect(totalScanned).toBe(2)
    expect(out[0].externalProductId).toBe('10')
  })
  it('returns empty when no best-seller collection exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ collections: [{ handle: 'all' }] }) } as Response)
    const r = await fetchStoreBestSellers('foo.com')
    expect(r).toEqual({ products: [], totalScanned: 0, handle: null })
  })
  it('returns empty (with handle) when the collection has no products (404)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ collections: [{ handle: 'best-selling' }] }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    const r = await fetchStoreBestSellers('foo.com')
    expect(r).toEqual({ products: [], totalScanned: 0, handle: 'best-selling' })
  })
  it('throws when collections.json errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' } as Response)
    await expect(fetchStoreBestSellers('foo.com')).rejects.toThrow('500')
  })
})
