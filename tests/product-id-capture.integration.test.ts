import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { upsertOrderWithLines } from '@/lib/repos/orders'

const ORDER_ID = 'gid://test/Order/pid-1'
const SHOP = 'pid-test.myshopify.com'

function orderInput(storeId: string, shopifyProductId?: string | null) {
  return {
    id: ORDER_ID,
    projectId: 'proj_pid',
    storeId,
    shopifyOrderNumber: '#PID1',
    customerEmail: null,
    customerName: null,
    shippingCountry: null,
    shippingState: null,
    financialStatus: 'PAID',
    fulfillmentStatus: null,
    currency: 'USD',
    grossAmount: 10,
    expectedPayout: 9,
    totalFees: 1,
    refundedAmount: 0,
    defaultSupplierId: null,
    placedAt: new Date('2026-10-01T00:00:00Z'),
    lines: [{
      shopifyLineId: 'pid-line-1',
      sku: 'PID-SKU',
      variantTitle: null,
      productTitle: 'Pid product',
      qty: 1,
      linePosition: 1,
      unitPrice: 10,
      resolvedSupplierId: null,
      resolvedBaseCost: null,
      ...(shopifyProductId !== undefined ? { shopifyProductId } : {}),
    }],
  }
}

beforeAll(async () => {
  await prisma.project.upsert({
    where: { id: 'proj_pid' },
    create: { id: 'proj_pid', name: 'PID Test', startDate: new Date('2026-06-01') },
    update: {},
  })
  await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_pid' }, update: {} })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
})

describe('upsertOrderWithLines shopifyProductId', () => {
  it('stores the product id on a new line', async () => {
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })
    await upsertOrderWithLines(orderInput(store.id, 'gid://shopify/Product/900'))
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect(line.shopifyProductId).toBe('gid://shopify/Product/900')
  })

  it('preserves it on re-sync when the input omits it, and overwrites when given', async () => {
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })
    await upsertOrderWithLines(orderInput(store.id))
    let line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect(line.shopifyProductId).toBe('gid://shopify/Product/900')
    await upsertOrderWithLines(orderInput(store.id, 'gid://shopify/Product/901'))
    line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect(line.shopifyProductId).toBe('gid://shopify/Product/901')
  })
})
