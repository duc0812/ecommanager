import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { prisma } from '@/lib/db'
import { syncVnepacketTracking, vnepacketShipmentRows } from '@/lib/repos/vnepacket-tracking'
import { VNEPACKET_KEYS, saveVnepacketSettings } from '@/lib/vnepacket-settings'

const SHOP = 'vnep-store.myshopify.com'
const PROJECT = 'proj_vnep'
const GO3D = 'sup_vnep_go3d'
const OTHER = 'sup_vnep_other'
let storeId = ''

const lineId = (order: number, n: number) => `gid://shopify/LineItem/vnep-${order}-${n}`

async function makeOrder(number: number, lines: Array<{ supplier: string | null; exported: boolean }>) {
  return prisma.order.create({
    data: {
      id: `gid://shopify/Order/vnep-${number}`, projectId: PROJECT, storeId, shopifyOrderNumber: `#LIT${number}`, financialStatus: 'PAID',
      currency: 'USD', grossAmount: 10, expectedPayout: 9, totalFees: 1, refundedAmount: 0, placedAt: new Date(), fulfillmentStatus: 'UNFULFILLED',
      pipelineStatus: 'EXPORTED',
      lines: {
        create: lines.map((l, i) => ({
          shopifyLineId: lineId(number, i + 1), linePosition: i, qty: 1, unitPrice: 5, productTitle: `Wood sign ${i + 1}`, sku: `WS-${i + 1}`,
          resolvedSupplierId: l.supplier, exportedToSupplierId: l.exported ? l.supplier : null, exportedAt: l.exported ? new Date() : null,
        })),
      },
    },
  })
}

const tracking = (number: string, events: string[], status: string | null = null) => ({
  status: 'success', message: 'get tracking success',
  tracking: {
    tracking_number: number, carrier: null, label_path: null, is_checkin: true, status,
    events: { statusDetails: events.map((d, i) => ({ description: d, date: `2026-11-1${2 - i} 08:00:00`, location: 'US' })) },
  },
})

// What VNEpacket knows, by the reference asked for.
let known: Record<string, unknown> = {}
const asked: string[] = []

beforeAll(async () => {
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.supplier.deleteMany({ where: { id: { in: [GO3D, OTHER] } } })
  await prisma.project.create({ data: { id: PROJECT, name: 'VNEP', startDate: new Date('2026-05-01') } })
  await prisma.supplier.create({ data: { id: GO3D, name: 'Gỗ 3D test', code: 'VNEP-GO3D', apiType: 'vnepacket' } })
  await prisma.supplier.create({ data: { id: OTHER, name: 'Other', code: 'VNEP-OTHER' } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: SHOP, orderPrefix: 'LIT' } })).id
  await saveVnepacketSettings({ username: 'shop@test', password: 'pw' })
})

beforeEach(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
  known = {}
  asked.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input)
    if (url.endsWith('/me')) return new Response(JSON.stringify({ status: 'success', access_token: 'tok', fullName: 'Shop' }), { status: 200 })
    const ref = decodeURIComponent(url.split('/tracking/get/')[1] ?? '')
    asked.push(ref)
    return new Response(JSON.stringify(known[ref] ?? { status: 'error', message: 'shipment not found' }), { status: 200 })
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.supplier.deleteMany({ where: { id: { in: [GO3D, OTHER] } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(VNEPACKET_KEYS) } } })
})

const rowsOf = (orderId: string) => prisma.shipment.findMany({ where: { orderId }, orderBy: { lineKey: 'asc' } })

