import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: any = { upsert: [], snapshotCreate: [] }
vi.mock('@/lib/db', () => ({
  prisma: {
    spyProduct: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (args: any) => { calls.upsert.push(args); return { id: 'p1', ...args.create } }),
    },
    spyProductSnapshot: { create: vi.fn(async (a: any) => { calls.snapshotCreate.push(a); return {} }) },
  },
}))

import { ingestStoreProducts } from './ingest-products'
import type { ParsedSpyProduct } from '@/lib/spy/shopify'

const parsed = (id: string): ParsedSpyProduct => ({
  externalProductId: id, handle: 'h'+id, title: 'T'+id, productType: 'Shirt', vendor: 'V',
  tags: ['a'], imageUrl: null, priceMin: 10, priceMax: 20, variantCount: 1,
  availableVariantCount: 1, publishedAt: new Date('2026-08-10'), dateSource: 'published_at',
  url: 'https://foo.com/products/h'+id,
})

beforeEach(() => { calls.upsert.length = 0; calls.snapshotCreate.length = 0; vi.clearAllMocks() })

describe('ingestStoreProducts', () => {
  it('upserts each product scoped by store + externalProductId', async () => {
    const res = await ingestStoreProducts('store1', 'scan1', [parsed('1'), parsed('2')])
    expect(res.found).toBe(2)
    expect(calls.upsert).toHaveLength(2)
    expect(calls.upsert[0].where).toEqual({ storeId_externalProductId: { storeId: 'store1', externalProductId: '1' } })
    expect(calls.upsert[0].create.tags).toBe('["a"]')
  })
})
