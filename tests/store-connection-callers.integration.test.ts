import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

vi.mock('@/lib/shopify-orders', () => ({
  fetchOrderLinePropsByNames: vi.fn(async (_s: string, _t: string, names: string[]) => new Map(
    names.map(n => [n, [{
      sku: 'A', title: 'Jersey', variantTitle: null, quantity: 1, productType: null,
      customAttributes: [{ key: 'Name', value: n }], productUrl: null, variantId: null,
      imageUrl: 'https://cdn.shopify.com/v.jpg', productId: 'gid://shopify/Product/9',
    }]]),
  )),
}))

import { prisma } from '@/lib/db'
import { refreshMissingLineProps } from '@/lib/design-studio'
import { fetchOrderLinePropsByNames } from '@/lib/shopify-orders'
import { saveStoreCredential } from '@/lib/store-connections'

const SHOP_A = 'scc-a.myshopify.com'
const SHOP_B = 'scc-b.myshopify.com'
const PROJECT = 'proj_scc'
const ORDER_IDS = ['gid://test/Order/scc-a1', 'gid://test/Order/scc-a2', 'gid://test/Order/scc-b1']

async function mkOrder(storeId: string, id: string, num: string) {
  await prisma.order.create({ data: {
    id, projectId: PROJECT, storeId, shopifyOrderNumber: num, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
    lines: { create: [{ shopifyLineId: `${num}-1`, sku: 'A', productTitle: 'Jersey', qty: 1, linePosition: 1, unitPrice: 1, customAttributesJson: null, imageUrl: null, shopifyProductId: null }] },
  } })
}

async function load() {
  return prisma.order.findMany({
    where: { id: { in: ORDER_IDS } },
    select: { id: true, shopifyOrderNumber: true, store: { select: { shop: true } }, lines: { select: { customAttributesJson: true, imageUrl: true, shopifyProductId: true } } },
  })
}

let storeA: string
let storeB: string

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'SCC', startDate: new Date('2026-01-01') }, update: {} })
  storeA = (await prisma.shopifyStore.create({ data: { shop: SHOP_A } })).id
  storeB = (await prisma.shopifyStore.create({ data: { shop: SHOP_B } })).id
  await saveStoreCredential(storeA, { authMode: 'TOKEN', accessToken: 'token-a' })
  await saveStoreCredential(storeB, { authMode: 'TOKEN', accessToken: 'token-b' })
})

beforeEach(async () => {
  vi.mocked(fetchOrderLinePropsByNames).mockClear()
  await prisma.order.deleteMany({ where: { id: { in: ORDER_IDS } } })
  await mkOrder(storeA, ORDER_IDS[0], '#SCCA1')
  await mkOrder(storeA, ORDER_IDS[1], '#SCCA2')
  await mkOrder(storeB, ORDER_IDS[2], '#SCCB1')
  await prisma.shopifyStore.update({ where: { id: storeB }, data: { enabled: true } })
  await saveStoreCredential(storeB, { authMode: 'TOKEN', accessToken: 'token-b' })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: ORDER_IDS } } })
  await prisma.shopifyStoreCredential.deleteMany({ where: { storeId: { in: [storeA, storeB] } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { in: [storeA, storeB] } } })
})

describe('refreshMissingLineProps across stores', () => {
  it("calls Shopify once per store with that store's token", async () => {
    const r = await refreshMissingLineProps(await load())
    expect(r).toEqual({ refreshed: 3, notFound: 0, otherStore: 0, error: null, failedShops: [] })
    const calls = vi.mocked(fetchOrderLinePropsByNames).mock.calls.map(c => ({ shop: c[0], token: c[1], names: [...c[2]].sort() }))
    expect(calls).toHaveLength(2)
    expect(calls).toContainEqual({ shop: SHOP_A, token: 'token-a', names: ['#SCCA1', '#SCCA2'] })
    expect(calls).toContainEqual({ shop: SHOP_B, token: 'token-b', names: ['#SCCB1'] })
  })

  it('one store failing does not stop the other', async () => {
    await prisma.shopifyStoreCredential.delete({ where: { storeId: storeB } })
    const r = await refreshMissingLineProps(await load())
    expect(r.refreshed).toBe(2)
    expect(r.error).toContain(SHOP_B)
    expect(r.error).not.toContain(SHOP_A)
    expect(r.failedShops).toEqual([SHOP_B])
    expect(vi.mocked(fetchOrderLinePropsByNames)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchOrderLinePropsByNames).mock.calls[0][0]).toBe(SHOP_A)
    const lineB = await prisma.orderLine.findFirst({ where: { orderId: ORDER_IDS[2] } })
    expect(lineB?.customAttributesJson).toBeNull()
  })

  it('a Shopify error on one store is reported under that shop and the other store still runs', async () => {
    vi.mocked(fetchOrderLinePropsByNames).mockImplementationOnce(async () => { throw new Error('boom') })
    const r = await refreshMissingLineProps(await load())
    expect(r.error).toMatch(/scc-[ab]\.myshopify\.com: .*boom/)
    expect(r.failedShops).toHaveLength(1)
    expect([SHOP_A, SHOP_B]).toContain(r.failedShops[0])
    expect(vi.mocked(fetchOrderLinePropsByNames)).toHaveBeenCalledTimes(2)
    expect(r.refreshed).toBe(await prisma.orderLine.count({ where: { orderId: { in: ORDER_IDS }, customAttributesJson: { not: null } } }))
  })

  it('a disabled store is reported, not silently skipped', async () => {
    await prisma.shopifyStore.update({ where: { id: storeB }, data: { enabled: false } })
    const r = await refreshMissingLineProps(await load())
    expect(r.refreshed).toBe(2)
    expect(r.error).toContain(SHOP_B)
  })
})
