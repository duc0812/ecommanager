import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { updateLine } from '@/lib/design-studio'

const ORDER_ID = 'gid://test/Order/ds-done-1'
const MIXED_ID = 'gid://test/Order/ds-done-mixed'
const NONCUSTOM_ID = 'gid://test/Order/ds-done-noncustom'
const REJECTED_ID = 'gid://test/Order/ds-done-rejected'
const ALL_IDS = [ORDER_ID, MIXED_ID, NONCUSTOM_ID, REJECTED_ID]
const SHOP = 'ds-done.myshopify.com'
let storeId = ''
let supplierId = ''
let l1 = '', l2 = '', tip = ''

function orderBase(id: string, number: string) {
  return {
    id, projectId: 'proj_ds_done', storeId, shopifyOrderNumber: number, financialStatus: 'PAID',
    currency: 'USD', grossAmount: 50, expectedPayout: 48, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-01'),
  }
}

function artwork(orderId: string, shopifyLineId: string, name: string) {
  return prisma.designArtwork.create({
    data: { orderId, shopifyLineId, printArea: 'Artwork', version: 1, fileName: name, storagePath: `x/${name}`, size: 1, mimeType: 'image/png' },
  })
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_ds_done' }, create: { id: 'proj_ds_done', name: 'DS done', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_done' }, update: {} })).id
  supplierId = (await prisma.supplier.upsert({ where: { code: 'DSDONE' }, create: { code: 'DSDONE', name: 'DS Done Supplier' }, update: {} })).id
  const o = await prisma.order.create({
    data: {
      ...orderBase(ORDER_ID, '#DSD1'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM', designReady: false,
      lines: { create: [
        { shopifyLineId: 'd1', sku: 'A', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 20, customized: true, resolvedSupplierId: supplierId },
        { shopifyLineId: 'd2', sku: 'B', productTitle: 'Mug', qty: 1, linePosition: 2, unitPrice: 20, customized: true, resolvedSupplierId: supplierId },
        { shopifyLineId: 'd3', sku: null, productTitle: 'Tip', qty: 1, linePosition: 3, unitPrice: 5 },
      ] },
    },
    include: { lines: { orderBy: { linePosition: 'asc' } } },
  })
  ;[l1, l2, tip] = o.lines.map(l => l.id)
  await artwork(ORDER_ID, 'd1', 'a.png')
  await artwork(ORDER_ID, 'd2', 'b.png')
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: ALL_IDS } } })
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
    await prisma.designArtwork.deleteMany({ where: { orderId: ORDER_ID, shopifyLineId: 'd2' } })
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

describe('updateLine — which lines must be done', () => {
  it('a mixed order with only the custom line done stays pending and keeps no order link', async () => {
    const o = await prisma.order.create({
      data: {
        ...orderBase(MIXED_ID, '#DSDM'),
        pipelineStatus: 'PENDING_DESIGN', orderType: 'MIXED', designReady: false,
        lines: { create: [
          { shopifyLineId: 'm1', sku: 'MA', productTitle: 'Custom shirt', qty: 1, linePosition: 1, unitPrice: 20, customized: true, resolvedSupplierId: supplierId },
          { shopifyLineId: 'm2', sku: 'MB', productTitle: 'Plain mug', qty: 1, linePosition: 2, unitPrice: 20, customized: false, resolvedSupplierId: supplierId },
        ] },
      },
      include: { lines: { orderBy: { linePosition: 'asc' } } },
    })
    await artwork(MIXED_ID, 'm1', 'ma.png')
    const r = await updateLine(o.lines[0].id, { done: true })
    expect(r?.line.designDriveLink).toMatch(/^\/api\/design-studio\/file\//)
    expect(r?.order.designReady).toBe(false)
    expect(r?.order.pipelineStatus).toBe('PENDING_DESIGN')
    const saved = await prisma.order.findUnique({ where: { id: MIXED_ID } })
    expect(saved?.designDriveLink).toBeNull()
  })

  it('a NON_CUSTOM order with a library-linked line stays pending until the custom line is done', async () => {
    const o = await prisma.order.create({
      data: {
        ...orderBase(NONCUSTOM_ID, '#DSDN'),
        pipelineStatus: 'PENDING_DESIGN', orderType: 'NON_CUSTOM', designReady: false,
        lines: { create: [
          { shopifyLineId: 'n1', sku: 'NA', productTitle: 'Library shirt', qty: 1, linePosition: 1, unitPrice: 20, resolvedSupplierId: supplierId, designDriveLink: 'https://drive.example/library' },
          { shopifyLineId: 'n2', sku: 'NB', productTitle: 'Other shirt', qty: 1, linePosition: 2, unitPrice: 20, customized: true, resolvedSupplierId: supplierId },
        ] },
      },
      include: { lines: { orderBy: { linePosition: 'asc' } } },
    })
    const [mapped, custom] = o.lines
    const note = await updateLine(mapped.id, { note: 'giữ nguyên' })
    expect(note?.order.pipelineStatus).toBe('PENDING_DESIGN')
    expect(note?.order.designReady).toBe(false)
    const reopened = await updateLine(custom.id, { done: false })
    expect(reopened?.order.pipelineStatus).toBe('PENDING_DESIGN')
    expect(reopened?.order.designReady).toBe(false)
    await artwork(NONCUSTOM_ID, 'n2', 'nb.png')
    const done = await updateLine(custom.id, { done: true })
    expect(done?.order.designReady).toBe(true)
    expect(done?.order.pipelineStatus).toBe('READY_TO_PRODUCTION')
  })
})

describe('updateLine — rejected orders', () => {
  let lineA = ''
  beforeAll(async () => {
    const o = await prisma.order.create({
      data: {
        ...orderBase(REJECTED_ID, '#DSDR'),
        pipelineStatus: 'DESIGN_REJECTED', orderType: 'CUSTOM', designReady: true, designDriveLink: '/api/design-studio/file/old',
        lines: { create: [
          { shopifyLineId: 'r1', sku: 'RA', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 20, customized: true, resolvedSupplierId: supplierId, designDriveLink: '/api/design-studio/file/old' },
        ] },
      },
      include: { lines: true },
    })
    lineA = o.lines[0].id
    await artwork(REJECTED_ID, 'r1', 'ra.png')
  })

  it('a note-only patch leaves a DESIGN_REJECTED order where it is', async () => {
    const r = await updateLine(lineA, { note: 'sửa font theo xưởng' })
    expect(r?.order.pipelineStatus).toBe('DESIGN_REJECTED')
    expect(r?.order.designReady).toBe(true)
    const saved = await prisma.order.findUnique({ where: { id: REJECTED_ID } })
    expect(saved?.pipelineStatus).toBe('DESIGN_REJECTED')
  })

  it('marking the line done again moves it back into the pipeline', async () => {
    const r = await updateLine(lineA, { done: true })
    expect(r?.order.pipelineStatus).toBe('READY_TO_PRODUCTION')
  })
})
