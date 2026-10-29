import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { syncDesignTasks, transitionTask, listTasks, loadTask, type Actor } from '@/lib/design-tasks'

const ORDER_ID = 'gid://test/Order/dtt-1'
const BARE_ORDER_ID = 'gid://test/Order/dtt-3'
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
  await prisma.order.create({
    data: {
      id: BARE_ORDER_ID, projectId: 'proj_dtt', storeId, shopifyOrderNumber: '#DTT3', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [
        { shopifyLineId: 'b1', sku: 'B1', productTitle: 'Jersey', shopifyProductType: 'Baseball Jersey', qty: 1, linePosition: 1, unitPrice: 1,
          resolvedSupplierId: SUP, customized: true,
          customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Z' }, { key: '_print_files', value: PRINT_FILES }]) },
      ] },
    },
  })
  leadId = (await prisma.appUser.upsert({ where: { email: 'lead@dt.test' }, create: { name: 'Lead', email: 'lead@dt.test', role: 'ADMIN' }, update: {} })).id
  desId = (await prisma.appUser.upsert({ where: { email: 'des@dt.test' }, create: { name: 'Des', email: 'des@dt.test', role: 'SUPPORT' }, update: {} })).id
  LEAD = { id: leadId, name: 'Lead', role: 'ADMIN' }
  DES = { id: desId, name: 'Des', role: 'SUPPORT' }
  await syncDesignTasks(ORDER_ID)
  await syncDesignTasks(BARE_ORDER_ID)
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: [ORDER_ID, BARE_ORDER_ID] } } })
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
    expect((await transitionTask('DTT3_1', DES, { to: 'DOING' })).task.status).toBe('DOING')
    await expect(transitionTask('DTT3_1', DES, { to: 'REVIEW' })).rejects.toThrow('Chưa có file in nào')
    expect((await loadTask('DTT3_1'))!.task.status).toBe('DOING')
  })
  it('continuing from ASK_CUSTOMER back to DOING logs "Tiếp tục làm"', async () => {
    await transitionTask('DTT3_1', DES, { to: 'ASK_CUSTOMER', note: 'ảnh mờ?' })
    expect((await transitionTask('DTT3_1', DES, { to: 'DOING', continue: true })).task.status).toBe('DOING')
    const events = (await loadTask('DTT3_1'))!.events.filter(e => e.type === 'STATUS').map(e => e.message)
    expect(events).toEqual(['Nhận việc', 'Tiếp tục làm'])
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
    expect(d!.slots).toEqual([])
    expect(d!.driveFolder).toBeNull()
    expect(await loadTask('NOPE_1')).toBeNull()
  })
})

const TPL_ORDER_ID = 'gid://test/Order/dtt-2'
const TPL_SUP = 'sup_dtt_tpl'
let des2Id = ''
let DES2: Actor

async function addArtwork(shopifyLineId: string, printArea: string) {
  await prisma.designArtwork.create({
    data: { orderId: TPL_ORDER_ID, shopifyLineId, printArea, version: 1, fileName: `${printArea}.png`, storagePath: `x/${printArea}.png`, size: 1, mimeType: 'image/png' },
  })
}

