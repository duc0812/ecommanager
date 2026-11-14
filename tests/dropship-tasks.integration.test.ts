import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { DROPSHIP_TASK_MESSAGE, syncDesignTasks } from '@/lib/design-tasks'
import { readyLines } from '@/lib/line-export'
import { designReadyHolds } from '@/lib/design-library'
import { handoffStateFor } from '@/lib/supplier-handoff'

const ORDER_ID = 'gid://test/Order/dropship-1'
const SHOP = 'dropship-tasks.myshopify.com'
const SUP = 'sup_dropship_tasks'

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_dropship' }, create: { id: 'proj_dropship', name: 'Dropship', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dropship' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DROPTASK' }, create: { id: SUP, name: 'Drop Supplier', code: 'DROPTASK' }, update: {} })
  await prisma.order.create({ data: {
    id: ORDER_ID, projectId: 'proj_dropship', storeId, shopifyOrderNumber: '#DRP1', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-11-01'), pipelineStatus: 'PENDING_DESIGN', orderType: 'NON_CUSTOM',
    lines: { create: [
      { shopifyLineId: 'p1', sku: 'TEE', productTitle: 'Tee', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP },
      { shopifyLineId: 'd1', sku: 'ROBE', productTitle: 'Christmas Grump Hooded Robe', qty: 1, linePosition: 2, unitPrice: 1, resolvedSupplierId: SUP, dropship: true },
      { shopifyLineId: 'd2', sku: 'TISSUE', productTitle: 'The Grumpy Bum Tissue Holder', qty: 1, linePosition: 3, unitPrice: 1, resolvedSupplierId: null, dropship: true },
    ] },
    designTasks: { create: [{ shopifyLineId: 'd1', taskKey: 'DRP1_2', status: 'REJECTED' }] },
  } })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
})

describe('dropship lines and design tasks', () => {
  it('creates a task only for the POD line and cancels the dropship task with its reason', async () => {
    const r = await syncDesignTasks(ORDER_ID)
    expect(r.created).toBe(1)
    expect(r.cancelled).toBe(1)
    const tasks = await prisma.designTask.findMany({ where: { orderId: ORDER_ID }, include: { events: true }, orderBy: { taskKey: 'asc' } })
    expect(tasks.map(t => [t.shopifyLineId, t.status])).toEqual([['p1', 'NEW'], ['d1', 'CANCELLED']])
    expect(tasks[1].events.map(e => e.message)).toContain(DROPSHIP_TASK_MESSAGE)
    expect(await syncDesignTasks(ORDER_ID)).toMatchObject({ created: 0, cancelled: 0 })
  })
  it('a mapped dropship line is ready to send while its POD sibling waits for design', async () => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID }, include: { lines: true, designTasks: true } })
    const ready = readyLines({ ...order, supplierPushes: [] })
    expect(ready.map(l => l.shopifyLineId)).toEqual(['d1'])
  })
  it('the hand-off sees the mapped dropship line as ready while the POD design is open', async () => {
    const state = await handoffStateFor(ORDER_ID)
    expect(state?.pending).toBe(true)
  })
  it('after a CSV save the dropship line mapped before it is saved, one mapped after it is not', async () => {
    const savedAt = new Date('2026-11-10T00:00:00Z')
    await prisma.order.update({ where: { id: ORDER_ID }, data: { supplierHandoffAt: savedAt } })
    await prisma.orderLine.updateMany({ where: { orderId: ORDER_ID, shopifyLineId: 'd1' }, data: { costSnapshotAt: new Date('2026-11-09T00:00:00Z') } })
    let order = await prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID }, include: { lines: true, designTasks: true } })
    expect(readyLines({ ...order, supplierPushes: [] }).map(l => l.shopifyLineId)).toEqual([])
    await prisma.orderLine.updateMany({ where: { orderId: ORDER_ID, shopifyLineId: 'd1' }, data: { costSnapshotAt: new Date('2026-11-11T00:00:00Z') } })
    order = await prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID }, include: { lines: true, designTasks: true } })
    expect(readyLines({ ...order, supplierPushes: [] }).map(l => l.shopifyLineId)).toEqual(['d1'])
    await prisma.order.update({ where: { id: ORDER_ID }, data: { supplierHandoffAt: null } })
  })
  it('a dropship line without a link does not break a stored design-ready flag', () => {
    const base = { sku: 'X', shopifyProductType: null, resolvedSupplierId: SUP }
    const lines = [{ ...base, productTitle: 'Tee', designDriveLink: 'https://drive.example/x' }, { ...base, productTitle: 'Robe', designDriveLink: null, dropship: true }]
    expect(designReadyHolds({ designReady: true, trelloCardId: null, lines })).toBe(true)
    expect(designReadyHolds({ designReady: true, trelloCardId: null, lines: lines.map(l => ({ ...l, dropship: false })) })).toBe(false)
  })
})
