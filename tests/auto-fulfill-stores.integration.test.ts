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
import { runAutoFulfillAllStores, trackingUrlFor } from '@/lib/fulfillment/auto-fulfill-stores'
import { getSheets } from '@/lib/fulfillment/auto-fulfill-sheets'

const SHOP_A = 'aff-a.myshopify.com'
const SHOP_B = 'aff-b.myshopify.com'
const SHOP_C = 'aff-c.myshopify.com'
const SHOP_OFF = 'aff-off.myshopify.com'
const SHOP_NOCRED = 'aff-nocred.myshopify.com'
const PROJECT = 'proj_aff'
const SUPPLIER = 'sup_aff'
const MINE = [SHOP_A, SHOP_B, SHOP_C, SHOP_OFF, SHOP_NOCRED]
const SHEETS_KEY = 'auto_fulfill_sheets'
let storeA = ''
let storeB = ''
let storeC = ''
let storeOff = ''

const sheet = (id: string, name: string) => ({ id, name, url: `https://docs.google.com/spreadsheets/d/${id}/edit`, enabled: true })
const SHEETS = [sheet('aff1', 'Mangoshao'), sheet('aff2', 'Jomall')]

async function cleanup() {
  const stores = await prisma.shopifyStore.findMany({ where: { shop: { in: MINE } }, select: { id: true } })
  await prisma.order.deleteMany({ where: { storeId: { in: stores.map(s => s.id) } } })
  await prisma.supplier.deleteMany({ where: { id: SUPPLIER } })
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: MINE } } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.appSetting.deleteMany({ where: { key: SHEETS_KEY } })
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
  // A store that is switched off keeps its credential and its orders; one that is on but disconnected has neither a token nor a way to ask Shopify.
  storeOff = (await prisma.shopifyStore.create({ data: { shop: SHOP_OFF, orderPrefix: 'OFF', enabled: false, connectedAt: new Date('2026-09-04') } })).id
  await saveStoreCredential(storeOff, { authMode: 'TOKEN', accessToken: 'token-aff-off' })
  await prisma.shopifyStore.create({ data: { shop: SHOP_NOCRED, orderPrefix: 'NOC', connectedAt: new Date('2026-09-05') } })
  await dbOrder('gid://test/Order/aff-off1', storeOff, 'OFF1001')
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

