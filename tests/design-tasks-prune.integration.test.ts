import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { pruneUntouchedTasksOutside } from '@/lib/design-tasks'

const SHOP = 'dt-prune.myshopify.com'
const OLD = 'gid://test/Order/dt-prune-old'
const KEEP = 'gid://test/Order/dt-prune-keep'

async function order(id: string, num: string) {
  const storeId = (await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })).id
  await prisma.order.create({ data: {
    id, projectId: 'proj_dt_prune', storeId, shopifyOrderNumber: num, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-01-01'), pipelineStatus: 'PENDING_DESIGN',
  } })
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_dt_prune' }, create: { id: 'proj_dt_prune', name: 'DT prune', startDate: new Date('2026-01-01') }, update: {} })
  await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dt_prune' }, update: {} })
  await order(OLD, '#DTP1')
  await order(KEEP, '#DTP2')
  await prisma.designTask.createMany({ data: [
    { orderId: OLD, shopifyLineId: 'a', taskKey: 'DTP1_1', status: 'NEW' },
    { orderId: OLD, shopifyLineId: 'b', taskKey: 'DTP1_2', status: 'NEW', assigneeId: 'u1' },
    { orderId: OLD, shopifyLineId: 'c', taskKey: 'DTP1_3', status: 'DOING' },
    { orderId: KEEP, shopifyLineId: 'a', taskKey: 'DTP2_1', status: 'NEW' },
  ] })
  const noted = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DTP1_1' } })
  await prisma.designTaskEvent.create({ data: { taskId: noted.id, type: 'SYSTEM', message: 'created' } })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: [OLD, KEEP] } } })
})

describe('pruneUntouchedTasksOutside', () => {
  it('deletes only untouched NEW tasks of orders outside the window', async () => {
    const n = await pruneUntouchedTasksOutside([KEEP])
    expect(n).toBe(1)
    const keys = (await prisma.designTask.findMany({ where: { orderId: { in: [OLD, KEEP] } } })).map(t => t.taskKey).sort()
    expect(keys).toEqual(['DTP1_2', 'DTP1_3', 'DTP2_1'])
  })
  it('keeps a NEW task that has a note or an uploaded artwork', async () => {
    await prisma.designTask.create({ data: { orderId: OLD, shopifyLineId: 'd', taskKey: 'DTP1_4', status: 'NEW',
      events: { create: { type: 'NOTE', message: 'hỏi xưởng' } } } })
    await prisma.designArtwork.create({ data: { orderId: KEEP, shopifyLineId: 'a', printArea: 'Front', version: 1, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png' } })
    const others = (await prisma.order.findMany({ where: { id: { notIn: [OLD, KEEP] } }, select: { id: true } })).map(o => o.id)
    expect(await pruneUntouchedTasksOutside(others)).toBe(0)
    const left = (await prisma.designTask.findMany({ where: { orderId: { in: [OLD, KEEP] } } })).map(t => t.taskKey).sort()
    expect(left).toEqual(['DTP1_2', 'DTP1_3', 'DTP1_4', 'DTP2_1'])
  })
})
