import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { releaseLibraryTask, syncDesignTasks } from '@/lib/design-tasks'
import { listHandoffHub } from '@/lib/supplier-handoff'

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
  it('creates a NEW task per product line of an open order, and none for a tip', async () => {
    const r = await syncDesignTasks(ORDER_ID)
    expect(r.created).toBe(3)
    const tasks = await prisma.designTask.findMany({ where: { orderId: ORDER_ID }, orderBy: { taskKey: 'asc' } })
    expect(tasks.map(t => [t.taskKey, t.fromLibrary, t.supplierSnapshot])).toEqual([
      ['DTS1_1', false, 'DT Sync Supplier'], ['DTS1_2', true, 'DT Sync Supplier'], ['DTS1_3', false, null],
    ])
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
  it('a link from outside does not close a task somebody is working on, nor one that has a Studio file', async () => {
    await prisma.orderLine.updateMany({ where: { orderId: ORDER_ID, shopifyLineId: 's1' }, data: { designDriveLink: 'https://drive.example/x' } })
    for (const status of ['DOING', 'REVIEW', 'REJECTED', 'ASK_CUSTOMER']) {
      await prisma.designTask.update({ where: { taskKey: 'DTS1_1' }, data: { status } })
      expect((await syncDesignTasks(ORDER_ID)).completed).toBe(0)
      expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTS1_1' } }))?.status).toBe(status)
    }
    const art = await prisma.designArtwork.create({ data: { orderId: ORDER_ID, shopifyLineId: 's1', printArea: 'PRINT', version: 1, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png' } })
    for (const status of ['NEW', 'ASSIGNED']) {
      await prisma.designTask.update({ where: { taskKey: 'DTS1_1' }, data: { status } })
      expect((await syncDesignTasks(ORDER_ID)).completed).toBe(0)
      expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTS1_1' } }))?.status).toBe(status)
    }
    await prisma.designArtwork.update({ where: { id: art.id }, data: { removedAt: new Date() } })
  })
  it('completes an untouched NEW / ASSIGNED task when the line gained a design link elsewhere', async () => {
    await prisma.designTask.update({ where: { taskKey: 'DTS1_1' }, data: { status: 'ASSIGNED' } })
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
    expect(r.cancelled).toBe(3)
    expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTS1_1' } }))?.status).toBe('CANCELLED')
  })
})

const REJ_ORDER_ID = 'gid://test/Order/dt-sync-rej'
const OLD_REJ_ORDER_ID = 'gid://test/Order/dt-sync-rej-old'
const STATUS_ORDER_ID = 'gid://test/Order/dt-sync-status'

describe('syncDesignTasks — factory rejection and status changes', () => {
  beforeAll(async () => {
    const storeId = (await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })).id
    await prisma.supplier.upsert({ where: { code: 'DTSYNC' }, create: { id: SUP, name: 'DT Sync Supplier', code: 'DTSYNC' }, update: {} })
    const base = { projectId: 'proj_dt_sync', storeId, financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'), orderType: 'CUSTOM' }
    const line = (id: string, link: string | null) => ({ shopifyLineId: id, sku: id.toUpperCase(), productTitle: 'Mug', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP, designDriveLink: link })
    await prisma.order.create({ data: { ...base, id: REJ_ORDER_ID, shopifyOrderNumber: '#DTS2', pipelineStatus: 'PENDING_DESIGN', lines: { create: [line('j1', null)] } } })
    await prisma.order.create({ data: { ...base, id: OLD_REJ_ORDER_ID, shopifyOrderNumber: '#DTS3', pipelineStatus: 'DESIGN_REJECTED', lines: { create: [line('k1', 'https://drive.example/old')] } } })
    await prisma.order.create({ data: { ...base, id: STATUS_ORDER_ID, shopifyOrderNumber: '#DTS4', pipelineStatus: 'PENDING_DESIGN', lines: { create: [line('m1', null)] } } })
  })
  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: { in: [REJ_ORDER_ID, OLD_REJ_ORDER_ID, STATUS_ORDER_ID] } } })
  })

  it('reopens a DONE task as REJECTED when the factory rejects the order, once', async () => {
    await syncDesignTasks(REJ_ORDER_ID)
    await prisma.orderLine.updateMany({ where: { orderId: REJ_ORDER_ID }, data: { designDriveLink: 'https://drive.example/trello' } })
    expect((await syncDesignTasks(REJ_ORDER_ID)).completed).toBe(1)
    await prisma.order.update({ where: { id: REJ_ORDER_ID }, data: { pipelineStatus: 'DESIGN_REJECTED' } })

    const r = await syncDesignTasks(REJ_ORDER_ID)
    expect(r.reopened).toBe(1)
    const t = await prisma.designTask.findUnique({ where: { taskKey: 'DTS2_1' }, include: { events: true } })
    expect(t?.status).toBe('REJECTED')
    expect(JSON.parse(t!.rejectReasons!)).toEqual(['Xưởng trả file'])
    expect(t?.prevStatus).toBeNull()
    expect(t?.events.some(e => e.type === 'SYSTEM' && e.message === 'Xưởng trả file — mở lại task')).toBe(true)

    const again = await syncDesignTasks(REJ_ORDER_ID)
    expect(again).toEqual({ created: 0, cancelled: 0, completed: 0, reopened: 0 })
    expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTS2_1' } }))?.status).toBe('REJECTED')
  })

  it('does not auto-complete a factory-reopened task after the order leaves DESIGN_REJECTED', async () => {
    await prisma.order.update({ where: { id: REJ_ORDER_ID }, data: { pipelineStatus: 'READY_TO_PRODUCTION' } })
    const r = await syncDesignTasks(REJ_ORDER_ID)
    expect(r.completed).toBe(0)
    expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTS2_1' } }))?.status).toBe('REJECTED')
  })

  it('creates a REJECTED task for a DESIGN_REJECTED order that never had one', async () => {
    const r = await syncDesignTasks(OLD_REJ_ORDER_ID)
    expect(r.created).toBe(1)
    const t = await prisma.designTask.findUnique({ where: { taskKey: 'DTS3_1' } })
    expect(t?.status).toBe('REJECTED')
    expect(JSON.parse(t!.rejectReasons!)).toEqual(['Xưởng trả file'])
  })

  it('the order status PATCH cancels open tasks of an order set to CANCELLED', async () => {
    const { PATCH } = await import('@/app/api/fulfillment/orders/[id]/status/route')
    const { NextRequest } = await import('next/server')
    await syncDesignTasks(STATUS_ORDER_ID)
    expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTS4_1' } }))?.status).toBe('NEW')
    const req = new NextRequest('http://x/api/fulfillment/orders/x/status', { method: 'PATCH', body: JSON.stringify({ status: 'CANCELLED' }) })
    const res = await PATCH(req, { params: { id: STATUS_ORDER_ID } })
    expect(res.status).toBe(200)
    expect((await res.json()).designTaskErrors).toBeUndefined()
    expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTS4_1' } }))?.status).toBe('CANCELLED')
  })
})

