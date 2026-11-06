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
import { runAutoFulfill, type AutoFulfillSummary } from '@/lib/fulfillment/auto-fulfill'
import type { FulfillmentOrderRef } from '@/lib/fulfillment/build-fulfill-plan'

const SHOP = 'lky.myshopify.com'
const PROJECT = 'proj_lky'
const MANGO = 'sup_lky_mango'
const JOMALL = 'sup_lky_jomall'
const PG = 'sup_lky_pg'
const NOW = new Date('2026-11-06T00:00:00Z')
const PLACED = new Date('2026-10-20T00:00:00Z')
const EXPORTED_AT = new Date('2026-10-22T00:00:00Z')
let storeId = ''

// The two read-back sheets as the suppliers fill them: Mangoshao keeps the bare order number and the line key in Order Vendor,
// Jomall writes the line key in Order Number.
const SHEETS = [
  { id: 'm', name: 'Mangoshao', url: 'https://docs.google.com/spreadsheets/d/lkyMango/edit', enabled: true },
  { id: 'j', name: 'Jomall', url: 'https://docs.google.com/spreadsheets/d/lkyJomall/edit', enabled: true },
]
const HEAD = 'Date,Order Number,Order Vendor,SKU,Tracking\n'
let mangoRows: string[] = []
let jomallRows: string[] = []

type LineSpec = { supplierId?: string; addOn?: boolean; shipment?: boolean }
const lineId = (name: string, n: number) => `gid://test/LineItem/lky-${name}-${n}`
const orderId = (name: string) => `gid://test/Order/lky-${name}`

// What Shopify answers: every line of the order open, the add-ons on a fulfillment order of their own.
let served = new Map<string, FulfillmentOrderRef[]>()

async function makeOrder(name: string, specs: LineSpec[]) {
  await prisma.order.create({ data: {
    id: orderId(name), projectId: PROJECT, storeId, shopifyOrderNumber: `#${name}`, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: PLACED, fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'EXPORTED',
  } })
  let key = 0
  const products: FulfillmentOrderRef['lineItems'] = []
  const addOns: FulfillmentOrderRef['lineItems'] = []
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]
    const id = lineId(name, i + 1)
    const supplierId = s.addOn ? null : (s.supplierId ?? MANGO)
    await prisma.orderLine.create({ data: {
      orderId: orderId(name), shopifyLineId: id, sku: s.addOn ? null : `SKU-${i + 1}`, productTitle: s.addOn ? 'Shipping Protection' : 'Hoodie',
      qty: 1, unitPrice: 10, linePosition: i, resolvedSupplierId: supplierId, designDriveLink: 'https://drive.example/file',
      exportedAt: s.addOn ? null : EXPORTED_AT, exportedToSupplierId: supplierId,
    } })
    if (s.addOn) {
      addOns.push({ id: `FOL-${name}-${i + 1}`, remainingQuantity: 1, shopifyLineId: id, sku: null })
      continue
    }
    key++
    if (s.shipment) await prisma.shipment.create({ data: { orderId: orderId(name), projectId: PROJECT, lineKey: `${name}_${key}`, shopifyLineId: id, supplierId } })
    products.push({ id: `FOL-${name}-${i + 1}`, remainingQuantity: 1, shopifyLineId: id, sku: `SKU-${i + 1}` })
  }
  served.set(name, [
    { id: `FO-${name}`, status: 'OPEN', lineItems: products },
    ...(addOns.length ? [{ id: `FO-${name}-addon`, status: 'OPEN', lineItems: addOns }] : []),
  ])
}

const run = (apply = true) => runAutoFulfill({ shop: SHOP, accessToken: 'token-lky', storeId, sheets: SHEETS, minAgeDays: 5, apply, now: NOW })
const rowOf = (s: AutoFulfillSummary, name: string) => s.rows.find(r => r.baseOrder === name)!
const calls = () => mocks.createFulfillment.mock.calls.map(c => [c[2].fulfillmentOrderId, c[2].lineItems.map((l: any) => l.id), c[2].trackingInfo?.number ?? null])
const shipmentsOf = (name: string) => prisma.shipment.findMany({ where: { orderId: orderId(name) }, orderBy: { lineKey: 'asc' }, select: { lineKey: true, trackingNumber: true, status: true, shopifyFulfillmentId: true } })
const orderState = (name: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId(name) }, select: { fulfillmentStatus: true, pipelineStatus: true } })

