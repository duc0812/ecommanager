import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { prisma } from '@/lib/db'
import { upsertOrderWithLines } from '@/lib/repos/orders'
import { loadWorkspace, updateLine } from '@/lib/design-studio'
import { saveArtwork, readArtwork } from '@/lib/design-storage'

const ORDER_ID = 'gid://test/Order/ds-attrs-1'
const SHOP = 'ds-attrs.myshopify.com'
const ATTRS = JSON.stringify([{ key: 'Custom Name', value: 'Ashley' }, { key: '_design', value: '{"v":3}' }])

const IMG = 'https://cdn.shopify.com/v.jpg'

function orderInput(storeId: string, attrs: string | null | undefined, imageUrl?: string | null) {
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
      imageUrl,
    }],
  }
}

let storeId = ''
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-attrs-'))
beforeAll(async () => {
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: 'proj_ds_attrs' }, create: { id: 'proj_ds_attrs', name: 'DS attrs', startDate: new Date('2026-06-01') }, update: {} })
  const store = await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_attrs' }, update: {} })
  storeId = store.id
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
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

describe('OrderLine.imageUrl', () => {
  it('stores the image passed at upsert', async () => {
    await upsertOrderWithLines(orderInput(storeId, ATTRS, IMG))
    const line = await prisma.orderLine.findFirst({ where: { orderId: ORDER_ID } })
    expect(line?.imageUrl).toBe(IMG)
  })
  it('preserves the image when the next sync passes undefined', async () => {
    await upsertOrderWithLines(orderInput(storeId, ATTRS, undefined))
    const line = await prisma.orderLine.findFirst({ where: { orderId: ORDER_ID } })
    expect(line?.imageUrl).toBe(IMG)
  })
})

describe('DesignArtwork across a Shopify re-sync', () => {
  it('keeps the uploaded artwork and the done link when the lines are recreated', async () => {
    await upsertOrderWithLines(orderInput(storeId, ATTRS))
    const before = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    const art = await saveArtwork({ lineId: before.id, printArea: 'Artwork', fileName: 'front.png', mimeType: 'image/png', bytes: Buffer.from('art'), uploadedById: null })
    const done = await updateLine(before.id, { done: true })
    expect(done?.line.designDriveLink).toBe(art.url)

    await upsertOrderWithLines(orderInput(storeId, ATTRS))
    const after = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect(after.id).not.toBe(before.id)
    expect(after.designDriveLink).toBe(art.url)

    const ws = await loadWorkspace(ORDER_ID)
    expect(ws?.lines[0].id).toBe(after.id)
    expect(ws?.lines[0].artworks.map(a => a.id)).toEqual([art.id])

    const read = await readArtwork(after.designDriveLink!.split('/').pop()!)
    expect(read).not.toBeNull()
    expect(fs.readFileSync(read!.absPath, 'utf8')).toBe('art')
  })
})