describe('syncVnepacketTracking', () => {
  it('writes the parcel found under the line key on that line, with status and checkpoints', async () => {
    const order = await makeOrder(7001, [{ supplier: GO3D, exported: true }])
    known['LIT7001_1'] = tracking('9261290376159132521581', ['ARRIVED POST OFFICE', 'SHIPMENT LABEL CREATED'])

    const r = await syncVnepacketTracking({ withLines: true })

    expect(r).toMatchObject({ pushes: 1, found: 1, shipments: 1 })
    const [row] = await rowsOf(order.id)
    expect(row).toMatchObject({
      lineKey: 'LIT7001_1', shopifyLineId: lineId(7001, 1), trackingNumber: '9261290376159132521581', carrier: 'USPS', supplierId: GO3D,
      status: 'IN_TRANSIT', crawlSource: 'vnepacket', lastMileTrackingNumber: '9261290376159132521581',
    })
    expect(JSON.parse(row.checkpointsJson ?? '[]')[0].desc).toBe('ARRIVED POST OFFICE — US')
  })

  it('falls back to the bare order number when the order has one Gỗ 3D line', async () => {
    const order = await makeOrder(7002, [{ supplier: OTHER, exported: true }, { supplier: GO3D, exported: true }])
    known['#LIT7002'] = tracking('UUS6AN1260246558603', ['SHIPMENT LABEL CREATED'])

    await syncVnepacketTracking()

    expect(asked).toEqual(['#LIT7002_2', 'LIT7002_2', '#LIT7002'])
    expect((await rowsOf(order.id)).map(r => [r.lineKey, r.trackingNumber, r.status])).toEqual([['LIT7002_2', 'UUS6AN1260246558603', 'IN_TRANSIT']])
  })

  it('never reads a bare order number onto one of several Gỗ 3D lines', async () => {
    const order = await makeOrder(7003, [{ supplier: GO3D, exported: true }, { supplier: GO3D, exported: true }])
    known['LIT7003'] = tracking('92000000000000000000001', ['DEPARTED FACILITY'])
    known['LIT7003_2'] = tracking('92000000000000000000002', ['DEPARTED FACILITY'])

    await syncVnepacketTracking()

    expect(asked).not.toContain('LIT7003')
    expect((await rowsOf(order.id)).map(r => [r.lineKey, r.trackingNumber])).toEqual([['LIT7003_2', '92000000000000000000002']])
  })

  it('skips lines not exported to Gỗ 3D, and delivered ones on the daily run', async () => {
    const order = await makeOrder(7004, [{ supplier: GO3D, exported: false }, { supplier: GO3D, exported: true }])
    await prisma.shipment.create({ data: { orderId: order.id, projectId: PROJECT, lineKey: 'LIT7004_2', status: 'DELIVERED', crawlSource: 'vnepacket', trackingNumber: 'X' } })

    expect(await syncVnepacketTracking()).toMatchObject({ pushes: 0 })
    expect(asked).toEqual([])
  })

  it('keeps a different number Shopify already fulfilled the line with', async () => {
    const order = await makeOrder(7005, [{ supplier: GO3D, exported: true }])
    await prisma.shipment.create({ data: { orderId: order.id, projectId: PROJECT, lineKey: 'LIT7005_1', shopifyFulfillmentId: 'gid://shopify/Fulfillment/1', trackingNumber: 'SHOPIFY-1', status: 'FULFILLED' } })
    known['LIT7005_1'] = tracking('9200NEW', ['DEPARTED FACILITY'])

    expect(await syncVnepacketTracking()).toMatchObject({ found: 1, shipments: 0 })
    expect((await rowsOf(order.id))[0]).toMatchObject({ trackingNumber: 'SHOPIFY-1', crawlSource: null })
  })

  it('gives Auto Fulfilled the shipped, unfulfilled parcels of lines sent to Gỗ 3D only', async () => {
    const a = await makeOrder(7101, [{ supplier: GO3D, exported: true }, { supplier: GO3D, exported: true }])
    const b = await makeOrder(7102, [{ supplier: GO3D, exported: true }])
    const c = await makeOrder(7103, [{ supplier: GO3D, exported: true }])
    const row = (orderId: string, order: number, n: number, extra: Record<string, unknown>) => prisma.shipment.create({ data: {
      orderId, projectId: PROJECT, lineKey: `LIT${order}_${n}`, shopifyLineId: lineId(order, n), supplierId: GO3D, crawlSource: 'vnepacket', ...extra,
    } })
    await row(a.id, 7101, 1, { trackingNumber: 'T-1', status: 'IN_TRANSIT' })
    await row(a.id, 7101, 2, { trackingNumber: 'T-LABEL', status: 'INFO_RECEIVED' })
    await row(b.id, 7102, 1, { trackingNumber: 'T-DONE', status: 'DELIVERED', shopifyFulfillmentId: 'gid://shopify/Fulfillment/9' })
    await prisma.orderLine.updateMany({ where: { orderId: c.id }, data: { exportedToSupplierId: OTHER } })
    await row(c.id, 7103, 1, { trackingNumber: 'T-OTHER', status: 'DELIVERED' })

    expect(Array.from(await vnepacketShipmentRows(storeId))).toEqual([['LIT7101', [{ lineKey: 'LIT7101_1', tracking: 'T-1' }]]])
  })

  it('does nothing without an account', async () => {
    await saveVnepacketSettings({ username: null, password: null })
    try {
      expect(await syncVnepacketTracking()).toMatchObject({ skipped: 'no VNEpacket account' })
    } finally {
      await saveVnepacketSettings({ username: 'shop@test', password: 'pw' })
    }
  })
})
