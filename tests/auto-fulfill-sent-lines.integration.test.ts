import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchFulfillmentOrders: vi.fn(),
  createFulfillment: vi.fn(),
}))
vi.mock('@/lib/shopify-orders', () => ({
  fetchOrderFulfillmentOrdersByNames: mocks.fetchFulfillmentOrders,
  createFulfillment: mocks.createFulfillment,
}))

import { prisma } from '@/lib/db'
import { runAutoFulfill, type AutoFulfillSummary } from '@/lib/fulfillment/auto-fulfill'
import type { FulfillmentOrderRef, OrderRow } from '@/lib/fulfillment/build-fulfill-plan'

const SHOP = 'snt.myshopify.com'
const PROJECT = 'proj_snt'
const JOMALL = 'sup_snt_jomall'
const PGPRINTS = 'sup_snt_pg'
const NOW = new Date('2026-11-06T00:00:00Z')
const PLACED = new Date('2026-10-20T00:00:00Z')
const EXPORTED_AT = new Date('2026-10-22T00:00:00Z')
let storeId = ''

type LineSpec = { exported?: boolean; supplierId?: string; title?: string; addOn?: boolean }
const lineId = (name: string, n: number) => `gid://test/LineItem/snt-${name}-${n}`
const orderId = (name: string) => `gid://test/Order/snt-${name}`

// What Shopify answers for each order: every line of the order still open, the add-ons on a fulfillment order of their own.
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
    const supplierId = s.addOn ? null : (s.supplierId ?? JOMALL)
    await prisma.orderLine.create({ data: {
      orderId: orderId(name), shopifyLineId: id, sku: s.addOn ? null : `SKU-${i + 1}`, productTitle: s.title ?? (s.addOn ? 'Shipping Protection' : 'Hoodie'),
      qty: 1, unitPrice: 10, linePosition: i, resolvedSupplierId: supplierId, designDriveLink: 'https://drive.example/file',
      exportedAt: s.exported ? EXPORTED_AT : null, exportedToSupplierId: s.exported ? supplierId : null,
    } })
    if (s.addOn) {
      addOns.push({ id: `FOL-${name}-${i + 1}`, remainingQuantity: 1, shopifyLineId: id, sku: null })
      continue
    }
    key++
    await prisma.shipment.create({ data: { orderId: orderId(name), projectId: PROJECT, lineKey: `${name}_${key}`, shopifyLineId: id, supplierId } })
    products.push({ id: `FOL-${name}-${i + 1}`, remainingQuantity: 1, shopifyLineId: id, sku: `SKU-${i + 1}` })
  }
  served.set(name, [
    { id: `FO-${name}`, status: 'OPEN', lineItems: products },
    ...(addOns.length ? [{ id: `FO-${name}-addon`, status: 'OPEN', lineItems: addOns }] : []),
  ])
}

const run = (rows: Record<string, OrderRow[]>, apply = true, sheetName = 'Jomall') => runAutoFulfill({
  shop: SHOP, accessToken: 'token-snt', storeId, sheets: [],
  sheetData: [{ name: sheetName, groups: new Map(Object.entries(rows)) }],
  minAgeDays: 5, apply, now: NOW,
})
const rowOf = (s: AutoFulfillSummary, name: string) => s.rows.find(r => r.baseOrder === name)!
const fulfilledFo = () => mocks.createFulfillment.mock.calls.map(c => [c[2].fulfillmentOrderId, c[2].lineItems.map((l: any) => l.id), c[2].trackingInfo?.number ?? null])
const shipmentsOf = (name: string) => prisma.shipment.findMany({ where: { orderId: orderId(name) }, orderBy: { lineKey: 'asc' }, select: { lineKey: true, trackingNumber: true, status: true, shopifyFulfillmentId: true } })
const orderState = (name: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId(name) }, select: { fulfillmentStatus: true, pipelineStatus: true } })

