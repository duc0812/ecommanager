import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchSheetCsv: vi.fn(),
  fetchFulfillmentOrders: vi.fn(),
  createFulfillment: vi.fn(),
}))

vi.mock('@/lib/fulfillment/parse-sheet', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/fulfillment/parse-sheet')>()),
  fetchSheetCsv: mocks.fetchSheetCsv,
}))
vi.mock('@/lib/shopify-orders', () => ({
  fetchOrderFulfillmentOrdersByNames: mocks.fetchFulfillmentOrders,
  createFulfillment: mocks.createFulfillment,
}))

import { prisma } from '@/lib/db'
import { saveStoreCredential } from '@/lib/store-connections'
import { runAutoFulfillForStores, trackingUrlFor } from '@/lib/fulfillment/auto-fulfill-stores'
import { orderNameHasPrefix } from '@/lib/fulfillment/auto-fulfill'

const SHOP_A = 'aff-a.myshopify.com'
const SHOP_B = 'aff-b.myshopify.com'
const SHOP_C = 'aff-c.myshopify.com'
const PROJECT = 'proj_aff'
const SUPPLIER = 'sup_aff'
const MINE = [SHOP_A, SHOP_B, SHOP_C]
let storeA = ''
let storeB = ''
let storeC = ''

const sheet = (id: string, name: string) => ({ id, name, url: `https://docs.google.com/spreadsheets/d/${id}/edit`, enabled: true, storeBase: 'https://litzzy.com' })
const SHEETS = [sheet('aff1', 'Mangoshao'), sheet('aff2', 'Jomall')]

async function cleanup() {
  const stores = await prisma.shopifyStore.findMany({ where: { shop: { in: MINE } }, select: { id: true } })
  await prisma.order.deleteMany({ where: { storeId: { in: stores.map(s => s.id) } } })
  await prisma.supplier.deleteMany({ where: { id: SUPPLIER } })
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: MINE } } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
}

const dbOrder = (id: string, storeId: string, name: string) => prisma.order.create({ data: {
  id, projectId: PROJECT, storeId, shopifyOrderNumber: `#${name}`, financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1,
  totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'), fulfillmentStatus: 'UNFULFILLED',
} })

beforeAll(async () => {
  await cleanup()
  await prisma.project.create({ data: { id: PROJECT, name: 'AFF', startDate: new Date('2026-05-01') } })
  storeA = (await prisma.shopifyStore.create({ data: { shop: SHOP_A, orderPrefix: 'LIT', connectedAt: new Date('2026-09-01') } })).id
  storeB = (await prisma.shopifyStore.create({ data: { shop: SHOP_B, orderPrefix: 'REMI', connectedAt: new Date('2026-09-02') } })).id
  for (const [id, token] of [[storeA, 'token-aff-a'], [storeB, 'token-aff-b']]) await saveStoreCredential(id, { authMode: 'TOKEN', accessToken: token })
  await dbOrder('gid://test/Order/aff-lit1', storeA, 'LIT1001')
  await dbOrder('gid://test/Order/aff-remi1', storeB, 'REMI1001')
})

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.fetchSheetCsv.mockImplementation(async (url: string) => (url.includes('aff1')
    ? 'Order,Tracking\nLIT1001,TRK1\nLIT1002,TRK2\nREMI1001,TRK3\nZZZ9,TRK4\n'
    : 'Order,Tracking\nLIT1001_2,TRK5\nREMI1002,TRK6\nZZZ9,TRK4\n'))
  mocks.fetchFulfillmentOrders.mockImplementation(async () => new Map())
  if (storeC) await prisma.shopifyStore.deleteMany({ where: { id: storeC } })
  storeC = ''
})

afterAll(async () => { await cleanup() })

const askedFor = () => Object.fromEntries(mocks.fetchFulfillmentOrders.mock.calls.map(c => [c[0], [...c[2]].sort()]))