describe('template slots and ownership', () => {
  beforeAll(async () => {
    const storeId = (await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })).id
    await prisma.supplier.upsert({ where: { code: 'DTTTPL' }, create: { id: TPL_SUP, name: 'DTT Template Supplier', code: 'DTTTPL' }, update: {} })
    await prisma.printTemplate.create({
      data: {
        supplierId: TPL_SUP, supplierSku: null, name: 'Jersey FB', widthPx: 2000, heightPx: 1000,
        areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 1000, h: 1000 }, { name: 'Back', x: 1000, y: 0, w: 1000, h: 1000 }]),
      },
    })
    const attrs = JSON.stringify([{ key: 'Name', value: 'Y' }, { key: '_print_files', value: PRINT_FILES }])
    await prisma.order.create({
      data: {
        id: TPL_ORDER_ID, projectId: 'proj_dtt', storeId, shopifyOrderNumber: '#DTT2', financialStatus: 'PAID', currency: 'USD',
        grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
        pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
        lines: { create: [
          { shopifyLineId: 'f1', sku: 'F1', productTitle: 'Jersey', shopifyProductType: 'Baseball Jersey', qty: 1, linePosition: 1, unitPrice: 1,
            resolvedSupplierId: TPL_SUP, customized: true, customAttributesJson: attrs },
          { shopifyLineId: 'f2', sku: 'F2', productTitle: 'Jersey', shopifyProductType: 'Baseball Jersey', qty: 1, linePosition: 2, unitPrice: 1,
            resolvedSupplierId: TPL_SUP, customized: true, customAttributesJson: attrs },
        ] },
      },
    })
    des2Id = (await prisma.appUser.upsert({ where: { email: 'des2@dt.test' }, create: { name: 'Des2', email: 'des2@dt.test', role: 'SUPPORT' }, update: {} })).id
    DES2 = { id: des2Id, name: 'Des2', role: 'SUPPORT' }
    await syncDesignTasks(TPL_ORDER_ID)
  })

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: TPL_ORDER_ID } })
    await prisma.supplier.deleteMany({ where: { id: TPL_SUP } })
    await prisma.appUser.deleteMany({ where: { email: 'des2@dt.test' } })
  })

  it('loadTask exposes the template areas as slots', async () => {
    expect((await loadTask('DTT2_1'))!.slots).toEqual(['Front', 'Back'])
  })

  it('REVIEW and DONE are refused until every template area has artwork, then succeed', async () => {
    await transitionTask('DTT2_1', DES, { to: 'DOING' })
    await expect(transitionTask('DTT2_1', DES, { to: 'REVIEW' })).rejects.toThrow('Chưa có artwork cho: Front, Back')
    await addArtwork('f1', 'Front')
    await expect(transitionTask('DTT2_1', DES, { to: 'REVIEW' })).rejects.toThrow('Chưa có artwork cho: Back')
    expect((await loadTask('DTT2_1'))!.task.status).toBe('DOING')
    await addArtwork('f1', 'Back')
    expect((await transitionTask('DTT2_1', DES, { to: 'REVIEW' })).task.status).toBe('REVIEW')
    await prisma.designArtwork.deleteMany({ where: { orderId: TPL_ORDER_ID, shopifyLineId: 'f1', printArea: 'Back' } })
    await expect(transitionTask('DTT2_1', LEAD, { to: 'DONE' })).rejects.toThrow('Chưa có file cho vùng: Back')
    expect((await loadTask('DTT2_1'))!.task.status).toBe('REVIEW')
    await addArtwork('f1', 'Back')
    const r = await transitionTask('DTT2_1', LEAD, { to: 'DONE' })
    expect(r.task.status).toBe('DONE')
    const front = await prisma.designArtwork.findFirst({ where: { orderId: TPL_ORDER_ID, shopifyLineId: 'f1', printArea: 'Front' } })
    const line = await prisma.orderLine.findFirst({ where: { orderId: TPL_ORDER_ID, shopifyLineId: 'f1' } })
    expect(line?.designDriveLink).toBe(`/api/design-studio/file/${front!.id}`)
  })

  it('a leader may approve a set that leaves a template area empty once they accept it; it is not saved to the library', async () => {
    await prisma.designArtwork.deleteMany({ where: { orderId: TPL_ORDER_ID, shopifyLineId: 'f1' } })
    await prisma.designTask.update({ where: { taskKey: 'DTT2_1' }, data: { status: 'REVIEW' } })
    await addArtwork('f1', 'Front')
    await expect(transitionTask('DTT2_1', LEAD, { to: 'DONE' })).rejects.toThrow('Chưa có file cho vùng: Back')
    const r = await transitionTask('DTT2_1', LEAD, { to: 'DONE', acceptMissingAreas: true })
    expect(r.task.status).toBe('DONE')
    const events = await prisma.designTaskEvent.findMany({ where: { task: { taskKey: 'DTT2_1' } }, orderBy: { createdAt: 'desc' }, take: 3 })
    expect(events.map(e => e.message)).toContain('Duyệt khi chưa có file cho vùng: Back — không lưu vào Design Library')
    const front = await prisma.designArtwork.findFirst({ where: { orderId: TPL_ORDER_ID, shopifyLineId: 'f1', printArea: 'Front' } })
    expect((await prisma.orderLine.findFirst({ where: { orderId: TPL_ORDER_ID, shopifyLineId: 'f1' } }))?.designDriveLink).toBe(`/api/design-studio/file/${front!.id}`)
  })

  it("a designer cannot take, decline, submit or ask on another designer's task", async () => {
    await transitionTask('DTT2_2', LEAD, { to: 'ASSIGNED', assigneeId: desId })
    const refusal = transitionTask('DTT2_2', DES2, { to: 'DOING' })
    await expect(refusal).rejects.toThrow('Task đang thuộc về Des')
    await expect(transitionTask('DTT2_2', DES2, { to: 'DOING' })).rejects.not.toThrow(/not found/i)
    await expect(transitionTask('DTT2_2', DES2, { to: 'NEW' })).rejects.toThrow(/thuộc về Des/)
    expect((await transitionTask('DTT2_2', DES, { to: 'DOING' })).task.status).toBe('DOING')
    await expect(transitionTask('DTT2_2', DES2, { to: 'REVIEW' })).rejects.toThrow(/thuộc về Des/)
    await expect(transitionTask('DTT2_2', DES2, { to: 'ASK_CUSTOMER', note: 'x' })).rejects.toThrow(/thuộc về Des/)
    const t = (await loadTask('DTT2_2'))!.task
    expect(t.status).toBe('DOING'); expect(t.assigneeId).toBe(desId)
  })

  it('a leader can reassign, and the new owner takes over', async () => {
    const r = await transitionTask('DTT2_2', LEAD, { to: 'ASSIGNED', assigneeId: des2Id })
    expect(r.task.assigneeId).toBe(des2Id)
    expect((await transitionTask('DTT2_2', DES2, { to: 'DOING' })).task.status).toBe('DOING')
    await expect(transitionTask('DTT2_2', DES, { to: 'REVIEW' })).rejects.toThrow('Task đang thuộc về Des2')
    await addArtwork('f2', 'Front')
    await addArtwork('f2', 'Back')
    expect((await transitionTask('DTT2_2', LEAD, { to: 'REVIEW' })).task.status).toBe('REVIEW')
  })
})