async function cleanup() {
  const stores = await prisma.shopifyStore.findMany({ where: { shop: SHOP }, select: { id: true } })
  await prisma.order.deleteMany({ where: { storeId: { in: stores.map(s => s.id) } } })
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.supplier.deleteMany({ where: { id: { in: [JOMALL, PGPRINTS] } } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.project.create({ data: { id: PROJECT, name: 'SNT', startDate: new Date('2026-05-01') } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: SHOP, orderPrefix: 'SNT', connectedAt: new Date('2026-09-01') } })).id
  await prisma.supplier.create({ data: { id: JOMALL, name: 'Jomall', code: 'SNTJOM' } })
  await prisma.supplier.create({ data: { id: PGPRINTS, name: 'Pgprints', code: 'SNTPG' } })
})

beforeEach(async () => {
  vi.clearAllMocks()
  await prisma.order.deleteMany({ where: { storeId } })
  served = new Map()
  mocks.fetchFulfillmentOrders.mockImplementation(async (_shop: string, _token: string, names: string[]) => new Map(names.filter(n => served.has(n)).map(n => [n, {
    displayFulfillmentStatus: 'UNFULFILLED', createdAt: PLACED.toISOString(), fulfillmentOrders: served.get(n),
  }])))
  mocks.createFulfillment.mockResolvedValue({ ok: true, fulfillmentId: 'gid://shopify/Fulfillment/snt' })
})

afterAll(async () => { await cleanup() })

