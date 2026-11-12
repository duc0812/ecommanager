import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { agentFixture } from './helpers/design-agent-fixture'
import { prisma } from '@/lib/db'
import { listDesignLines, affectedForTask, findLineByKey } from '@/lib/design-agent/affected'

const fx = agentFixture('daf')
let o1: Awaited<ReturnType<typeof fx.order>>
let o10: Awaited<ReturnType<typeof fx.order>>
let fixed: { orderId: string; shopifyLineId: string; supplierSku: string | null }

beforeAll(async () => {
  await fx.cleanup()
  await fx.seed()
  o1 = await fx.order(1, { placedAt: '2026-11-05', supplierSku: 'WZIP-XL', taskStatus: 'REVIEW' })
  await fx.order(2, { placedAt: '2026-11-01', supplierSku: 'WZIP-L', exported: true, taskStatus: 'DONE' })
  await fx.order(3, { placedAt: '2026-11-08', supplierSku: 'WZIP-XL', taskStatus: 'NEW' })
  await fx.order(4, { fulfillmentStatus: 'fulfilled' })
  await fx.order(5, { pipelineStatus: 'CANCELLED' })
  await fx.order(6, { skus: ['DN2-Hoodie'] })
  await fx.order(7, { skus: ['DN12-Hoodie'] })
  await fx.order(8, { skus: ['HOODIE-XL=DN1'], placedAt: '2026-11-09', taskStatus: 'NEW' })
  await fx.order(9, { otherStore: true })
  o10 = await fx.order(10, { placedAt: '2026-11-10', exported: true, pipelineStatus: 'READY_TO_PRODUCTION' })
  await prisma.designTask.deleteMany({ where: { orderId: o10.orderId } })
  fixed = { orderId: o1.orderId, shopifyLineId: 'l1', supplierSku: 'WZIP-XL' }
})

afterAll(async () => { await fx.cleanup() })

describe('affected lines of a design', () => {
  it('lists every open order of the design, sent or not, before or after', async () => {
    const r = await listDesignLines('DN1', fx.storeId, fixed)
    expect(r.rows.map(x => [x.taskKey, x.taskStatus, x.sent, x.sameSupplierSku])).toEqual([
      ['DAF2_1', 'DONE', true, false], ['DAF3_1', 'NEW', false, true], ['DAF8_1', 'NEW', false, false], ['DAF10_1', null, true, false]])
    expect(r.fulfilledCount).toBe(1)
  })

  it('an empty design code matches nothing', async () => {
    expect(await listDesignLines('', fx.storeId, { orderId: o1.orderId, shopifyLineId: 'l1', supplierSku: null })).toEqual({ rows: [], fulfilledCount: 0 })
  })

  it('a line without a task is listed by its line key and found again', async () => {
    expect((await listDesignLines('DN1', fx.storeId, fixed)).rows.find(x => x.taskKey === 'DAF10_1')).toMatchObject({ taskStatus: null, sent: true })
    expect(await findLineByKey('DAF10_1')).toMatchObject({ orderId: o10.orderId })
    expect(await findLineByKey('DAF999_1')).toBeNull()
  })

  it('affectedForTask reads the design from the task line', async () => {
    const task = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DAF1_1' } })
    const r = await affectedForTask(task.id)
    expect(r.designCode).toBe('DN1')
    expect(r.rows.map(x => x.taskKey)).toEqual(['DAF2_1', 'DAF3_1', 'DAF8_1', 'DAF10_1'])
    expect(r.rows.find(x => x.taskKey === 'DAF3_1')?.sameSupplierSku).toBe(true)
  })
})
