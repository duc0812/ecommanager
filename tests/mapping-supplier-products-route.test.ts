import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  supplierFindMany: vi.fn(async () => [{ id: 'supplier-1', name: 'Supplier 1', code: 'SUP1' }]),
  productFindMany: vi.fn(async () => [{ id: 'product-1', sku: 'SKU-1' }]),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    supplier: { findMany: mocks.supplierFindMany },
    supplierProduct: { findMany: mocks.productFindMany },
  },
}))

import { dynamic, GET } from '@/app/api/fulfillment/mapping/supplier-products/route'

describe('GET /api/fulfillment/mapping/supplier-products', () => {
  it('always reads current active supplier products without response caching', async () => {
    const response = await GET()
    const body = await response.json()

    expect(dynamic).toBe('force-dynamic')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.productFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { supplier: { isActive: true } },
    }))
    expect(body).toEqual({
      suppliers: [{ id: 'supplier-1', name: 'Supplier 1', code: 'SUP1' }],
      products: [{ id: 'product-1', sku: 'SKU-1' }],
    })
  })
})
