import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { upsertOrderWithLines } from '@/lib/repos/orders'

const ORDER_ID = 'gid://test/Order/ds-attrs-1'
const SHOP = 'ds-attrs.myshopify.com'
const ATTRS = JSON.stringify([{ key: 'Custom Name', value: 'Ashley' }, { key: '_design', value: '{"v":3}' }])

function orderInput(storeId: string, attrs: string | null | undefined) {
  return {
    id: ORDER_ID, projectId: 'proj_ds_attrs', storeId, shopifyOrderNumber: '#DSA1',
    customerEmail: null, customerName: null, shippingCountry: null, shippingState: null,
    financialStatus: 'PAID', fulfillmentStatus: null, currency: 'USD',
    grossAmount: 50, expectedPayout: 48, totalFees: 2, refundedAmount: 0,
    defaultSupplierId: null, placedAt: new Date('2026-10-01T00:00:00Z'),
    lines: [{
      shopifyLineId: 'dsa-line-1', sku: 'DSA-SKU', variantTitle: null, productTitle: 'Socks',
      qty: 1, linePosition: 1, unitPrice: 50, resolvedSupplierId: null, resolvedBaseCost: null,
      customAttributesJson: attrs,
    }],
  }
}

let storeId = ''
beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_ds_attrs' }, create: { id: 'proj_ds_attrs', name: 'DS attrs', startDate: new Date('2026-06-01') }, update: {} })
  const store = await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_attrs' }, update: {} })
  storeId = store.id
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
})

describe('OrderLine.customAttributesJson', () => {
  it('stores the attributes passed at upsert', async () => {
    await upsertOrderWithLines(orderInput(storeId, ATTRS))
    const line = await prisma.orderLine.findFirst({ where: { orderId: ORDER_ID } })
    expect(line?.customAttributesJson).toBe(ATTRS)
  })
  it('preserves existing JSON when the next sync passes undefined', async () => {
    await upsertOrderWithLines(orderInput(storeId, undefined))
    const line = await prisma.orderLine.findFirst({ where: { orderId: ORDER_ID } })
    expect(line?.customAttributesJson).toBe(ATTRS)
  })
})
