import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { updateLine } from '@/lib/design-studio'

const ORDER_ID = 'gid://test/Order/ds-done-1'
const SHOP = 'ds-done.myshopify.com'
let storeId = ''
let l1 = '', l2 = '', tip = ''

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_ds_done' }, create: { id: 'proj_ds_done', name: 'DS done', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_done' }, update: {} })).id
  const supplier = await prisma.supplier.upsert({ where: { code: 'DSDONE' }, create: { code: 'DSDONE', name: 'DS Done Supplier' }, update: {} })
  const o = await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_ds_done', storeId, shopifyOrderNumber: '#DSD1', financialStatus: 'PAID',
      currency: 'USD', grossAmount: 50, expectedPayout: 48, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM', designReady: false,
      lines: { create: [
        { shopifyLineId: 'd1', sku: 'A', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 20, customized: true, resolvedSupplierId: supplier.id },
        { shopifyLineId: 'd2', sku: 'B', productTitle: 'Mug', qty: 1, linePosition: 2, unitPrice: 20, customized: true, resolvedSupplierId: supplier.id },
        { shopifyLineId: 'd3', sku: null, productTitle: 'Tip', qty: 1, linePosition: 3, unitPrice: 5 },
      ] },
    },
    include: { lines: { orderBy: { linePosition: 'asc' } } },
  })
  ;[l1, l2, tip] = o.lines.map(l => l.id)
  await prisma.designArtwork.create({ data: { orderLineId: l1, printArea: 'Artwork', version: 1, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png' } })
  await prisma.designArtwork.create({ data: { orderLineId: l2, printArea: 'Artwork', version: 1, fileName: 'b.png', storagePath: 'x/b.png', size: 1, mimeType: 'image/png' } })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplier.deleteMany({ where: { code: 'DSDONE' } })
})

describe('updateLine', () => {
  it('saves a note without touching done state', async () => {
    const r = await updateLine(l1, { note: 'kéo tên vào 60px' })
    expect(r?.line.designNote).toBe('kéo tên vào 60px')
    expect(r?.order.designReady).toBe(false)
  })
  it('marks the first line done but the order stays pending', async () => {
    const r = await updateLine(l1, { done: true })
    expect(r?.line.designDriveLink).toMatch(/^\/api\/design-studio\/file\//)
    expect(r?.order.designReady).toBe(false)
    expect(r?.order.pipelineStatus).toBe('PENDING_DESIGN')
  })
  it('ignores the Tip line and flips the order when the last product line is done', async () => {
    const r = await updateLine(l2, { done: true })
    expect(r?.order.designReady).toBe(true)
    expect(r?.order.pipelineStatus).toBe('READY_TO_PRODUCTION')
    const tipLine = await prisma.orderLine.findUnique({ where: { id: tip } })
    expect(tipLine?.designDriveLink).toBeNull()
  })
  it('refuses done when the slot has no artwork', async () => {
    await prisma.designArtwork.deleteMany({ where: { orderLineId: l2 } })
    await prisma.orderLine.update({ where: { id: l2 }, data: { designDriveLink: null } })
    await expect(updateLine(l2, { done: true })).rejects.toThrow(/no artwork/i)
  })
  it('reopening clears the flags', async () => {
    const r = await updateLine(l1, { done: false })
    expect(r?.line.designDriveLink).toBeNull()
    expect(r?.order.designReady).toBe(false)
    expect(r?.order.pipelineStatus).toBe('PENDING_DESIGN')
  })
  it('returns null for an unknown line', async () => {
    expect(await updateLine('nope', { note: 'x' })).toBeNull()
  })
})
