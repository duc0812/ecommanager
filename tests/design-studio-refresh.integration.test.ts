import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { applyLineProps } from '@/lib/design-studio'

const ORDER_ID = 'gid://test/Order/ds-ref-1'
const SHOP = 'ds-ref.myshopify.com'

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_ds_ref' }, create: { id: 'proj_ds_ref', name: 'DS ref', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_ref' }, update: {} })).id
  await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_ds_ref', storeId, shopifyOrderNumber: '#DSR1', financialStatus: 'PAID',
      currency: 'USD', grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      lines: { create: [
        { shopifyLineId: 'r1', sku: 'A', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 1 },
        { shopifyLineId: 'r2', sku: 'B', productTitle: 'Mug', qty: 1, linePosition: 2, unitPrice: 1 },
      ] },
    },
  })
})
afterAll(async () => { await prisma.order.deleteMany({ where: { id: ORDER_ID } }) })

describe('applyLineProps', () => {
  it('writes attributes by position and appends _product_url', async () => {
    const r = await applyLineProps(ORDER_ID, [
      { sku: 'A', title: 'Socks', variantTitle: null, quantity: 1, productType: null, customAttributes: [{ key: 'Custom Name', value: 'Ashley' }], productUrl: 'https://shop.example/products/socks', variantId: null, imageUrl: 'https://cdn.shopify.com/x.jpg' },
      { sku: 'B', title: 'Mug', variantTitle: null, quantity: 1, productType: null, customAttributes: [], productUrl: null, variantId: null, imageUrl: null },
    ])
    expect(r).toEqual({ updated: 2, unmatched: 0 })
    const lines = await prisma.orderLine.findMany({ where: { orderId: ORDER_ID }, orderBy: { linePosition: 'asc' } })
    expect(JSON.parse(lines[0].customAttributesJson!)).toEqual([
      { key: 'Custom Name', value: 'Ashley' }, { key: '_product_url', value: 'https://shop.example/products/socks' },
    ])
    expect(lines[1].customAttributesJson).toBe('[]')
    expect(lines[0].imageUrl).toBe('https://cdn.shopify.com/x.jpg')
    expect(lines[1].imageUrl).toBeNull()
  })
  it('writes shopifyProductId and keeps it when the props omit it', async () => {
    const base = { variantTitle: null, quantity: 1, productType: null, customAttributes: [], productUrl: null, variantId: null, imageUrl: null }
    await applyLineProps(ORDER_ID, [
      { ...base, sku: 'A', title: 'Socks', productId: 'gid://shopify/Product/501' },
      { ...base, sku: 'B', title: 'Mug' },
    ])
    let lines = await prisma.orderLine.findMany({ where: { orderId: ORDER_ID }, orderBy: { linePosition: 'asc' } })
    expect(lines[0].shopifyProductId).toBe('gid://shopify/Product/501')
    expect(lines[1].shopifyProductId).toBeNull()
    await applyLineProps(ORDER_ID, [
      { ...base, sku: 'A', title: 'Socks' },
      { ...base, sku: 'B', title: 'Mug', productId: 'gid://shopify/Product/502' },
    ])
    lines = await prisma.orderLine.findMany({ where: { orderId: ORDER_ID }, orderBy: { linePosition: 'asc' } })
    expect(lines[0].shopifyProductId).toBe('gid://shopify/Product/501')
    expect(lines[1].shopifyProductId).toBe('gid://shopify/Product/502')
  })
  it('falls back to sku+title when counts differ', async () => {
    const r = await applyLineProps(ORDER_ID, [
      { sku: 'B', title: 'Mug', variantTitle: null, quantity: 1, productType: null, customAttributes: [{ key: 'Text', value: 'Hi' }], productUrl: null, variantId: null, imageUrl: null },
    ])
    expect(r).toEqual({ updated: 1, unmatched: 0 })
    const b = await prisma.orderLine.findFirst({ where: { orderId: ORDER_ID, sku: 'B' } })
    expect(JSON.parse(b!.customAttributesJson!)).toEqual([{ key: 'Text', value: 'Hi' }])
  })
})
