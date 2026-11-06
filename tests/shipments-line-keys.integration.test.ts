import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { buildOrderShipments } from '@/lib/tracking/build-shipments'
import { upsertOrderShipments } from '@/lib/repos/shipments'
import { buildFulfillmentPlan } from '@/lib/fulfillment/build-fulfill-plan'

const SHOP = 'shk-store.myshopify.com'
const PROJECT = 'proj_shk'
let storeId = ''

const lineId = (order: number, n: number) => `gid://shopify/LineItem/shk-${order}-${n}`
const ADD_ON = { productTitle: 'Custom Name Add-on', shopifyProductType: 'Add-on', sku: null }
const PROTECTION = { productTitle: 'Worry-Free Protection', shopifyProductType: 'Add-on', sku: 'WFP' }
const TOTE = { productTitle: 'Custom Tote Bag', shopifyProductType: 'Tote', sku: 'TOTE-1' }
const MUG = { productTitle: 'Custom Mug', shopifyProductType: 'Mug', sku: 'MUG-1' }
type LineSpec = { productTitle: string; shopifyProductType: string; sku: string | null }

async function makeOrder(number: number, specs: LineSpec[]) {
  return prisma.order.create({
    data: {
      id: `gid://shopify/Order/shk-${number}`, projectId: PROJECT, storeId, shopifyOrderNumber: `#REMI${number}`, financialStatus: 'PAID',
      currency: 'USD', grossAmount: 10, expectedPayout: 9, totalFees: 1, refundedAmount: 0, placedAt: new Date('2026-10-01'), fulfillmentStatus: 'UNFULFILLED',
      lines: { create: specs.map((s, i) => ({ shopifyLineId: lineId(number, i + 1), linePosition: i, qty: 1, unitPrice: 5, ...s })) },
    },
    include: { lines: true },
  })
}

type Order = Awaited<ReturnType<typeof makeOrder>>

// Rows as the tool wrote them when every line counted, add-ons too.
async function oldRows(order: Order, extra: Record<number, { trackingNumber?: string; shopifyFulfillmentId?: string }> = {}) {
  const no = order.shopifyOrderNumber.replace('#', '')
  const lines = [...order.lines].sort((a, b) => a.linePosition - b.linePosition)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    await prisma.shipment.create({ data: { orderId: order.id, projectId: PROJECT, lineKey: `${no}_${i + 1}`, shopifyLineId: l.shopifyLineId, sku: l.sku, productTitle: l.productTitle, ...extra[i + 1] } })
  }
}

const built = (order: Order) => buildOrderShipments({ shopifyOrderNumber: order.shopifyOrderNumber, lines: order.lines, fulfillments: [] })
const rowsOf = (orderId: string) => prisma.shipment.findMany({ where: { orderId }, orderBy: { lineKey: 'asc' } })

beforeAll(async () => {
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.project.create({ data: { id: PROJECT, name: 'SHK', startDate: new Date('2026-05-01') } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: SHOP, orderPrefix: 'REMI' } })).id
})

beforeEach(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
})

