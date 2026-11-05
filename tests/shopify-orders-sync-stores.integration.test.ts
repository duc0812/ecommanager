import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { prisma } from '@/lib/db'
import { saveStoreCredential } from '@/lib/store-connections'
import { POST } from '@/app/api/shopify/orders/sync/route'

const SHOP_A = 'oss-a.myshopify.com'
const SHOP_B = 'oss-b.myshopify.com'
const PROJECT_A = 'proj_oss_a'
const PROJECT_B = 'proj_oss_b'
const MINE = [SHOP_A, SHOP_B]

let storeA = ''
let storeB = ''
const realFetch = global.fetch

type ShopBehaviour = { orders?: string[]; fail?: boolean }
let behaviour: Record<string, ShopBehaviour> = {}
const asked: Array<{ host: string; token: string | null }> = []

function shopifyOrder(name: string) {
  const n = name.replace(/\D/g, '')
  return {
    id: `gid://shopify/Order/oss-${name}`, name,
    createdAt: '2026-10-10T07:06:00Z', processedAt: '2026-10-10T07:06:00Z',
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', currencyCode: 'USD',
    currentTotalPriceSet: { shopMoney: { amount: '30' } }, currentSubtotalPriceSet: { shopMoney: { amount: '30' } },
    currentTotalTaxSet: { shopMoney: { amount: '0' } }, currentShippingPriceSet: { shopMoney: { amount: '0' } },
    customer: { email: 'a@b.test', displayName: 'A B' },
    shippingAddress: { country: 'United States', countryCodeV2: 'US', province: 'CA' },
    taxLines: [],
    lineItems: { nodes: [{
      id: `gid://shopify/LineItem/oss-${n}`, sku: 'OSS-TEE', title: 'Tee', variantTitle: 'M', quantity: 1,
      originalUnitPriceSet: { shopMoney: { amount: '30' } },
      product: { tags: [], productType: 'T-Shirt' },
      variant: { id: `gid://shopify/ProductVariant/oss-${n}`, selectedOptions: [{ name: 'Size', value: 'M' }] },
    }] },
    transactions: [], refunds: [],
  }
}

function installFetch() {
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const host = new URL(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url).host
    const headers = new Headers(init?.headers)
    asked.push({ host, token: headers.get('x-shopify-access-token') })
    const shop = behaviour[host]
    if (shop?.fail) return new Response('{"errors":"boom"}', { status: 500 })
    return new Response(JSON.stringify({
      data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: (shop?.orders ?? []).map(shopifyOrder) } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

const call = (body: Record<string, unknown> = {}) =>
  POST(new Request('http://test/api/shopify/orders/sync', { method: 'POST', body: JSON.stringify(body) }) as any)

async function cleanup() {
  const stores = await prisma.shopifyStore.findMany({ where: { shop: { in: MINE } }, select: { id: true } })
  await prisma.order.deleteMany({ where: { storeId: { in: stores.map(s => s.id) } } })
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: MINE } } })
  await prisma.project.deleteMany({ where: { id: { in: [PROJECT_A, PROJECT_B] } } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.project.create({ data: { id: PROJECT_A, name: 'OSS Alpha', startDate: new Date('2026-05-01') } })
  await prisma.project.create({ data: { id: PROJECT_B, name: 'OSS Beta', startDate: new Date('2026-05-01') } })
  storeA = (await prisma.shopifyStore.create({ data: { shop: SHOP_A, projectId: PROJECT_A, orderPrefix: 'AAA', syncSinceDate: new Date('2026-05-01'), connectedAt: new Date('2026-09-01') } })).id
  storeB = (await prisma.shopifyStore.create({ data: { shop: SHOP_B, projectId: PROJECT_B, orderPrefix: 'BBB', syncSinceDate: new Date('2026-05-01'), connectedAt: new Date('2026-09-02') } })).id
  await saveStoreCredential(storeA, { authMode: 'TOKEN', accessToken: 'token-oss-a' })
  await saveStoreCredential(storeB, { authMode: 'TOKEN', accessToken: 'token-oss-b' })
})

beforeEach(async () => {
  asked.length = 0
  behaviour = {}
  installFetch()
  await prisma.order.deleteMany({ where: { storeId: { in: [storeA, storeB] } } })
  await prisma.shopifyStore.updateMany({ where: { id: { in: [storeA, storeB] } }, data: { lastError: null, lastErrorAt: null, enabled: true } })
})

afterEach(() => { global.fetch = realFetch })
afterAll(async () => { await cleanup() })

