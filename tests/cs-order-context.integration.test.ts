import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { buildOrderContext } from '@/lib/cs/order-context'

const PROJECT = 'cs-ctx-project'
const SHOP = 'cs-ctx.myshopify.com'
const IDS = ['cs-ctx-9001', 'cs-ctx-9002', 'cs-ctx-9003', 'cs-ctx-9004']

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'CS ctx', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  const order = (id: string, number: string, email: string, placedAt: string) => ({
    id, projectId: PROJECT, storeId, shopifyOrderNumber: number, customerEmail: email, customerName: 'Ctx Tester', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 10, expectedPayout: 9, placedAt: new Date(placedAt),
    shippingName: 'Ctx Tester', shippingAddress1: '1 Main St', shippingCity: 'Austin', shippingStateCode: 'TX', shippingZip: '73301', shippingCountry: 'United States',
  })
  await prisma.order.create({ data: { ...order(IDS[0], '#LIT9001', 'a@x.com', '2026-10-01T00:00:00Z'),
    lines: { create: [{ shopifyLineId: 'l1', productTitle: 'Family Ornament', variantTitle: '3 people', qty: 1, unitPrice: 10, linePosition: 1, customized: true }] },
    shipments: { create: [{ projectId: PROJECT, lineKey: '9001_1', trackingNumber: 'SWX123', carrier: 'Other', status: 'IN_TRANSIT', lastCheckpointAt: new Date('2026-10-20T00:00:00Z') }] },
  } })
  await prisma.order.create({ data: order(IDS[1], '#LIT9002', 'a@x.com', '2026-10-05T00:00:00Z') })
  await prisma.order.create({ data: order(IDS[2], '#LIT9003', 'b@x.com', '2026-10-06T00:00:00Z') })
  await prisma.supplier.upsert({ where: { id: 'cs-ctx-sup' }, create: { id: 'cs-ctx-sup', name: 'Ctx Factory', code: 'CSCTX' }, update: {} })
  await prisma.order.create({ data: { ...order(IDS[3], '#LIT9004', 'c@x.com', '2026-10-07T00:00:00Z'),
    lines: { create: [
      { id: 'cs-ctx-ol-1', shopifyLineId: 'l9004-1', productTitle: 'Tumbler', qty: 1, unitPrice: 10, linePosition: 1, customized: true },
      { shopifyLineId: 'l9004-2', productTitle: 'Shipping protection', qty: 1, unitPrice: 2, linePosition: 2, customized: false },
    ] },
    shipments: { create: [{ projectId: PROJECT, lineKey: 'LIT9004_1', shopifyLineId: 'l9004-1', trackingNumber: 'UL9', carrier: 'Other', status: 'IN_TRANSIT', supplierId: 'cs-ctx-sup' }] },
  } })
  await prisma.supplierSheetWrite.create({ data: { supplierId: 'cs-ctx-sup', orderId: IDS[3], orderLineId: 'cs-ctx-ol-1', lineKey: 'LIT9004_1', spreadsheetId: 's', tabName: 'CTX_20261008', status: 'WRITTEN', createdAt: new Date('2026-10-08T00:00:00Z') } })
})

afterAll(async () => {
  await prisma.supplierSheetWrite.deleteMany({ where: { orderId: { in: IDS } } })
  await prisma.order.deleteMany({ where: { id: { in: IDS } } })
})

describe('buildOrderContext', () => {
  it('EXACT by number from cf_order_id even when body is empty', async () => {
    const ctx = await buildOrderContext({ subject: 'help', texts: [''], cfOrderId: '#LIT9001', email: 'nobody@x.com' })
    expect(ctx.match).toBe('EXACT')
    expect(ctx.order?.shopifyOrderNumber).toBe('#LIT9001')
    expect(ctx.order?.factoryState).toBe('SHIPPED')
    expect(ctx.order?.shipments[0].trackingUrl).toBe('https://litzzy.com/apps/trackingorder?nums=SWX123')
    expect(ctx.order?.shipTo).toContain('Austin')
    expect(ctx.order?.lines[0].title).toBe('Family Ornament')
  })
  it('lists each product item with the factory it went to and its parcel', async () => {
    const ctx = await buildOrderContext({ subject: 'LIT9004', texts: [], email: null })
    expect(ctx.order?.items).toHaveLength(1)
    expect(ctx.order?.items[0]).toMatchObject({ lineKey: 'LIT9004_1', title: 'Tumbler', warning: null })
    expect(ctx.order?.items[0].send).toMatchObject({ supplier: 'Ctx Factory', via: 'SHEET', ref: 'CTX_20261008' })
    expect(ctx.order?.items[0].parcel).toMatchObject({ trackingNumber: 'UL9', fromSupplier: 'Ctx Factory' })
  })
  it('EXACT by bare number in the subject', async () => {
    const ctx = await buildOrderContext({ subject: 'LIT9003', texts: [], email: null })
    expect(ctx.match).toBe('EXACT')
    expect(ctx.order?.shopifyOrderNumber).toBe('#LIT9003')
  })
  it('BY_EMAIL when exactly one order for the email', async () => {
    const ctx = await buildOrderContext({ subject: 'where is my order', texts: ['hello?'], email: 'B@x.com' })
    expect(ctx.match).toBe('BY_EMAIL')
    expect(ctx.order?.shopifyOrderNumber).toBe('#LIT9003')
  })
  it('AMBIGUOUS lists candidates when email has two orders and no number', async () => {
    const ctx = await buildOrderContext({ subject: 'where is my order', texts: [], email: 'a@x.com' })
    expect(ctx.match).toBe('AMBIGUOUS')
    expect(ctx.order).toBeNull()
    expect(ctx.candidates).toEqual(['#LIT9002', '#LIT9001'])
  })
  it('NONE when nothing matches', async () => {
    const ctx = await buildOrderContext({ subject: 'hi', texts: ['#LIT0000'], email: 'zz@x.com' })
    expect(ctx.match).toBe('NONE')
    expect(ctx.candidates).toEqual([])
  })
})
