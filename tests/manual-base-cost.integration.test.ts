import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { upsertOrderWithLines } from '@/lib/repos/orders'

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