const EXT_ORDER_ID = 'gid://test/Order/dtt-ext'
const EXT_LINK = 'https://drive.google.com/file/d/trello-link'

describe('DONE when the design already arrived outside the studio', () => {
  beforeAll(async () => {
    const storeId = (await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })).id
    await prisma.supplier.upsert({ where: { code: 'DTTR' }, create: { id: SUP, name: 'DTT Supplier', code: 'DTTR' }, update: {} })
    const line = (id: string, pos: number) => ({ shopifyLineId: id, sku: id.toUpperCase(), productTitle: 'Jersey', qty: 1, linePosition: pos, unitPrice: 1,
      resolvedSupplierId: SUP, customized: true, customAttributesJson: JSON.stringify([{ key: '_print_files', value: PRINT_FILES }]) })
    await prisma.order.create({
      data: {
        id: EXT_ORDER_ID, projectId: 'proj_dtt', storeId, shopifyOrderNumber: '#DTTX', financialStatus: 'PAID', currency: 'USD',
        grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
        pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM', lines: { create: [line('x1', 1), line('x2', 2)] },
      },
    })
    for (const id of ['x1', 'x2']) {
      await prisma.designArtwork.create({ data: { orderId: EXT_ORDER_ID, shopifyLineId: id, printArea: 'PRINT', version: 1, fileName: 'p.png', storagePath: 'x/p.png', size: 1, mimeType: 'image/png' } })
    }
    await syncDesignTasks(EXT_ORDER_ID)
    for (const key of ['DTTX_1', 'DTTX_2']) {
      await transitionTask(key, DES, { to: 'DOING' })
      await transitionTask(key, DES, { to: 'REVIEW' })
    }
  })
  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: EXT_ORDER_ID } })
  })

  it('keeps the external link and does not touch the order', async () => {
    await prisma.orderLine.updateMany({ where: { orderId: EXT_ORDER_ID, shopifyLineId: 'x1' }, data: { designDriveLink: EXT_LINK } })
    const r = await transitionTask('DTTX_1', LEAD, { to: 'DONE' })
    expect(r.task.status).toBe('DONE')
    expect(r.order).toEqual({ id: EXT_ORDER_ID, designReady: false, pipelineStatus: 'PENDING_DESIGN' })
    const line = await prisma.orderLine.findFirst({ where: { orderId: EXT_ORDER_ID, shopifyLineId: 'x1' } })
    expect(line?.designDriveLink).toBe(EXT_LINK)
    const events = (await loadTask('DTTX_1'))!.events
    expect(events.at(-1)).toMatchObject({ type: 'SYSTEM', message: 'Design đã có từ ngoài studio — giữ link hiện tại' })
    expect(events.some(e => e.message === 'Duyệt design')).toBe(false)
  })

  it('a factory-reopened task still rewrites the old link when approved in the studio', async () => {
    await prisma.orderLine.updateMany({ where: { orderId: EXT_ORDER_ID, shopifyLineId: 'x2' }, data: { designDriveLink: EXT_LINK } })
    await prisma.designTask.update({ where: { taskKey: 'DTTX_2' }, data: { status: 'DONE' } })
    await prisma.order.update({ where: { id: EXT_ORDER_ID }, data: { pipelineStatus: 'DESIGN_REJECTED' } })
    expect((await syncDesignTasks(EXT_ORDER_ID)).reopened).toBe(2)
    await transitionTask('DTTX_2', DES, { to: 'REVIEW' })
    const r = await transitionTask('DTTX_2', LEAD, { to: 'DONE' })
    expect(r.task.status).toBe('DONE')
    expect(r.task.rejectReasons).toEqual([])
    const art = await prisma.designArtwork.findFirst({ where: { orderId: EXT_ORDER_ID, shopifyLineId: 'x2' } })
    const line = await prisma.orderLine.findFirst({ where: { orderId: EXT_ORDER_ID, shopifyLineId: 'x2' } })
    expect(line?.designDriveLink).toBe(`/api/design-studio/file/${art!.id}`)
  })
})