describe('every line of an order not sent yet gets a task (owner 11/05/2026)', () => {
  const ID = 'gid://test/Order/dt-sync-every'
  const makeOrder = async (status: string, line: Record<string, unknown>) => {
    await prisma.order.deleteMany({ where: { id: ID } })
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })
    await prisma.order.create({ data: {
      id: ID, projectId: 'proj_dt_sync', storeId: store.id, shopifyOrderNumber: '#DTE1', financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1, totalFees: 0,
      refundedAmount: 0, placedAt: new Date('2026-10-01'), pipelineStatus: status, orderType: 'NON_CUSTOM',
      lines: { create: [{ shopifyLineId: 'e1', sku: 'E', productTitle: 'Tee', qty: 1, linePosition: 1, unitPrice: 1, customized: false, ...line }] },
    } })
  }
  const task = () => prisma.designTask.findFirst({ where: { orderId: ID } })
  afterAll(async () => { await prisma.order.deleteMany({ where: { id: ID } }) })

  it('flags a library line, and leaves it open for the scan: it does not close itself on the next sync', async () => {
    await makeOrder('READY_TO_PRODUCTION', { resolvedSupplierId: SUP, designDriveLink: 'https://drive.google.com/drive/folders/lib' })
    expect((await syncDesignTasks(ID)).created).toBe(1)
    expect(await task()).toMatchObject({ status: 'NEW', fromLibrary: true, kpi: 0, dueAt: null, taskKey: 'DTE1_1' })
    expect((await syncDesignTasks(ID)).completed).toBe(0)
    expect((await task())?.status).toBe('NEW')
  })

  it('closes a flagged task once the line was sent another way', async () => {
    await makeOrder('READY_TO_PRODUCTION', { resolvedSupplierId: SUP, designDriveLink: 'https://drive.google.com/drive/folders/lib' })
    await syncDesignTasks(ID)
    await prisma.orderLine.updateMany({ where: { orderId: ID }, data: { exportedAt: new Date(), exportedToSupplierId: SUP } })
    expect((await syncDesignTasks(ID)).completed).toBe(1)
    expect((await task())?.status).toBe('DONE')
  })

  it('makes a task for an unmapped line, with no supplier', async () => {
    await makeOrder('PENDING_MAPPING', { resolvedSupplierId: null, customized: true })
    expect((await syncDesignTasks(ID)).created).toBe(1)
    expect(await task()).toMatchObject({ status: 'NEW', fromLibrary: false, supplierSnapshot: null })
  })

  it('makes no task for a hidden fee product', async () => {
    await makeOrder('PENDING_MAPPING', { resolvedSupplierId: null, productTitle: 'Item Personalization', shopifyProductType: 'PPLR_HIDDEN_PRODUCT' })
    expect((await syncDesignTasks(ID)).created).toBe(0)
  })

  it('names the supplier once the line is mapped', async () => {
    await makeOrder('PENDING_MAPPING', { resolvedSupplierId: null })
    await syncDesignTasks(ID)
    await prisma.orderLine.updateMany({ where: { orderId: ID }, data: { resolvedSupplierId: SUP } })
    await syncDesignTasks(ID)
    expect((await task())?.supplierSnapshot).toBe('DT Sync Supplier')
  })

  it.each(['EXPORTED', 'FULFILLED', 'CANCELLED'])('adds nothing to an order already %s', async status => {
    await makeOrder(status, { resolvedSupplierId: SUP, designDriveLink: 'https://drive.google.com/drive/folders/lib' })
    expect((await syncDesignTasks(ID)).created).toBe(0)
    await makeOrder(status, { resolvedSupplierId: null })
    expect((await syncDesignTasks(ID)).created).toBe(0)
    expect(await task()).toBeNull()
  })

  it('adds nothing for a line already sent', async () => {
    await makeOrder('READY_TO_PRODUCTION', { resolvedSupplierId: SUP, designDriveLink: 'https://drive.google.com/drive/folders/lib', exportedAt: new Date() })
    expect((await syncDesignTasks(ID)).created).toBe(0)
  })

  describe('Chuyển sang sản xuất', () => {
    const admin = { id: 'u-admin', name: 'Admin', role: 'ADMIN', permissions: [] }
    const LINK = 'https://drive.google.com/drive/folders/lib'

    it('closes the flagged task, keeps the link, and the order reaches the hub', async () => {
      await makeOrder('READY_TO_PRODUCTION', { resolvedSupplierId: SUP, designDriveLink: LINK })
      await prisma.order.update({ where: { id: ID }, data: { designReady: true } })
      await syncDesignTasks(ID)
      expect((await listHandoffHub({ q: '#DTE1' })).pending).toEqual([])
      const r = await releaseLibraryTask('DTE1_1', admin as any)
      expect(r.task.status).toBe('DONE')
      expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: ID } })).designDriveLink).toBe(LINK)
      expect((await listHandoffHub({ q: '#DTE1' })).pending.map(c => c.order.id)).toEqual([ID])
      expect((await syncDesignTasks(ID)).created).toBe(0)
      expect((await task())?.status).toBe('DONE')
    })

    it('refuses without the right to approve', async () => {
      await makeOrder('READY_TO_PRODUCTION', { resolvedSupplierId: SUP, designDriveLink: LINK })
      await syncDesignTasks(ID)
      await expect(releaseLibraryTask('DTE1_1', { id: 'u', name: 'U', role: 'SUPPORT', permissions: [] } as any)).rejects.toThrow('được duyệt')
      expect((await task())?.status).toBe('NEW')
    })

    it('refuses a task with no flag, and one not waiting any more', async () => {
      await makeOrder('PENDING_DESIGN', { resolvedSupplierId: SUP })
      await syncDesignTasks(ID)
      await expect(releaseLibraryTask('DTE1_1', admin as any)).rejects.toThrow('chờ quét')
      await prisma.designTask.updateMany({ where: { orderId: ID }, data: { fromLibrary: true, status: 'REVIEW' } })
      await expect(releaseLibraryTask('DTE1_1', admin as any)).rejects.toThrow('chờ quét')
    })

    it('refuses an unmapped line', async () => {
      await makeOrder('PENDING_MAPPING', { resolvedSupplierId: null, designDriveLink: LINK })
      await syncDesignTasks(ID)
      await expect(releaseLibraryTask('DTE1_1', admin as any)).rejects.toThrow('chưa mapping')
    })
  })

  it('still closes a task of a line given a link by hand', async () => {
    await makeOrder('PENDING_DESIGN', { resolvedSupplierId: SUP })
    await syncDesignTasks(ID)
    await prisma.orderLine.updateMany({ where: { orderId: ID }, data: { designDriveLink: 'https://drive.google.com/drive/folders/hand' } })
    expect((await syncDesignTasks(ID)).completed).toBe(1)
    expect((await task())?.status).toBe('DONE')
  })
})