describe('POST /api/shopify/orders/sync across stores', () => {
  it('syncs every connected store with its own token and answers one summed body that keeps the old fields', async () => {
    behaviour[SHOP_A] = { orders: ['#AAA1', '#AAA2'] }
    behaviour[SHOP_B] = { orders: ['#BBB1'] }
    const res = await call()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ totalSynced: 3, withUnmappedSku: 3, errors: [], fromOrderName: null, skippedBeforeFromOrder: 0 })
    expect(body.projectName).toBe('OSS Alpha, OSS Beta')
    expect(body.stores.map((s: any) => [s.shop, s.ok])).toEqual([[SHOP_A, true], [SHOP_B, true]])
    expect(asked.filter(a => a.host === SHOP_A).every(a => a.token === 'token-oss-a')).toBe(true)
    expect(asked.filter(a => a.host === SHOP_B).every(a => a.token === 'token-oss-b')).toBe(true)
    expect((await prisma.order.findMany({ where: { storeId: storeA } })).map(o => o.shopifyOrderNumber).sort()).toEqual(['#AAA1', '#AAA2'])
    expect((await prisma.order.findMany({ where: { storeId: storeB } })).map(o => o.shopifyOrderNumber)).toEqual(['#BBB1'])
  })

  it('a store that fails does not stop the other: 200, the error is in errors and stores, and on that store', async () => {
    behaviour[SHOP_A] = { fail: true }
    behaviour[SHOP_B] = { orders: ['#BBB1'] }
    const res = await call()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.totalSynced).toBe(1)
    expect(body.errors.some((e: string) => e.startsWith(`${SHOP_A}: `))).toBe(true)
    expect(body.stores[0]).toMatchObject({ shop: SHOP_A, ok: false })
    expect(body.stores[1]).toMatchObject({ shop: SHOP_B, ok: true })
    expect((await prisma.shopifyStore.findUnique({ where: { id: storeA } }))!.lastError).toContain('Shopify fetch failed')
    expect((await prisma.shopifyStore.findUnique({ where: { id: storeB } }))!.lastError).toBeNull()
  })

  it('answers 502 only when every store failed', async () => {
    behaviour[SHOP_A] = { fail: true }
    behaviour[SHOP_B] = { fail: true }
    const res = await call()
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain('Shopify fetch failed')
    expect(body.stores.every((s: any) => s.ok === false)).toBe(true)
  })

  it('storeId runs that store only', async () => {
    behaviour[SHOP_A] = { orders: ['#AAA1'] }
    behaviour[SHOP_B] = { orders: ['#BBB1'] }
    const body = await (await call({ storeId: storeB })).json()
    expect(body.totalSynced).toBe(1)
    expect(body.projectName).toBe('OSS Beta')
    expect(body.stores).toHaveLength(1)
    expect(asked.some(a => a.host === SHOP_A)).toBe(false)
  })

  it('a storeId that is not a connected store is refused', async () => {
    await prisma.shopifyStore.update({ where: { id: storeB }, data: { enabled: false } })
    expect((await call({ storeId: storeB })).status).toBe(401)
    expect((await call({ storeId: 'nope' })).status).toBe(401)
  })

  it('fromOrderName without storeId takes the store from the prefix, and 400 when it cannot', async () => {
    behaviour[SHOP_A] = { orders: ['#AAA5', '#AAA9'] }
    behaviour[SHOP_B] = { orders: ['#BBB9'] }
    const res = await call({ fromOrderName: '#AAA9' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ totalSynced: 1, skippedBeforeFromOrder: 1, fromOrderName: '#AAA9' })
    expect(body.stores.map((s: any) => s.shop)).toEqual([SHOP_A])

    const unknown = await call({ fromOrderName: '#ZZZ1' })
    expect(unknown.status).toBe(400)
    expect((await call({ fromOrderName: '1023' })).status).toBe(400)
    expect(asked.some(a => a.host === SHOP_B)).toBe(false)
  })

  it("looks the starting order up in that store only", async () => {
    const placedA = new Date('2026-09-20T00:00:00Z')
    const orderRow = (id: string, storeId: string, projectId: string, placedAt: Date) => prisma.order.create({ data: {
      id, projectId, storeId, shopifyOrderNumber: '#SAME7', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt,
    } })
    await orderRow('gid://test/Order/oss-same-a', storeA, PROJECT_A, placedA)
    await orderRow('gid://test/Order/oss-same-b', storeB, PROJECT_B, new Date('2026-03-01T00:00:00Z'))
    behaviour[SHOP_B] = { orders: [] }
    const calls: string[] = []
    const inner = global.fetch
    global.fetch = vi.fn(async (url: any, init?: any) => { calls.push(String(url instanceof Request ? url.url : url) + ' ' + String(init?.body ?? '')); return inner(url, init) }) as unknown as typeof fetch
    await call({ storeId: storeB, fromOrderName: '#SAME7' })
    const asked2026_03 = calls.some(c => c.includes('2026-03-01'))
    const askedSept = calls.some(c => c.includes('2026-09-20'))
    expect(asked2026_03).toBe(true)
    expect(askedSept).toBe(false)
  })

  it('the same sync is not started twice on one store: the second call is skipped', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const inner = global.fetch
    behaviour[SHOP_A] = { orders: ['#AAA1'] }
    global.fetch = vi.fn(async (url: any, init?: any) => { await gate; return inner(url, init) }) as unknown as typeof fetch
    const first = call({ storeId: storeA })
    await new Promise(resolve => setTimeout(resolve, 50))
    const second = await call({ storeId: storeA })
    expect(second.status).toBe(409)
    release()
    expect((await first).status).toBe(200)
  })

  it("keeps a single store's own failure status for its settings", async () => {
    await prisma.shopifyStore.update({ where: { id: storeB }, data: { projectId: null } })
    try {
      const res = await call({ storeId: storeB })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('not linked to a project')
    } finally {
      await prisma.shopifyStore.update({ where: { id: storeB }, data: { projectId: PROJECT_B } })
    }
  })
})
