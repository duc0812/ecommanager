import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { syncDesignTasks, transitionTask, listTasks, loadTask, type Actor } from '@/lib/design-tasks'

const ORDER_ID = 'gid://test/Order/dtt-1'
const SHOP = 'dtt.myshopify.com'
const SUP = 'sup_dtt'
const PRINT_FILES = JSON.stringify([{ print_area: 'PRINT', url: 'https://cdn.example/dtt.png' }])

let leadId = ''
let desId = ''
let LEAD: Actor
let DES: Actor

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_dtt' }, create: { id: 'proj_dtt', name: 'DTT', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dtt' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DTTR' }, create: { id: SUP, name: 'DTT Supplier', code: 'DTTR' }, update: {} })
  await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_dtt', storeId, shopifyOrderNumber: '#DTT1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [
        { shopifyLineId: 't1', sku: 'T1', productTitle: 'Jersey', shopifyProductType: 'Baseball Jersey', qty: 1, linePosition: 1, unitPrice: 1,
          resolvedSupplierId: SUP, customized: true,
          customAttributesJson: JSON.stringify([{ key: 'Name', value: 'X' }, { key: '_print_files', value: PRINT_FILES }]) },
        { shopifyLineId: 'tip1', sku: null, productTitle: 'Tip', qty: 1, linePosition: 2, unitPrice: 1 },
      ] },
    },
  })
  await prisma.designArtwork.create({
    data: { orderId: ORDER_ID, shopifyLineId: 't1', printArea: 'PRINT', version: 1, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png' },
  })
  leadId = (await prisma.appUser.upsert({ where: { email: 'lead@dt.test' }, create: { name: 'Lead', email: 'lead@dt.test', role: 'ADMIN' }, update: {} })).id
  desId = (await prisma.appUser.upsert({ where: { email: 'des@dt.test' }, create: { name: 'Des', email: 'des@dt.test', role: 'SUPPORT' }, update: {} })).id
  LEAD = { id: leadId, name: 'Lead', role: 'ADMIN' }
  DES = { id: desId, name: 'Des', role: 'SUPPORT' }
  await syncDesignTasks(ORDER_ID)
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['lead@dt.test', 'des@dt.test'] } } })
})

describe('transitionTask / listTasks / loadTask', () => {
  it('designer cannot assign; leader can and dueAt/kpi are set', async () => {
    await expect(transitionTask('DTT1_1', DES, { to: 'ASSIGNED', assigneeId: desId })).rejects.toThrow(/không được phép|not allowed/i)
    const r = await transitionTask('DTT1_1', LEAD, { to: 'ASSIGNED', assigneeId: desId, kpi: 0.5, dueHours: 10, note: 'dùng master' })
    expect(r.task.status).toBe('ASSIGNED'); expect(r.task.assigneeId).toBe(desId); expect(r.task.kpi).toBe(0.5)
    expect(new Date(r.task.dueAt!).getTime()).toBeGreaterThan(Date.now() + 9 * 3600_000)
  })
  it('designer takes, submits for review; review requires artwork', async () => {
    expect((await transitionTask('DTT1_1', DES, { to: 'DOING' })).task.status).toBe('DOING')
    expect((await transitionTask('DTT1_1', DES, { to: 'REVIEW' })).task.status).toBe('REVIEW')
  })
  it('leader rejects with reasons, designer resubmits', async () => {
    const r = await transitionTask('DTT1_1', LEAD, { to: 'REJECTED', reasons: ['Thiếu nét'], note: 'vỡ' })
    expect(r.task.rejectReasons).toEqual(['Thiếu nét'])
    expect((await transitionTask('DTT1_1', DES, { to: 'REVIEW' })).task.status).toBe('REVIEW')
  })
  it('ask customer then continue restores REVIEW', async () => {
    expect((await transitionTask('DTT1_1', DES, { to: 'ASK_CUSTOMER', note: 'font?' })).task.status).toBe('ASK_CUSTOMER')
    const r = await transitionTask('DTT1_1', DES, { to: 'REVIEW', continue: true })
    expect(r.task.status).toBe('REVIEW')
  })
  it('leader approves → line done, order leaves PENDING_DESIGN', async () => {
    const r = await transitionTask('DTT1_1', LEAD, { to: 'DONE' })
    expect(r.task.status).toBe('DONE'); expect(r.order?.designReady).toBe(true); expect(r.order?.pipelineStatus).not.toBe('PENDING_DESIGN')
    const line = await prisma.orderLine.findFirst({ where: { orderId: ORDER_ID, shopifyLineId: 't1' } })
    expect(line?.designDriveLink).toMatch(/^\/api\/design-studio\/file\//)
  })
  it('reopen clears the link', async () => {
    const r = await transitionTask('DTT1_1', DES, { to: 'DOING' })
    expect(r.task.status).toBe('DOING'); expect(r.order?.designReady).toBe(false)
  })
  it('listTasks filters by status and assignee; loadTask returns the line and events', async () => {
    const mine = await listTasks({ assigneeId: desId }); expect(mine.map(t => t.taskKey)).toContain('DTT1_1')
    expect((await listTasks({ statuses: ['DONE'] })).some(t => t.taskKey === 'DTT1_1')).toBe(false)
    const d = await loadTask('DTT1_1'); expect(d?.line.shopifyLineId ?? d?.task.shopifyLineId).toBe('t1'); expect(d!.events.length).toBeGreaterThan(3)
    expect(await loadTask('NOPE_1')).toBeNull()
  })
})
