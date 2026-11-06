import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import { applyTrackingWebhook } from '@/lib/repos/pgprints-push'
import { upsertLineTracking } from '@/lib/repos/supplier-push-core'

// A supplier's tracking lands on the Shipment row of the line key it is for. A row made when add-ons still counted can
// point at an add-on under that key: the writer moves it to the product line the tracking is for.
const SHOP = 'stk-store.myshopify.com'
const PROJECT = 'proj_stk'
const SUPPLIER = 'sup_stk'
const OTHER = 'sup_stk_other'
let storeId = ''

const lineId = (order: number, n: number) => `gid://shopify/LineItem/stk-${order}-${n}`
const ADD_ON = { productTitle: 'Custom Name Add-on', shopifyProductType: 'Add-on', sku: null, resolvedSupplierId: null }
const TOTE = { productTitle: 'Custom Tote Bag', shopifyProductType: 'Tote', sku: 'TOTE-1', resolvedSupplierId: SUPPLIER }

async function makeOrder(number: number) {
  const order = await prisma.order.create({
    data: {
      id: `gid://shopify/Order/stk-${number}`, projectId: PROJECT, storeId, shopifyOrderNumber: `#REMI${number}`, financialStatus: 'PAID',
      currency: 'USD', grossAmount: 10, expectedPayout: 9, totalFees: 1, refundedAmount: 0, placedAt: new Date('2026-10-01'), fulfillmentStatus: 'UNFULFILLED',
      lines: { create: [ADD_ON, TOTE].map((s, i) => ({ shopifyLineId: lineId(number, i + 1), linePosition: i, qty: 1, unitPrice: 5, ...s })) },
    },
  })
  return order
}

// The row under the order's first key, as the tracking sync wrote it: on the add-on (made when add-ons counted) or on the tote.
async function rowOn(orderId: string, key: string, line: 'add-on' | 'tote', number: number, extra: Record<string, unknown> = {}) {
  const spec = line === 'add-on' ? { shopifyLineId: lineId(number, 1), sku: null, productTitle: ADD_ON.productTitle } : { shopifyLineId: lineId(number, 2), sku: 'OLD-SKU', productTitle: 'Old title' }
  return prisma.shipment.create({ data: { orderId, projectId: PROJECT, lineKey: key, ...spec, ...extra } })
}

const rowsOf = (orderId: string) => prisma.shipment.findMany({ where: { orderId }, orderBy: { lineKey: 'asc' } })
const shape = (r: Awaited<ReturnType<typeof rowsOf>>[number]) => [r.lineKey, r.shopifyLineId, r.sku, r.productTitle, r.trackingNumber, r.carrier, r.supplierId, r.status]

beforeAll(async () => {
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUPPLIER, OTHER] } } })
  await prisma.project.create({ data: { id: PROJECT, name: 'STK', startDate: new Date('2026-05-01') } })
  await prisma.supplier.create({ data: { id: SUPPLIER, name: 'STK Supplier', code: 'STK' } })
  await prisma.supplier.create({ data: { id: OTHER, name: 'STK Other', code: 'STKOTHER' } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: SHOP, orderPrefix: 'REMI' } })).id
})

beforeEach(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUPPLIER, OTHER] } } })
})

describe('PGprints tracking (applyTrackingWebhook)', () => {
  async function pushFor(orderId: string, number: number) {
    await prisma.supplierOrderPush.create({ data: {
      orderId, supplierId: SUPPLIER, externalOrderId: `stk-pg-${number}`, status: 'CREATED',
      requestJson: JSON.stringify({ line_items: [{ refId: `REMI${number}_1`, sku: 'TOTE-1', name: 'Custom Tote Bag' }] }),
    } })
  }
  const hook = (number: number) => applyTrackingWebhook({ orderId: `stk-pg-${number}`, sku: 'TOTE-1', trackingNumber: `PG-${number}`, carrierCode: 'usps' }, [storeId])

  it('moves a row that still points at the add-on to the product the tracking is for', async () => {
    const order = await makeOrder(9901)
    await pushFor(order.id, 9901)
    await rowOn(order.id, 'REMI9901_1', 'add-on', 9901)

    expect(await hook(9901)).toEqual({ ignored: false, shipments: 1 })

    expect((await rowsOf(order.id)).map(shape)).toEqual([['REMI9901_1', lineId(9901, 2), 'TOTE-1', 'Custom Tote Bag', 'PG-9901', 'usps', SUPPLIER, 'FULFILLED']])
  })

  it('updates a row that already points at the product as before: tracking, carrier, supplier, status, nothing else', async () => {
    const order = await makeOrder(9902)
    await pushFor(order.id, 9902)
    await rowOn(order.id, 'REMI9902_1', 'tote', 9902)

    expect(await hook(9902)).toEqual({ ignored: false, shipments: 1 })

    expect((await rowsOf(order.id)).map(shape)).toEqual([['REMI9902_1', lineId(9902, 2), 'OLD-SKU', 'Old title', 'PG-9902', 'usps', SUPPLIER, 'FULFILLED']])
  })

  it('creates the row on the product line when there is none', async () => {
    const order = await makeOrder(9903)
    await pushFor(order.id, 9903)

    expect(await hook(9903)).toEqual({ ignored: false, shipments: 1 })

    expect((await rowsOf(order.id)).map(shape)).toEqual([['REMI9903_1', lineId(9903, 2), 'TOTE-1', 'Custom Tote Bag', 'PG-9903', 'usps', SUPPLIER, 'FULFILLED']])
  })
})