describe('runAutoFulfillAllStores', () => {
  it('reads each sheet once and asks each store only about the orders carrying its prefix', async () => {
    const { results, summary } = await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
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

  it('a row whose prefix matches no store is reported as an error and fulfills nothing', async () => {
    const { summary } = await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
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
    const { summary } = await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
    const sheetErrors = summary!.rows.filter(r => r.baseOrder.startsWith('(sheet:'))
    expect(sheetErrors).toHaveLength(1)
    expect(sheetErrors[0].message).toContain('HTTP 403')
    expect(summary).toMatchObject({ ordersChecked: 2, errored: 1 })
  })

  it('a store without an order prefix takes no sheet rows, and a row that matches no prefix is still reported', async () => {
    storeC = (await prisma.shopifyStore.create({ data: { shop: SHOP_C, connectedAt: new Date('2026-09-03') } })).id
    await saveStoreCredential(storeC, { authMode: 'TOKEN', accessToken: 'token-aff-c' })
    const { results } = await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
    expect(results.map(r => r.shop)).toEqual([SHOP_A, SHOP_B, SHOP_C])
    expect(Object.keys(askedFor()).sort()).toEqual([SHOP_A, SHOP_B])
  })

  it('one store failing leaves the other store its own rows', async () => {
    await prisma.shopifyStoreCredential.update({ where: { storeId: storeB }, data: { accessToken: null } })
    try {
      const { results, summary } = await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
      expect(results.map(r => [r.shop, r.ok])).toEqual([[SHOP_A, true], [SHOP_B, false]])
      expect(summary!.rows.filter(r => r.shop === SHOP_A).map(r => r.baseOrder).sort()).toEqual(['LIT1001', 'LIT1002'])
    } finally {
      await prisma.shopifyStoreCredential.update({ where: { storeId: storeB }, data: { accessToken: 'token-aff-b' } })
    }
  })

  it('a row of a disabled store is reported and fulfills nothing, though the store keeps its token and the order is open', async () => {
    mocks.fetchSheetCsv.mockImplementation(async () => 'Order,Tracking\nOFF1001_1,TRKOFF\nLIT1001,TRK1\n')
    const { results, summary } = await runAutoFulfillAllStores({ sheets: SHEETS.slice(0, 1), minAgeDays: 5, apply: true })
    expect(results.map(r => r.shop)).toEqual([SHOP_A, SHOP_B])
    const row = summary!.rows.find(r => r.baseOrder === 'OFF1001')
    expect(row).toMatchObject({ status: 'error', fulfilledLines: 0, trackings: [] })
    expect(row!.shop).toBeUndefined()
    expect(row!.message).toContain(SHOP_OFF)
    expect(row!.message).toContain('đang tắt')
    expect(Object.keys(askedFor())).not.toContain(SHOP_OFF)
    expect(mocks.createFulfillment.mock.calls.filter(c => c[0] === SHOP_OFF || c[1] === 'token-aff-off')).toHaveLength(0)
    expect(summary).toMatchObject({ ordersChecked: 2, errored: 1 })
  })

  it('a row of a store that is on but has no connection is reported as not connected and fulfills nothing', async () => {
    mocks.fetchSheetCsv.mockImplementation(async () => 'Order,Tracking\nNOC1001,TRK1\n')
    const { summary } = await runAutoFulfillAllStores({ sheets: SHEETS.slice(0, 1), minAgeDays: 5, apply: true })
    expect(summary!.rows.find(r => r.baseOrder === 'NOC1001')).toMatchObject({ status: 'error', fulfilledLines: 0 })
    expect(summary!.rows.find(r => r.baseOrder === 'NOC1001')!.message).toContain('chưa kết nối')
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
    expect(askedFor()).toEqual({})
  })

  it('a prefix two connected stores both claim is reported and fulfills nothing, rather than guessed', async () => {
    storeC = (await prisma.shopifyStore.create({ data: { shop: SHOP_C, orderPrefix: 'LIT', connectedAt: new Date('2026-09-03') } })).id
    await saveStoreCredential(storeC, { authMode: 'TOKEN', accessToken: 'token-aff-c' })
    mocks.fetchSheetCsv.mockImplementation(async () => 'Order,Tracking\nLIT1001,TRK1\nREMI1001,TRK3\n')
    const { summary } = await runAutoFulfillAllStores({ sheets: SHEETS.slice(0, 1), minAgeDays: 5, apply: true })
    const row = summary!.rows.find(r => r.baseOrder === 'LIT1001')
    expect(row).toMatchObject({ status: 'error', fulfilledLines: 0 })
    expect(row!.message).toContain('nhiều store')
    expect(askedFor()).toEqual({ [SHOP_B]: ['REMI1001'] })
  })
})

describe('stored sheet settings from before the sheet was shared', () => {
  const legacy = JSON.stringify([
    { id: '1', name: 'Mangoshao', url: 'https://docs.google.com/spreadsheets/d/aff1/edit', enabled: true, storeBase: 'https://litzzy.com' },
    { id: '2', name: 'Jomall', url: 'https://docs.google.com/spreadsheets/d/aff2/edit', enabled: false, storeBase: 'https://other.example' },
  ])

  it('getSheets reads them without storeBase and leaves the stored value alone', async () => {
    await prisma.appSetting.upsert({ where: { key: SHEETS_KEY }, create: { key: SHEETS_KEY, value: legacy }, update: { value: legacy } })
    expect(await getSheets()).toEqual([
      { id: '1', name: 'Mangoshao', url: 'https://docs.google.com/spreadsheets/d/aff1/edit', enabled: true },
      { id: '2', name: 'Jomall', url: 'https://docs.google.com/spreadsheets/d/aff2/edit', enabled: false },
    ])
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: SHEETS_KEY } })).value).toBe(legacy)
  })

  it('runs with them: the sheet is read once and each prefix goes to its own store', async () => {
    const sheets = await getSheets()
    mocks.fetchSheetCsv.mockImplementation(async () => 'Order,Tracking\nLIT1001,TRK1\nREMI1001,TRK3\n')
    await runAutoFulfillAllStores({ sheets, minAgeDays: 5, apply: false })
    expect(mocks.fetchSheetCsv).toHaveBeenCalledTimes(1)
    expect(askedFor()).toEqual({ [SHOP_A]: ['LIT1001'], [SHOP_B]: ['REMI1001'] })
  })
})