describe('runAutoFulfillForStores', () => {
  it('reads each sheet once and asks each store only about the orders carrying its prefix', async () => {
    const { results, summary } = await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    expect(mocks.fetchSheetCsv).toHaveBeenCalledTimes(SHEETS.length)
    expect(askedFor()).toEqual({ [SHOP_A]: ['LIT1001', 'LIT1002'], [SHOP_B]: ['REMI1001', 'REMI1002'] })
    expect(results.map(r => [r.shop, r.ok])).toEqual([[SHOP_A, true], [SHOP_B, true]])

    const names = summary!.rows.map(r => r.baseOrder)
    expect(new Set(names).size).toBe(names.length)
    expect(names.sort()).toEqual(['LIT1001', 'LIT1002', 'REMI1001', 'REMI1002', 'ZZZ9'])
    expect(summary!.rows.find(r => r.baseOrder === 'LIT1001')).toMatchObject({ shop: SHOP_A })
    expect(summary!.rows.find(r => r.baseOrder === 'REMI1001')).toMatchObject({ shop: SHOP_B })
    expect(summary).toMatchObject({ ordersChecked: 5, notFound: 4, errored: 1, fulfilled: 0 })
  })

  it('reports a row no store owns once, as an error with no shop, and fulfils nothing', async () => {
    const { summary } = await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    const unowned = summary!.rows.filter(r => r.baseOrder === 'ZZZ9')
    expect(unowned).toHaveLength(1)
    expect(unowned[0]).toMatchObject({ status: 'error', fulfilledLines: 0 })
    expect(unowned[0].shop).toBeUndefined()
    expect(unowned[0].message).toContain('tiền tố')
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
  })

  it('counts a sheet that failed to download once, not once per store', async () => {
    mocks.fetchSheetCsv.mockImplementation(async (url: string) => {
      if (url.includes('aff2')) throw new Error('HTTP 403')
      return 'Order,Tracking\nLIT1001,TRK1\nREMI1001,TRK3\n'
    })
    const { summary } = await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
    const sheetErrors = summary!.rows.filter(r => r.baseOrder.startsWith('(sheet:'))
    expect(sheetErrors).toHaveLength(1)
    expect(sheetErrors[0].message).toContain('HTTP 403')
    expect(summary).toMatchObject({ ordersChecked: 2, errored: 1 })
  })

  it('a store without an order prefix takes no sheet rows, and a row that matches no prefix is still reported', async () => {
    storeC = (await prisma.shopifyStore.create({ data: { shop: SHOP_C, connectedAt: new Date('2026-09-03') } })).id
    await saveStoreCredential(storeC, { authMode: 'TOKEN', accessToken: 'token-aff-c' })
    const { results } = await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
    expect(results.map(r => r.shop)).toEqual([SHOP_A, SHOP_B, SHOP_C])
    expect(Object.keys(askedFor()).sort()).toEqual([SHOP_A, SHOP_B])
  })

  it('one store failing leaves the other store its own rows', async () => {
    await prisma.shopifyStoreCredential.update({ where: { storeId: storeB }, data: { accessToken: null } })
    try {
      const { results, summary } = await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
      expect(results.map(r => [r.shop, r.ok])).toEqual([[SHOP_A, true], [SHOP_B, false]])
      expect(summary!.rows.filter(r => r.shop === SHOP_A).map(r => r.baseOrder).sort()).toEqual(['LIT1001', 'LIT1002'])
    } finally {
      await prisma.shopifyStoreCredential.update({ where: { storeId: storeB }, data: { accessToken: 'token-aff-b' } })
    }
  })
})