describe('Merchize, Bondre and Printway tracking (upsertLineTracking)', () => {
  const write = (orderId: string, number = 'MZ-1') => upsertLineTracking({ orderId, supplierId: SUPPLIER, prevExportJson: null }, () => ({ number, company: 'UPS' }))

  it('moves a row that still points at the add-on to the product the tracking is for', async () => {
    const order = await makeOrder(9911)
    await rowOn(order.id, 'REMI9911_1', 'add-on', 9911)

    expect(await write(order.id)).toBe(1)

    expect((await rowsOf(order.id)).map(shape)).toEqual([['REMI9911_1', lineId(9911, 2), 'TOTE-1', 'Custom Tote Bag', 'MZ-1', 'UPS', SUPPLIER, 'FULFILLED']])
  })

  it('moves it also when the add-on row already carries this tracking number', async () => {
    const order = await makeOrder(9912)
    await rowOn(order.id, 'REMI9912_1', 'add-on', 9912, { trackingNumber: 'MZ-1', carrier: 'UPS', supplierId: SUPPLIER, status: 'FULFILLED' })

    expect(await write(order.id)).toBe(1)

    expect((await rowsOf(order.id)).map(shape)).toEqual([['REMI9912_1', lineId(9912, 2), 'TOTE-1', 'Custom Tote Bag', 'MZ-1', 'UPS', SUPPLIER, 'FULFILLED']])
  })

  it('updates a row that already points at the product as before: tracking, carrier, supplier, status, nothing else', async () => {
    const order = await makeOrder(9913)
    await rowOn(order.id, 'REMI9913_1', 'tote', 9913)

    expect(await write(order.id)).toBe(1)

    expect((await rowsOf(order.id)).map(shape)).toEqual([['REMI9913_1', lineId(9913, 2), 'OLD-SKU', 'Old title', 'MZ-1', 'UPS', SUPPLIER, 'FULFILLED']])
  })

  it('leaves a row on the product that already has this tracking as it is', async () => {
    const order = await makeOrder(9914)
    const before = await rowOn(order.id, 'REMI9914_1', 'tote', 9914, { trackingNumber: 'MZ-1', carrier: 'UPS', supplierId: SUPPLIER, status: 'IN_TRANSIT' })

    expect(await write(order.id)).toBe(0)

    expect(await rowsOf(order.id)).toEqual([before])
  })

  it('creates the row on the product line when there is none', async () => {
    const order = await makeOrder(9915)

    expect(await write(order.id)).toBe(1)

    expect((await rowsOf(order.id)).map(shape)).toEqual([['REMI9915_1', lineId(9915, 2), 'TOTE-1', 'Custom Tote Bag', 'MZ-1', 'UPS', SUPPLIER, 'FULFILLED']])
  })

  // Auto Fulfilled takes a pushed tracking only from a row of the push's supplier (pushedShipmentRows).
  it('a row the order sync made under another supplier takes the pushed supplier with the tracking', async () => {
    const order = await makeOrder(9916)
    await rowOn(order.id, 'REMI9916_1', 'tote', 9916, { supplierId: OTHER })

    expect(await write(order.id)).toBe(1)

    expect((await rowsOf(order.id)).map(shape)).toEqual([['REMI9916_1', lineId(9916, 2), 'OLD-SKU', 'Old title', 'MZ-1', 'UPS', SUPPLIER, 'FULFILLED']])
  })

  it('a row that already has this tracking under another supplier takes the pushed supplier, the rest as it was', async () => {
    const order = await makeOrder(9917)
    await rowOn(order.id, 'REMI9917_1', 'tote', 9917, { trackingNumber: 'MZ-1', carrier: 'UPS', supplierId: OTHER, status: 'IN_TRANSIT' })

    expect(await write(order.id)).toBe(1)

    expect((await rowsOf(order.id)).map(shape)).toEqual([['REMI9917_1', lineId(9917, 2), 'OLD-SKU', 'Old title', 'MZ-1', 'UPS', SUPPLIER, 'IN_TRANSIT']])
  })

  it('never touches a row that has a Shopify fulfilment and a tracking', async () => {
    const order = await makeOrder(9918)
    const before = await rowOn(order.id, 'REMI9918_1', 'tote', 9918, { trackingNumber: 'SHOP-1', shopifyFulfillmentId: 'gid://shopify/Fulfillment/1', supplierId: OTHER, status: 'DELIVERED' })

    expect(await write(order.id)).toBe(0)

    expect(await rowsOf(order.id)).toEqual([before])
  })
})