describe('upsertOrderShipments follows the line keys', () => {
  it('rows made when add-ons counted are removed, and the first key points at the product line', async () => {
    const order = await makeOrder(8801, [ADD_ON, PROTECTION, TOTE])
    await oldRows(order)

    await upsertOrderShipments(order.id, PROJECT, built(order))

    const rows = await rowsOf(order.id)
    expect(rows.map(r => [r.lineKey, r.shopifyLineId, r.sku, r.productTitle])).toEqual([['REMI8801_1', lineId(8801, 3), 'TOTE-1', 'Custom Tote Bag']])
  })

  it('a stale row that carries a tracking number or a fulfilment stays, and one warning names the order and its stale keys', async () => {
    const order = await makeOrder(8802, [ADD_ON, PROTECTION, TOTE, MUG])
    await oldRows(order, { 3: { trackingNumber: 'TRK-STALE' }, 4: { shopifyFulfillmentId: 'gid://shopify/Fulfillment/shk-1' } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await upsertOrderShipments(order.id, PROJECT, built(order))
      expect(warn).toHaveBeenCalledTimes(1)
      const text = warn.mock.calls[0].join(' ')
      expect(text).toContain('#REMI8802')
      expect(text).toContain('REMI8802_3')
      expect(text).toContain('REMI8802_4')
      expect(text).not.toMatch(/REMI8802_[12]\b/)
    } finally {
      warn.mockRestore()
    }

    const rows = await rowsOf(order.id)
    expect(rows.map(r => [r.lineKey, r.shopifyLineId, r.trackingNumber, r.shopifyFulfillmentId])).toEqual([
      ['REMI8802_1', lineId(8802, 3), null, null],
      ['REMI8802_2', lineId(8802, 4), null, null],
      ['REMI8802_3', lineId(8802, 3), 'TRK-STALE', null],
      ['REMI8802_4', lineId(8802, 4), null, 'gid://shopify/Fulfillment/shk-1'],
    ])
  })

  it('an order whose keys did not change keeps its rows as they were', async () => {
    const order = await makeOrder(8803, [TOTE, MUG, PROTECTION])
    await upsertOrderShipments(order.id, PROJECT, built(order))
    await prisma.shipment.update({ where: { orderId_lineKey: { orderId: order.id, lineKey: 'REMI8803_2' } }, data: { trackingNumber: 'TRK-MUG', status: 'IN_TRANSIT', crawlSource: 'parcelpanel' } })
    const before = await rowsOf(order.id)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await upsertOrderShipments(order.id, PROJECT, built(order))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }

    const after = await rowsOf(order.id)
    const withoutUpdatedAt = (rows: typeof before) => rows.map(({ updatedAt, ...rest }) => rest)
    expect(withoutUpdatedAt(after)).toEqual(withoutUpdatedAt(before))
    expect(after).toHaveLength(2)
  })

  it('the per-line fulfilment plan of a renumbered order fulfils the product line, never an add-on', async () => {
    const order = await makeOrder(8804, [ADD_ON, PROTECTION, TOTE])
    await oldRows(order)
    await upsertOrderShipments(order.id, PROJECT, built(order))

    const shipments = await prisma.shipment.findMany({ where: { orderId: order.id }, select: { id: true, lineKey: true, shopifyLineId: true } })
    const addOnLineIds = order.lines.filter(l => isNonProductLine(l)).map(l => l.shopifyLineId)
    expect(shipments.filter(s => addOnLineIds.includes(s.shopifyLineId ?? ''))).toEqual([])

    const plan = buildFulfillmentPlan({
      baseOrder: 'REMI8804',
      rows: [{ lineKey: 'REMI8804_1', tracking: 'TRK-TOTE' }],
      shipments,
      fulfillmentOrders: [
        { id: 'fo-goods', status: 'OPEN', lineItems: [{ id: 'fo-li-tote', remainingQuantity: 1, shopifyLineId: lineId(8804, 3), sku: 'TOTE-1' }] },
        { id: 'fo-addons', status: 'OPEN', lineItems: [
          { id: 'fo-li-name', remainingQuantity: 1, shopifyLineId: lineId(8804, 1), sku: null },
          { id: 'fo-li-wfp', remainingQuantity: 1, shopifyLineId: lineId(8804, 2), sku: 'WFP' },
        ] },
      ],
      displayFulfillmentStatus: 'UNFULFILLED',
      addOnLineIds,
      placedAt: new Date('2026-10-01'),
      now: new Date('2026-11-01'),
      minAgeDays: 0,
    })

    expect(plan.status).toBe('will_fulfill')
    const tracked = plan.fulfillments.filter(f => f.tracking === 'TRK-TOTE')
    expect(tracked).toEqual([{ fulfillmentOrderId: 'fo-goods', lineItems: [{ id: 'fo-li-tote', quantity: 1 }], tracking: 'TRK-TOTE', shipmentIds: [shipments[0].id] }])
    expect(plan.fulfillments.filter(f => f.tracking !== 'TRK-TOTE')).toEqual([
      { fulfillmentOrderId: 'fo-addons', lineItems: [{ id: 'fo-li-name', quantity: 1 }, { id: 'fo-li-wfp', quantity: 1 }], tracking: '', shipmentIds: [], addOn: true },
    ])
  })
})
