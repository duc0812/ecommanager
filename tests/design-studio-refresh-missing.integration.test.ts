import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('@/lib/token-store', () => ({ getShopifyConnection: vi.fn(async () => ({ shop: 'dt-rm.myshopify.com', token: 't' })) }))
vi.mock('@/lib/shopify-orders', () => ({
  fetchOrderLinePropsByNames: vi.fn(async (_s: string, _t: string, names: string[]) => new Map(
    names.filter(n => n === '#DRM1').map(n => [n, [{
      sku: 'A', title: 'Jersey', variantTitle: null, quantity: 1, productType: null,
      customAttributes: [{ key: 'Name', value: 'Russell' }], productUrl: null, variantId: null,
      imageUrl: 'https://cdn.shopify.com/v.jpg', productId: 'gid://shopify/Product/77',
    }]]),
  )),
}))

import { prisma } from '@/lib/db'
import { refreshMissingLineProps } from '@/lib/design-studio'
import { fetchOrderLinePropsByNames } from '@/lib/shopify-orders'

const SHOP = 'dt-rm.myshopify.com'
const IDS = ['gid://test/Order/drm-1', 'gid://test/Order/drm-2', 'gid://test/Order/drm-3', 'gid://test/Order/drm-4']

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_drm' }, create: { id: 'proj_drm', name: 'DRM', startDate: new Date('2026-01-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_drm' }, update: {} })).id
  const mk = (id: string, num: string, attrs: string | null, productId: string | null = attrs ? 'gid://shopify/Product/1' : null) => prisma.order.create({ data: {
    id, projectId: 'proj_drm', storeId, shopifyOrderNumber: num, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
    lines: { create: [{ shopifyLineId: `${num}-1`, sku: 'A', productTitle: 'Jersey', qty: 1, linePosition: 1, unitPrice: 1, customAttributesJson: attrs, imageUrl: attrs ? 'https://cdn.shopify.com/old.jpg' : null, shopifyProductId: productId }] },
  } })
  await mk(IDS[0], '#DRM1', null)
  await mk(IDS[1], '#DRM2', null)
  await mk(IDS[2], '#DRM3', '[]')
  await mk(IDS[3], '#DRM4', '[]', null)
})
afterAll(async () => { await prisma.order.deleteMany({ where: { id: { in: IDS } } }) })

async function load() {
  return prisma.order.findMany({
    where: { id: { in: IDS } },
    select: { id: true, shopifyOrderNumber: true, store: { select: { shop: true } }, lines: { select: { customAttributesJson: true, imageUrl: true, shopifyProductId: true } } },
  })
}

describe('refreshMissingLineProps', () => {
  it('fetches only orders with missing data, applies what Shopify returns, counts the rest', async () => {
    const r = await refreshMissingLineProps(await load())
    expect(r).toEqual({ refreshed: 1, notFound: 2, otherStore: 0, error: null })
    const asked = vi.mocked(fetchOrderLinePropsByNames).mock.calls[0][2]
    expect(asked.sort()).toEqual(['#DRM1', '#DRM2', '#DRM4'])
    const line = await prisma.orderLine.findFirst({ where: { orderId: IDS[0] } })
    expect(line?.imageUrl).toBe('https://cdn.shopify.com/v.jpg')
    expect(JSON.parse(line!.customAttributesJson!)).toEqual([{ key: 'Name', value: 'Russell' }])
    expect(line?.shopifyProductId).toBe('gid://shopify/Product/77')
  })
  it('skips orders of another store', async () => {
    const orders = (await load()).map(o => ({ ...o, store: { shop: 'other.myshopify.com' } }))
    const r = await refreshMissingLineProps(orders)
    expect(r.otherStore).toBe(2)
    expect(r.refreshed).toBe(0)
  })
})
