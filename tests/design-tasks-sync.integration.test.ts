import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { syncDesignTasks } from '@/lib/design-tasks'

const ORDER_ID = 'gid://test/Order/dt-sync-1'
const SHOP = 'dt-sync.myshopify.com'
const SUP = 'sup_dt_sync'

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_dt_sync' }, create: { id: 'proj_dt_sync', name: 'DT sync', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dt_sync' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DTSYNC' }, create: { id: SUP, name: 'DT Sync Supplier', code: 'DTSYNC' }, update: {} })
  await prisma.order.create({ data: {
    id: ORDER_ID, projectId: 'proj_dt_sync', storeId, shopifyOrderNumber: '#DTS1', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'), pipelineStatus: 'PENDING_DESIGN', orderType: 'MIXED',
    lines: { create: [
      { shopifyLineId: 's1', sku: 'A', productTitle: 'Jersey', shopifyProductType: 'Baseball Jersey', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP, customized: true,
        customAttributesJson: JSON.stringify([{ key: 'Name', value: 'X' }, { key: '_print_files', value: JSON.stringify([{ print_area: 'PRINT', url: 'https://cdn.example/p.png' }]) }]) },
      { shopifyLineId: 's2', sku: 'B', productTitle: 'Mug', qty: 1, linePosition: 2, unitPrice: 1, resolvedSupplierId: SUP, designDriveLink: 'https://drive.example/lib' },
      { shopifyLineId: 's3', sku: 'C', productTitle: 'Socks', qty: 1, linePosition: 3, unitPrice: 1, resolvedSupplierId: null, customized: true },
      { shopifyLineId: 's4', sku: null, productTitle: 'Tip', qty: 1, linePosition: 4, unitPrice: 1 },
    ] } } })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
})

describe('syncDesignTasks', () => {
  it('creates one NEW task per mapped product line without a design link', async () => {
    const r = await syncDesignTasks(ORDER_ID)
    expect(r.created).toBe(1)
    const tasks = await prisma.designTask.findMany({ where: { orderId: ORDER_ID } })
    expect(tasks.map(t => t.taskKey)).toEqual(['DTS1_1'])
    expect(tasks[0].status).toBe('NEW')
    expect(tasks[0].readiness).toBe('LOW')
    expect(tasks[0].kpi).toBe(0.3)
    expect(tasks[0].slaHours).toBe(24)
  })
  it('is idempotent and keeps status and assignee', async () => {
    await prisma.designTask.update({ where: { taskKey: 'DTS1_1' }, data: { status: 'DOING', assigneeId: 'u1' } })
    const r = await syncDesignTasks(ORDER_ID)
    expect(r.created).toBe(0)
    const t = await prisma.designTask.findUnique({ where: { taskKey: 'DTS1_1' } })
    expect(t?.status).toBe('DOING'); expect(t?.assigneeId).toBe('u1')
  })
  it('completes a task when the line gained a design link elsewhere', async () => {
    await prisma.orderLine.updateMany({ where: { orderId: ORDER_ID, shopifyLineId: 's1' }, data: { designDriveLink: 'https://drive.example/x' } })
    const r = await syncDesignTasks(ORDER_ID)
    expect(r.completed).toBe(1)
    const t = await prisma.designTask.findUnique({ where: { taskKey: 'DTS1_1' }, include: { events: true } })
    expect(t?.status).toBe('DONE')
    expect(t?.events.some(e => e.type === 'SYSTEM' && /outside/i.test(e.message))).toBe(true)
  })
  it('cancels tasks of a cancelled order', async () => {
    await prisma.orderLine.updateMany({ where: { orderId: ORDER_ID, shopifyLineId: 's1' }, data: { designDriveLink: null } })
    await prisma.designTask.update({ where: { taskKey: 'DTS1_1' }, data: { status: 'DOING' } })
    await prisma.order.update({ where: { id: ORDER_ID }, data: { pipelineStatus: 'CANCELLED' } })
    const r = await syncDesignTasks(ORDER_ID)
    expect(r.cancelled).toBe(1)
    expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTS1_1' } }))?.status).toBe('CANCELLED')
  })
})
