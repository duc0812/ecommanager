import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchStoreProducts } from './scan-products'

afterEach(() => vi.restoreAllMocks())

describe('fetchStoreProducts', () => {
  it('fetches products.json and maps items', async () => {
    const payload = { products: [
      { id: 1, title: 'A', handle: 'a', variants: [{ price: '9.99', available: true }] },
      { id: 2, title: 'B', handle: 'b', variants: [] },
    ] }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => payload } as Response)
    const { products, totalScanned } = await fetchStoreProducts('foo.com')
    expect(totalScanned).toBe(2)
    expect(products[0].externalProductId).toBe('1')
    expect(products[0].url).toBe('https://foo.com/products/a')
  })
  it('throws on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' } as Response)
    await expect(fetchStoreProducts('foo.com')).rejects.toThrow('404')
  })
})