describe("the fulfilment link comes from the order's store", () => {
  const LITZZY_PAGE = 'https://litzzy.com/apps/trackingorder?nums='
  const TRACKING = 'YT 12/34é#5&x'
  // What the sheet's storeBase produced before this change: the link Litzzy customers have been getting.
  const oldLink = (tracking: string) => `${'https://litzzy.com'.replace(/\/$/, '')}/apps/trackingorder?nums=${encodeURIComponent(tracking)}`

  const openFulfillmentOrders = async (_shop: string, _token: string, names: string[]) => new Map(names.map(name => [name, {
    displayFulfillmentStatus: 'UNFULFILLED', createdAt: '2026-10-01T00:00:00Z',
    fulfillmentOrders: [{ id: `FO-${name}`, status: 'OPEN', lineItems: [{ id: `FOL-${name}`, remainingQuantity: 1, shopifyLineId: 'L1', sku: null }] }],
  }]))

  const shipmentOf = (orderId: string) => prisma.shipment.findFirstOrThrow({ where: { orderId } })
  const callFor = (shop: string) => mocks.createFulfillment.mock.calls.find(c => c[0] === shop)?.[2]

  beforeAll(async () => {
    await prisma.supplier.create({ data: { id: SUPPLIER, name: 'AFF supplier', code: 'AFFSUP' } })
  })

  beforeEach(async () => {
    mocks.fetchFulfillmentOrders.mockImplementation(openFulfillmentOrders)
    mocks.createFulfillment.mockResolvedValue({ ok: true, fulfillmentId: 'gid://shopify/Fulfillment/1' })
    mocks.fetchSheetCsv.mockImplementation(async () => `Order,Tracking\nLIT1001_1,${TRACKING}\nREMI1001_1,${TRACKING}\n`)
    await prisma.shipment.deleteMany({ where: { orderId: { in: ['gid://test/Order/aff-lit1', 'gid://test/Order/aff-remi1'] } } })
    await prisma.order.updateMany({ where: { id: { in: ['gid://test/Order/aff-lit1', 'gid://test/Order/aff-remi1'] } }, data: { fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'PENDING_DESIGN' } })
    for (const [orderId, lineKey] of [['gid://test/Order/aff-lit1', 'LIT1001_1'], ['gid://test/Order/aff-remi1', 'REMI1001_1']]) {
      await prisma.shipment.create({ data: { orderId, projectId: PROJECT, lineKey, shopifyLineId: 'L1' } })
    }
    await prisma.shopifyStore.update({ where: { id: storeA }, data: { trackingPageUrl: LITZZY_PAGE } })
    await prisma.shopifyStore.update({ where: { id: storeB }, data: { trackingPageUrl: null } })
  })

  it('trackingUrlFor is the store page plus the encoded number, and nothing when the store has no page', () => {
    expect(trackingUrlFor({ trackingPageUrl: LITZZY_PAGE }, TRACKING)).toBe(oldLink(TRACKING))
    expect(trackingUrlFor({ trackingPageUrl: 'https://remi.example/track?id=1&nums=' }, 'A B')).toBe('https://remi.example/track?id=1&nums=A%20B')
    expect(trackingUrlFor({ trackingPageUrl: null }, TRACKING)).toBeUndefined()
    expect(trackingUrlFor({ trackingPageUrl: '' }, TRACKING)).toBeUndefined()
    expect(trackingUrlFor({ trackingPageUrl: '   ' }, TRACKING)).toBeUndefined()
  })

  it("Litzzy's link is byte-identical to the one the sheet's storeBase built, for a number that needs encoding", async () => {
    await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    const input = callFor(SHOP_A)
    expect(input.trackingInfo).toStrictEqual({ company: 'Other', number: TRACKING, url: oldLink(TRACKING) })
    expect(input.notifyCustomer).toBe(true)
    expect((await shipmentOf('gid://test/Order/aff-lit1')).trackingUrl).toBe(oldLink(TRACKING))
  })

  it('a store without a tracking page fulfils with company and number but no link, and stores null', async () => {
    await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    const input = callFor(SHOP_B)
    expect(input.trackingInfo).toStrictEqual({ company: 'Other', number: TRACKING })
    expect(input.notifyCustomer).toBe(true)
    const shipment = await shipmentOf('gid://test/Order/aff-remi1')
    expect(shipment.trackingUrl).toBeNull()
    expect(shipment).toMatchObject({ trackingNumber: TRACKING, status: 'FULFILLED', carrier: 'Other' })
  })

  it("a store with its own page gets that page, even though every sheet's storeBase is litzzy.com", async () => {
    await prisma.shopifyStore.update({ where: { id: storeB }, data: { trackingPageUrl: 'https://reminiso.example/apps/track?nums=' } })
    await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    expect(callFor(SHOP_B).trackingInfo.url).toBe(`https://reminiso.example/apps/track?nums=${encodeURIComponent(TRACKING)}`)
    expect((await shipmentOf('gid://test/Order/aff-remi1')).trackingUrl).toBe(`https://reminiso.example/apps/track?nums=${encodeURIComponent(TRACKING)}`)
    expect(JSON.stringify(mocks.createFulfillment.mock.calls.filter(c => c[0] === SHOP_B))).not.toContain('litzzy.com')
  })

  it('a shipment pushed to a supplier gets the same store link, or none', async () => {
    await prisma.shipment.deleteMany({ where: { orderId: 'gid://test/Order/aff-remi1' } })
    await prisma.shipment.create({ data: {
      orderId: 'gid://test/Order/aff-remi1', projectId: PROJECT, lineKey: 'REMI1001_1', shopifyLineId: 'L1', supplierId: SUPPLIER, trackingNumber: TRACKING,
    } })
    await prisma.supplierOrderPush.create({ data: {
      orderId: 'gid://test/Order/aff-remi1', supplierId: SUPPLIER, externalOrderId: 'aff-ext-1', status: 'CREATED', requestJson: '{}',
    } })
    mocks.fetchSheetCsv.mockImplementation(async () => 'Order,Tracking\n')

    await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    expect(callFor(SHOP_B).trackingInfo).toStrictEqual({ company: 'Other', number: TRACKING })
    expect((await shipmentOf('gid://test/Order/aff-remi1')).trackingUrl).toBeNull()

    mocks.createFulfillment.mockClear()
    await prisma.order.update({ where: { id: 'gid://test/Order/aff-remi1' }, data: { fulfillmentStatus: 'UNFULFILLED' } })
    await prisma.shipment.updateMany({ where: { orderId: 'gid://test/Order/aff-remi1' }, data: { shopifyFulfillmentId: null } })
    await prisma.shopifyStore.update({ where: { id: storeB }, data: { trackingPageUrl: 'https://reminiso.example/apps/track?nums=' } })
    await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    expect(callFor(SHOP_B).trackingInfo.url).toBe(`https://reminiso.example/apps/track?nums=${encodeURIComponent(TRACKING)}`)
  })

  it('Preview (apply false) creates nothing and writes no link', async () => {
    await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
    expect((await shipmentOf('gid://test/Order/aff-lit1')).trackingUrl).toBeNull()
  })
})

describe('orderNameHasPrefix', () => {
  it('needs the prefix followed by a digit, ignores case and the leading #', () => {
    expect(orderNameHasPrefix('LIT4665', 'LIT')).toBe(true)
    expect(orderNameHasPrefix('#lit2362R1', 'LIT')).toBe(true)
    expect(orderNameHasPrefix('LITE123', 'LIT')).toBe(false)
    expect(orderNameHasPrefix('REMI1', 'LIT')).toBe(false)
    expect(orderNameHasPrefix('LIT1', null)).toBe(false)
    expect(orderNameHasPrefix('LIT1', '')).toBe(false)
  })
})