describe('Auto Fulfilled fulfils a product line only after it went to a supplier', () => {
  it('a per-line row for an exported line is fulfilled as before', async () => {
    await makeOrder('SNT1', [{ exported: true }])
    const s = await run({ SNT1: [{ lineKey: 'SNT1_1', tracking: 'TRK1' }] })
    expect(rowOf(s, 'SNT1')).toMatchObject({ status: 'will_fulfill', fulfilledLines: 1, trackings: ['TRK1'] })
    expect(fulfilledFo()).toEqual([['FO-SNT1', ['FOL-SNT1-1'], 'TRK1']])
    expect(await shipmentsOf('SNT1')).toEqual([{ lineKey: 'SNT1_1', trackingNumber: 'TRK1', status: 'FULFILLED', shopifyFulfillmentId: 'gid://shopify/Fulfillment/snt' }])
    expect(await orderState('SNT1')).toEqual({ fulfillmentStatus: 'FULFILLED', pipelineStatus: 'FULFILLED' })
  })

  it('a per-line row for a line with no export and no push is held, naming the line, and nothing is fulfilled', async () => {
    await makeOrder('SNT2', [{ exported: false }])
    const s = await run({ SNT2: [{ lineKey: 'SNT2_1', tracking: 'TRK2' }] })
    const row = rowOf(s, 'SNT2')
    expect(row).toMatchObject({ status: 'needs_manual', fulfilledLines: 0, trackings: [] })
    expect(row.message).toContain('SNT2_1')
    expect(row.message).toContain('chưa export sang xưởng')
    expect(s).toMatchObject({ fulfilled: 0, needsManual: 1 })
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
    expect(await shipmentsOf('SNT2')).toEqual([{ lineKey: 'SNT2_1', trackingNumber: null, status: 'PENDING', shopifyFulfillmentId: null }])
    expect(await orderState('SNT2')).toEqual({ fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'EXPORTED' })
  })

  it('two per-line rows, one line exported and one not: the order is held and neither line is fulfilled', async () => {
    await makeOrder('SNT3', [{ exported: true }, { exported: false }])
    const s = await run({ SNT3: [{ lineKey: 'SNT3_1', tracking: 'TRK3' }, { lineKey: 'SNT3_2', tracking: 'TRK3' }] })
    const row = rowOf(s, 'SNT3')
    expect(row.status).toBe('needs_manual')
    expect(row.message).toContain('SNT3_2')
    expect(row.message).not.toContain('SNT3_1')
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
    expect((await shipmentsOf('SNT3')).map(x => x.trackingNumber)).toEqual([null, null])
  })

  it('a whole-order row fulfils every open line when each one was exported, and holds the order naming the one that was not', async () => {
    await makeOrder('SNT4', [{ exported: true }, { exported: true }])
    await makeOrder('SNT5', [{ exported: true }, { exported: false }])
    const s = await run({ SNT4: [{ lineKey: 'SNT4', tracking: 'TRK4' }], SNT5: [{ lineKey: 'SNT5', tracking: 'TRK5' }] })
    expect(rowOf(s, 'SNT4')).toMatchObject({ status: 'will_fulfill', fulfilledLines: 2 })
    const held = rowOf(s, 'SNT5')
    expect(held).toMatchObject({ status: 'needs_manual', fulfilledLines: 0 })
    expect(held.message).toContain('SNT5_2')
    expect(held.message).toContain('chưa export sang xưởng')
    expect(fulfilledFo()).toEqual([['FO-SNT4', ['FOL-SNT4-1', 'FOL-SNT4-2'], 'TRK4']])
  })

  it('add-on lines still close (own fulfillment order, no tracking, no email) when the product line was exported', async () => {
    await makeOrder('SNT6', [{ addOn: true }, { exported: true }])
    const s = await run({ SNT6: [{ lineKey: 'SNT6_1', tracking: 'TRK6' }] })
    expect(rowOf(s, 'SNT6')).toMatchObject({ status: 'will_fulfill', fulfilledLines: 2 })
    expect(fulfilledFo()).toEqual([['FO-SNT6', ['FOL-SNT6-2'], 'TRK6'], ['FO-SNT6-addon', ['FOL-SNT6-1'], null]])
    expect(mocks.createFulfillment.mock.calls.map(c => c[2].notifyCustomer)).toEqual([true, false])
  })

  describe('rows from an API push (PGprints, status CREATED)', () => {
    const push = (name: string, data: { exportMarked: boolean; lineIds?: string[] | null }) => prisma.supplierOrderPush.create({ data: {
      orderId: orderId(name), supplierId: PGPRINTS, externalOrderId: `snt-${name}`, status: 'CREATED', requestJson: '{}',
      exportMarked: data.exportMarked, prevExportJson: data.lineIds === null ? null : JSON.stringify({ lineIds: data.lineIds ?? [] }),
    } })
    const track = (name: string, lineKey: string, tracking: string) => prisma.shipment.updateMany({ where: { orderId: orderId(name), lineKey }, data: { trackingNumber: tracking } })
    const ids = async (name: string) => (await prisma.orderLine.findMany({ where: { orderId: orderId(name) }, orderBy: { linePosition: 'asc' }, select: { id: true } })).map(l => l.id)

    it('a pushed, exported line with supplier tracking is fulfilled as before', async () => {
      await makeOrder('SNT7', [{ exported: true, supplierId: PGPRINTS }])
      await push('SNT7', { exportMarked: true, lineIds: await ids('SNT7') })
      await track('SNT7', 'SNT7_1', 'PG7')
      const s = await run({})
      expect(rowOf(s, 'SNT7')).toMatchObject({ status: 'will_fulfill', fulfilledLines: 1 })
      expect(fulfilledFo()).toEqual([['FO-SNT7', ['FOL-SNT7-1'], 'PG7']])
    })

    it('a line the push carried counts as sent even when the push was never marked exported', async () => {
      await makeOrder('SNT8', [{ exported: false, supplierId: PGPRINTS }])
      await push('SNT8', { exportMarked: false, lineIds: await ids('SNT8') })
      await track('SNT8', 'SNT8_1', 'PG8')
      expect(rowOf(await run({}), 'SNT8')).toMatchObject({ status: 'will_fulfill', fulfilledLines: 1 })
      expect(fulfilledFo()).toEqual([['FO-SNT8', ['FOL-SNT8-1'], 'PG8']])
    })

    it('a push from before sends went by line carries every line of its supplier', async () => {
      await makeOrder('SNT9', [{ exported: false, supplierId: PGPRINTS }])
      await push('SNT9', { exportMarked: false, lineIds: null })
      await track('SNT9', 'SNT9_1', 'PG9')
      expect(rowOf(await run({}), 'SNT9')).toMatchObject({ status: 'will_fulfill', fulfilledLines: 1 })
    })

    it('a supplier-tracked line the push did not carry and nobody exported holds the order', async () => {
      await makeOrder('SNT10', [{ exported: true, supplierId: PGPRINTS }, { exported: false, supplierId: PGPRINTS }])
      await push('SNT10', { exportMarked: true, lineIds: (await ids('SNT10')).slice(0, 1) })
      await track('SNT10', 'SNT10_1', 'PG10')
      await track('SNT10', 'SNT10_2', 'PG10')
      const row = rowOf(await run({}), 'SNT10')
      expect(row.status).toBe('needs_manual')
      expect(row.message).toContain('SNT10_2')
      expect(mocks.createFulfillment).not.toHaveBeenCalled()
    })
  })

  it('Preview (apply false) reports the statuses the run acts on, and writes nothing', async () => {
    await makeOrder('SNT11', [{ exported: true }])
    await makeOrder('SNT12', [{ exported: true }, { exported: false }])
    await makeOrder('SNT13', [{ exported: false }])
    const rows = {
      SNT11: [{ lineKey: 'SNT11_1', tracking: 'TRK11' }],
      SNT12: [{ lineKey: 'SNT12', tracking: 'TRK12' }],
      SNT13: [{ lineKey: 'SNT13_1', tracking: 'TRK13' }],
    }
    const names = Object.keys(rows)
    const state = async () => Promise.all(names.map(async n => [await shipmentsOf(n), await orderState(n)]))
    const before = await state()

    const preview = await run(rows, false)
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
    expect(await state()).toEqual(before)
    const statuses = (s: AutoFulfillSummary) => names.map(n => [n, rowOf(s, n).status, rowOf(s, n).message ?? null])
    expect(statuses(preview)).toEqual([
      ['SNT11', 'will_fulfill', null],
      ['SNT12', 'needs_manual', expect.stringContaining('SNT12_2')],
      ['SNT13', 'needs_manual', expect.stringContaining('SNT13_1')],
    ])

    const applied = await run(rows, true)
    expect(statuses(applied)).toEqual(statuses(preview))
    expect(fulfilledFo()).toEqual([['FO-SNT11', ['FOL-SNT11-1'], 'TRK11']])
  })

  // The nightly reads every order the sheets list (3,165 on 2026-11-04): the pushes read beside the lines must not hit the query limit.
  it('a sheet listing more orders than one query can bind: every order is read with its lines and pushes', async () => {
    const ids = Array.from({ length: 1200 }, (_, n) => n)
    const name = (n: number) => `SNTB${n}`
    await prisma.order.createMany({ data: ids.map(n => ({
      id: orderId(name(n)), projectId: PROJECT, storeId, shopifyOrderNumber: `#${name(n)}`, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: PLACED, fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'EXPORTED',
    })) })
    // Even orders exported; n % 4 === 1 carried by a push that was never marked; n % 4 === 3 never sent.
    await prisma.orderLine.createMany({ data: ids.map(n => ({
      orderId: orderId(name(n)), shopifyLineId: lineId(name(n), 1), sku: 'SKU-1', productTitle: 'Hoodie', qty: 1, unitPrice: 10,
      resolvedSupplierId: PGPRINTS, exportedAt: n % 2 === 0 ? EXPORTED_AT : null, exportedToSupplierId: n % 2 === 0 ? PGPRINTS : null,
    })) })
    await prisma.shipment.createMany({ data: ids.map(n => ({ orderId: orderId(name(n)), projectId: PROJECT, lineKey: `${name(n)}_1`, shopifyLineId: lineId(name(n), 1), supplierId: PGPRINTS })) })
    await prisma.supplierOrderPush.createMany({ data: ids.filter(n => n % 4 === 1).map(n => ({
      orderId: orderId(name(n)), supplierId: PGPRINTS, externalOrderId: `snt-${name(n)}`, status: 'CREATED', requestJson: '{}', exportMarked: false, prevExportJson: null,
    })) })
    for (const n of ids) served.set(name(n), [{ id: `FO-${name(n)}`, status: 'OPEN', lineItems: [{ id: `FOL-${name(n)}`, remainingQuantity: 1, shopifyLineId: lineId(name(n), 1), sku: 'SKU-1' }] }])

    const s = await run(Object.fromEntries(ids.map(n => [name(n), [{ lineKey: `${name(n)}_1`, tracking: `TB${n}` }]])), false, 'Pgprints')

    expect(s.ordersChecked).toBe(ids.length)
    const withStatus = (status: string) => ids.filter(n => rowOf(s, name(n)).status === status)
    expect(withStatus('will_fulfill')).toEqual(ids.filter(n => n % 4 !== 3))
    expect(withStatus('needs_manual')).toEqual(ids.filter(n => n % 4 === 3))
  }, 120_000)
})
