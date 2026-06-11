import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { upsertOrderWithLines } from '@/lib/repos/orders'
import { PATCH } from '@/app/api/fulfillment/orders/line-cost/route'

const ORDER_ID = 'gid://test/Order/mbc-1'
const SHOP = 'mbc-test.myshopify.com'

function orderInput(storeId: string, supplierId = 'sup_mbc_x') {
  return {
    id: ORDER_ID,
    projectId: 'proj_mbc',
    storeId,
    shopifyOrderNumber: '#MBC1',
    customerEmail: null,
    customerName: null,
    shippingCountry: null,
    shippingState: null,
    financialStatus: 'PAID',
    fulfillmentStatus: null,
    currency: 'USD',
    grossAmount: 100,
    expectedPayout: 95,
    totalFees: 5,
    refundedAmount: 0,
    defaultSupplierId: null,
    placedAt: new Date('2026-06-10T00:00:00Z'),
    lines: [{
      shopifyLineId: 'mbc-line-1',
      sku: 'MBC-SKU',
      variantTitle: null,
      productTitle: 'Test product',
      qty: 1,
      linePosition: 1,
      unitPrice: 100,
      resolvedSupplierId: supplierId,
      resolvedBaseCost: 40,
      resolvedShipFirst: 5,
      resolvedShipAdditional: 2,
      resolvedImportTax: 0,
    }],
  }
}

beforeAll(async () => {
  await prisma.project.upsert({
    where: { id: 'proj_mbc' },
    create: { id: 'proj_mbc', name: 'MBC Test', startDate: new Date('2026-06-01') },
    update: { archivedAt: null },
  })
  await prisma.shopifyStore.upsert({
    where: { shop: SHOP },
    create: { shop: SHOP, projectId: 'proj_mbc' },
    update: { projectId: 'proj_mbc' },
  })
})

afterAll(async () => {
  await prisma.orderLine.deleteMany({ where: { orderId: ORDER_ID } })
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
})

describe('upsertOrderWithLines manualBaseCost carry-over', () => {
  it('preserves manualBaseCost when lines are recreated on re-sync', async () => {
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })
    await upsertOrderWithLines(orderInput(store.id))
    const created = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    await prisma.orderLine.update({ where: { id: created.id }, data: { manualBaseCost: 12.5 } })

    await upsertOrderWithLines(orderInput(store.id))
    const afterResync = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect(afterResync.manualBaseCost).toBe(12.5)
  })

  it('preserves manualBaseCost even when the supplier mapping changed', async () => {
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })
    await upsertOrderWithLines(orderInput(store.id, 'sup_mbc_y'))
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect(line.manualBaseCost).toBe(12.5)
    expect(line.resolvedSupplierId).toBe('sup_mbc_y')
  })
})

function patchReq(body: unknown) {
  return new Request('http://test/api/fulfillment/orders/line-cost', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/fulfillment/orders/line-cost', () => {
  it('sets manualBaseCost on a mapped line', async () => {
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID }, orderBy: { linePosition: 'asc' } })
    const res = await PATCH(patchReq({ lineId: line.id, manualBaseCost: 19.99 }) as any)
    expect(res.status).toBe(200)
    const saved = await prisma.orderLine.findUniqueOrThrow({ where: { id: line.id } })
    expect(saved.manualBaseCost).toBeCloseTo(19.99, 2)
  })

  it('clears manualBaseCost with null (revert to auto)', async () => {
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID }, orderBy: { linePosition: 'asc' } })
    const res = await PATCH(patchReq({ lineId: line.id, manualBaseCost: null }) as any)
    expect(res.status).toBe(200)
    const saved = await prisma.orderLine.findUniqueOrThrow({ where: { id: line.id } })
    expect(saved.manualBaseCost).toBeNull()
  })

  it('rejects manual cost on a line without supplier mapping', async () => {
    const unmapped = await prisma.orderLine.create({
      data: {
        orderId: ORDER_ID,
        shopifyLineId: 'mbc-line-unmapped',
        sku: 'MBC-UNMAPPED',
        productTitle: 'Unmapped product',
        qty: 1,
        linePosition: 2,
        unitPrice: 50,
        resolvedSupplierId: null,
        resolvedBaseCost: null,
      },
    })
    const res = await PATCH(patchReq({ lineId: unmapped.id, manualBaseCost: 10 }) as any)
    expect(res.status).toBe(400)
  })

  it('rejects negative and non-numeric values', async () => {
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID }, orderBy: { linePosition: 'asc' } })
    expect((await PATCH(patchReq({ lineId: line.id, manualBaseCost: -1 }) as any)).status).toBe(400)
    expect((await PATCH(patchReq({ lineId: line.id, manualBaseCost: 'abc' }) as any)).status).toBe(400)
  })

  it('404s for unknown line', async () => {
    const res = await PATCH(patchReq({ lineId: 'nope', manualBaseCost: 5 }) as any)
    expect(res.status).toBe(404)
  })
})