async function cleanup() {
  const stores = await prisma.shopifyStore.findMany({ where: { shop: SHOP }, select: { id: true } })
  await prisma.order.deleteMany({ where: { storeId: { in: stores.map(s => s.id) } } })
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.supplier.deleteMany({ where: { id: { in: [MANGO, JOMALL, PG] } } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.project.create({ data: { id: PROJECT, name: 'LKY', startDate: new Date('2026-05-01') } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: SHOP, orderPrefix: 'LKY', connectedAt: new Date('2026-09-01') } })).id
  await prisma.supplier.create({ data: { id: MANGO, name: 'Mangoshao', code: 'LKYMANGO' } })
  await prisma.supplier.create({ data: { id: JOMALL, name: 'Jomall', code: 'LKYJOMALL' } })
  await prisma.supplier.create({ data: { id: PG, name: 'Pgprints', code: 'LKYPG' } })
})

beforeEach(async () => {
  vi.clearAllMocks()
  await prisma.order.deleteMany({ where: { storeId } })
  served = new Map()
  mangoRows = []
  jomallRows = []
  mocks.fetchSheetCsv.mockImplementation(async (url: string) => HEAD + (url.includes('lkyMango') ? mangoRows : jomallRows).map(r => `${r}\n`).join(''))
  mocks.fetchFulfillmentOrders.mockImplementation(async (_shop: string, _token: string, names: string[]) => new Map(names.filter(n => served.has(n)).map(n => [n, {
    displayFulfillmentStatus: 'UNFULFILLED', createdAt: PLACED.toISOString(), fulfillmentOrders: served.get(n),
  }])))
  mocks.createFulfillment.mockResolvedValue({ ok: true, fulfillmentId: 'gid://shopify/Fulfillment/lky' })
})

afterAll(async () => { await cleanup() })