describe("the fulfilment goes through the order's own store: its token and its tracking link", () => {
  const LITZZY_PAGE = 'https://litzzy.com/apps/trackingorder?nums='
  const TRACKING = 'YT 12/34é#5&x'
  const NOW = new Date('2026-11-06T00:00:00Z')
  // What the sheet's storeBase produced before the sheet was shared: the link Litzzy customers have been getting.
  const oldLink = (tracking: string) => `${'https://litzzy.com'.replace(/\/$/, '')}/apps/trackingorder?nums=${encodeURIComponent(tracking)}`

  const openFulfillmentOrders = async (_shop: string, _token: string, names: string[]) => new Map(names.map(name => [name, {
    displayFulfillmentStatus: 'UNFULFILLED', createdAt: '2026-10-01T00:00:00Z',
    fulfillmentOrders: [{ id: `FO-${name}`, status: 'OPEN', lineItems: [{ id: `FOL-${name}`, remainingQuantity: 1, shopifyLineId: 'L1', sku: null }] }],
  }]))

  const shipmentOf = (orderId: string) => prisma.shipment.findFirstOrThrow({ where: { orderId } })
  const callFor = (shop: string) => mocks.createFulfillment.mock.calls.find(c => c[0] === shop)?.[2]

  beforeAll(async () => {
    // The rows come from the Mangoshao sheet: Auto Fulfilled fulfils a line only from the sheet of the supplier it went to.
    await prisma.supplier.create({ data: { id: SUPPLIER, name: 'Mangoshao', code: 'AFFSUP' } })
    // Auto Fulfilled fulfils a product line only after it went to its supplier.
    for (const orderId of ['gid://test/Order/aff-lit1', 'gid://test/Order/aff-remi1']) {
      await prisma.orderLine.create({ data: {
        orderId, shopifyLineId: 'L1', productTitle: 'Hoodie', qty: 1, unitPrice: 10, resolvedSupplierId: SUPPLIER,
        exportedAt: new Date('2026-10-02T00:00:00Z'), exportedToSupplierId: SUPPLIER,
      } })
    }
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

  it("one sheet with LIT and REMI rows fulfills each order with its own store's token", async () => {
    mocks.fetchSheetCsv.mockImplementation(async () => 'Order,Tracking\nLIT1001_1,TRK-LIT\nREMI1001_1,TRK-REMI\n')
    const { results, summary } = await runAutoFulfillAllStores({ sheets: SHEETS.slice(0, 1), minAgeDays: 5, apply: true, now: NOW })
    expect(mocks.fetchSheetCsv).toHaveBeenCalledTimes(1)
    expect(mocks.fetchFulfillmentOrders.mock.calls.map(c => [c[0], c[1], [...c[2]]])).toEqual([
      [SHOP_A, 'token-aff-a', ['LIT1001']],
      [SHOP_B, 'token-aff-b', ['REMI1001']],
    ])
    expect(mocks.createFulfillment.mock.calls.map(c => [c[0], c[1], c[2].fulfillmentOrderId, c[2].trackingInfo.number])).toEqual([
      [SHOP_A, 'token-aff-a', 'FO-LIT1001', 'TRK-LIT'],
      [SHOP_B, 'token-aff-b', 'FO-REMI1001', 'TRK-REMI'],
    ])
    expect(results.map(r => [r.shop, r.ok])).toEqual([[SHOP_A, true], [SHOP_B, true]])
    expect(summary).toMatchObject({ ordersChecked: 2, fulfilled: 2, errored: 0 })
    expect(summary!.rows.map(r => [r.baseOrder, r.shop, r.storeName])).toEqual([['LIT1001', SHOP_A, SHOP_A], ['REMI1001', SHOP_B, SHOP_B]])
    expect((await shipmentOf('gid://test/Order/aff-lit1')).trackingNumber).toBe('TRK-LIT')
    expect((await shipmentOf('gid://test/Order/aff-remi1')).trackingNumber).toBe('TRK-REMI')
  })

  it("a row's store label is the project name when the store has one", async () => {
    await prisma.project.update({ where: { id: PROJECT }, data: { name: 'AFF Litzzy' } })
    await prisma.shopifyStore.update({ where: { id: storeA }, data: { projectId: PROJECT } })
    try {
      const { summary } = await runAutoFulfillAllStores({ sheets: SHEETS.slice(0, 1), minAgeDays: 5, apply: false, now: NOW })
      expect(summary!.rows.find(r => r.baseOrder === 'LIT1001')).toMatchObject({ shop: SHOP_A, storeName: 'AFF Litzzy' })
      expect(summary!.rows.find(r => r.baseOrder === 'REMI1001')).toMatchObject({ shop: SHOP_B, storeName: SHOP_B })
    } finally {
      await prisma.shopifyStore.update({ where: { id: storeA }, data: { projectId: null } })
      await prisma.project.update({ where: { id: PROJECT }, data: { name: 'AFF' } })
    }
  })

  it("tracking url comes from the order's store; a store with no trackingPageUrl sends no url", async () => {
    mocks.fetchSheetCsv.mockImplementation(async () => 'Order,Tracking\nLIT1001_1,TRK-LIT\nREMI1001_1,TRK-REMI\n')
    await runAutoFulfillAllStores({ sheets: SHEETS.slice(0, 1), minAgeDays: 5, apply: true, now: NOW })
    expect(callFor(SHOP_A).trackingInfo).toStrictEqual({ company: 'Other', number: 'TRK-LIT', url: `${LITZZY_PAGE}TRK-LIT` })
    expect(callFor(SHOP_B).trackingInfo).toStrictEqual({ company: 'Other', number: 'TRK-REMI' })
    expect((await shipmentOf('gid://test/Order/aff-lit1')).trackingUrl).toBe(`${LITZZY_PAGE}TRK-LIT`)
    expect((await shipmentOf('gid://test/Order/aff-remi1')).trackingUrl).toBeNull()
  })

  it("one store's token failing does not stop the other store's rows", async () => {
    await prisma.shopifyStoreCredential.update({ where: { storeId: storeB }, data: { accessToken: null } })
    try {
      mocks.fetchSheetCsv.mockImplementation(async () => 'Order,Tracking\nLIT1001_1,TRK-LIT\nREMI1001_1,TRK-REMI\n')
      const { results, summary } = await runAutoFulfillAllStores({ sheets: SHEETS.slice(0, 1), minAgeDays: 5, apply: true, now: NOW })
      expect(results.map(r => [r.shop, r.ok])).toEqual([[SHOP_A, true], [SHOP_B, false]])
      expect(mocks.createFulfillment.mock.calls.map(c => [c[0], c[1]])).toEqual([[SHOP_A, 'token-aff-a']])
      expect(summary).toMatchObject({ fulfilled: 1 })
      expect((await shipmentOf('gid://test/Order/aff-lit1')).status).toBe('FULFILLED')
      expect((await shipmentOf('gid://test/Order/aff-remi1')).trackingNumber).toBeNull()
      expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: storeB } })).lastError).toMatch(/^\[auto-fulfill\] /)
    } finally {
      await prisma.shopifyStoreCredential.update({ where: { storeId: storeB }, data: { accessToken: 'token-aff-b' } })
      await prisma.shopifyStore.update({ where: { id: storeB }, data: { lastError: null, lastErrorAt: null } })
    }
  })

  it('a sheet that holds only LIT rows gives Litzzy the same rows, link and numbers as before, and the other store is not asked', async () => {
    mocks.fetchSheetCsv.mockImplementation(async () => `Order,Tracking\nLIT1001_1,${TRACKING}\nLIT9999,TRK-NONE\n`)
    mocks.fetchFulfillmentOrders.mockImplementation(async (shop: string, token: string, names: string[]) => openFulfillmentOrders(shop, token, names.filter(n => n === 'LIT1001')))
    const { results, summary } = await runAutoFulfillAllStores({ sheets: SHEETS.slice(0, 1), minAgeDays: 5, apply: true, now: NOW })
    expect(mocks.fetchFulfillmentOrders.mock.calls.map(c => [c[0], c[1], [...c[2]].sort()])).toEqual([[SHOP_A, 'token-aff-a', ['LIT1001', 'LIT9999']]])
    expect(mocks.createFulfillment.mock.calls).toEqual([[SHOP_A, 'token-aff-a', {
      fulfillmentOrderId: 'FO-LIT1001', lineItems: [{ id: 'FOL-LIT1001', quantity: 1 }],
      trackingInfo: { company: 'Other', number: TRACKING, url: oldLink(TRACKING) }, notifyCustomer: true,
    }]])
    expect(summary).toMatchObject({ ordersChecked: 2, fulfilled: 1, tooRecent: 0, alreadyFulfilled: 0, notFound: 1, needsManual: 0, errored: 0 })
    expect(summary!.rows.map(r => [r.baseOrder, r.status, r.fulfilledLines]).sort()).toEqual([['LIT1001', 'will_fulfill', 1], ['LIT9999', 'not_found', 0]])
    expect(results.map(r => [r.shop, r.ok])).toEqual([[SHOP_A, true], [SHOP_B, true]])
  })

  it("Litzzy's link is byte-identical to the one the sheet's storeBase built, for a number that needs encoding", async () => {
    await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    const input = callFor(SHOP_A)
    expect(input.trackingInfo).toStrictEqual({ company: 'Other', number: TRACKING, url: oldLink(TRACKING) })
    expect(input.notifyCustomer).toBe(true)
    expect((await shipmentOf('gid://test/Order/aff-lit1')).trackingUrl).toBe(oldLink(TRACKING))
  })

  it('a store without a tracking page fulfils with company and number but no link, and stores null', async () => {
    await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    const input = callFor(SHOP_B)
    expect(input.trackingInfo).toStrictEqual({ company: 'Other', number: TRACKING })
    expect(input.notifyCustomer).toBe(true)
    const shipment = await shipmentOf('gid://test/Order/aff-remi1')
    expect(shipment.trackingUrl).toBeNull()
    expect(shipment).toMatchObject({ trackingNumber: TRACKING, status: 'FULFILLED', carrier: 'Other' })
  })

  it("a store with its own page gets that page, never Litzzy's", async () => {
    await prisma.shopifyStore.update({ where: { id: storeB }, data: { trackingPageUrl: 'https://reminiso.example/apps/track?nums=' } })
    await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
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

    await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    expect(callFor(SHOP_B).trackingInfo).toStrictEqual({ company: 'Other', number: TRACKING })
    expect((await shipmentOf('gid://test/Order/aff-remi1')).trackingUrl).toBeNull()

    mocks.createFulfillment.mockClear()
    await prisma.order.update({ where: { id: 'gid://test/Order/aff-remi1' }, data: { fulfillmentStatus: 'UNFULFILLED' } })
    await prisma.shipment.updateMany({ where: { orderId: 'gid://test/Order/aff-remi1' }, data: { shopifyFulfillmentId: null } })
    await prisma.shopifyStore.update({ where: { id: storeB }, data: { trackingPageUrl: 'https://reminiso.example/apps/track?nums=' } })
    await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    expect(callFor(SHOP_B).trackingInfo.url).toBe(`https://reminiso.example/apps/track?nums=${encodeURIComponent(TRACKING)}`)
  })

  it('Preview (apply false) creates nothing and writes no link', async () => {
    await runAutoFulfillAllStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
    expect((await shipmentOf('gid://test/Order/aff-lit1')).trackingUrl).toBeNull()
  })
})