describe('Auto Fulfilled fulfils the line a sheet row names, never the whole order', () => {
  it('a Mangoshao row (bare order number, line key in Order Vendor) fulfils only that line of a three-line order', async () => {
    await makeOrder('LKY1', [{}, {}, {}])
    mangoRows = ['11/4/2026,#LKY1,LKY1_2,SKU-2,MT1']
    const s = await run()
    expect(rowOf(s, 'LKY1')).toMatchObject({ status: 'will_fulfill', fulfilledLines: 1, trackings: ['MT1'] })
    expect(calls()).toEqual([['FO-LKY1', ['FOL-LKY1-2'], 'MT1']])
    expect(await orderState('LKY1')).toEqual({ fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'EXPORTED' })
  })

  it('a bare order number on an order with one product line and an add-on fulfils that line and closes the add-on as before', async () => {
    await makeOrder('LKY2', [{ addOn: true }, {}])
    mangoRows = ['11/4/2026,#LKY2,,SKU-2,MT2']
    const s = await run()
    expect(rowOf(s, 'LKY2')).toMatchObject({ status: 'will_fulfill', fulfilledLines: 2 })
    expect(calls()).toEqual([['FO-LKY2', ['FOL-LKY2-2'], 'MT2'], ['FO-LKY2-addon', ['FOL-LKY2-1'], null]])
    expect(mocks.createFulfillment.mock.calls.map(c => c[2].notifyCustomer)).toEqual([true, false])
    expect(await orderState('LKY2')).toEqual({ fulfillmentStatus: 'FULFILLED', pipelineStatus: 'FULFILLED' })
  })

  it('a bare order number on a two-line order fulfils nothing, though both lines went to that supplier with their files', async () => {
    await makeOrder('LKY3', [{}, {}])
    mangoRows = ['11/4/2026,#LKY3,,SKU-1,MT3']
    const s = await run()
    const row = rowOf(s, 'LKY3')
    expect(row).toMatchObject({ status: 'needs_manual', fulfilledLines: 0, trackings: [] })
    expect(row.message).toContain('mã dòng')
    expect(row.message).toContain('LKY3_1, LKY3_2')
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
    expect(await orderState('LKY3')).toEqual({ fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'EXPORTED' })
  })

  it("a row in Jomall's sheet for a line sent to Mangoshao is held naming both; once the line went to Jomall it is fulfilled as before", async () => {
    await makeOrder('LKY4', [{ shipment: true }, { shipment: true }])
    jomallRows = ['11/4/2026,#LKY4_2,LKY4,SKU-2,JT4']
    const held = rowOf(await run(), 'LKY4')
    expect(held).toMatchObject({ status: 'needs_manual', fulfilledLines: 0 })
    expect(held.message).toContain('LKY4_2')
    expect(held.message).toContain('Mangoshao')
    expect(held.message).toContain('Jomall')
    expect(mocks.createFulfillment).not.toHaveBeenCalled()

    await prisma.orderLine.updateMany({ where: { shopifyLineId: lineId('LKY4', 2) }, data: { resolvedSupplierId: JOMALL, exportedToSupplierId: JOMALL } })
    expect(rowOf(await run(), 'LKY4')).toMatchObject({ status: 'will_fulfill', fulfilledLines: 1 })
    expect(calls()).toEqual([['FO-LKY4', ['FOL-LKY4-2'], 'JT4']])
    expect(await shipmentsOf('LKY4')).toEqual([
      { lineKey: 'LKY4_1', trackingNumber: null, status: 'PENDING', shopifyFulfillmentId: null },
      { lineKey: 'LKY4_2', trackingNumber: 'JT4', status: 'FULFILLED', shopifyFulfillmentId: 'gid://shopify/Fulfillment/lky' },
    ])
  })

  it('an API push tracking row whose key is the bare order number never fulfils the whole order', async () => {
    for (const [name, lines] of [['LKY5', 1], ['LKY6', 2]] as const) {
      await makeOrder(name, Array.from({ length: lines }, () => ({ supplierId: PG })))
      await prisma.shipment.create({ data: { orderId: orderId(name), projectId: PROJECT, lineKey: name, shopifyLineId: lineId(name, 1), supplierId: PG, trackingNumber: `PG-${name}` } })
      await prisma.supplierOrderPush.create({ data: { orderId: orderId(name), supplierId: PG, externalOrderId: `lky-${name}`, status: 'CREATED', requestJson: '{}', exportMarked: true } })
    }
    const s = await run()
    expect(rowOf(s, 'LKY5')).toMatchObject({ status: 'needs_manual', fulfilledLines: 0 })
    expect(rowOf(s, 'LKY6')).toMatchObject({ status: 'needs_manual', fulfilledLines: 0 })
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
  })

  it('Preview (apply false) gives the same verdicts as the run and writes nothing', async () => {
    await makeOrder('LKY7', [{}, {}, {}])
    await makeOrder('LKY8', [{}, {}])
    await makeOrder('LKY9', [{ shipment: true }])
    await makeOrder('LKY10', [{}])
    mangoRows = ['11/4/2026,#LKY7,LKY7_3,SKU-3,MT7', '11/4/2026,#LKY8,,SKU-1,MT8', '11/4/2026,#LKY10,,SKU-1,MT10']
    jomallRows = ['11/4/2026,#LKY9_1,LKY9,SKU-1,JT9']
    const names = ['LKY7', 'LKY8', 'LKY9', 'LKY10']
    const state = async () => Promise.all(names.map(async n => [await shipmentsOf(n), await orderState(n)]))
    const before = await state()

    const preview = await run(false)
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
    expect(await state()).toEqual(before)
    const verdicts = (s: AutoFulfillSummary) => names.map(n => [n, rowOf(s, n).status, rowOf(s, n).message ?? null])
    expect(verdicts(preview)).toEqual([
      ['LKY7', 'will_fulfill', null],
      ['LKY8', 'needs_manual', expect.stringContaining('mã dòng')],
      ['LKY9', 'needs_manual', expect.stringContaining('Mangoshao')],
      ['LKY10', 'will_fulfill', null],
    ])

    const applied = await run(true)
    expect(verdicts(applied)).toEqual(verdicts(preview))
    expect(calls()).toEqual([['FO-LKY7', ['FOL-LKY7-3'], 'MT7'], ['FO-LKY10', ['FOL-LKY10-1'], 'MT10']])
  })
})
