import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { saveProfile } from '@/lib/repos/product-profiles'
import { toRouteKey } from '@/lib/product-profiles'
import { DROPSHIP_TASK_MESSAGE, syncDesignTasks } from '@/lib/design-tasks'
import { DROPSHIP_OFF_MESSAGE, listDropshipLines } from '@/lib/dropship'

const SHOP = 'dropship-toggle.myshopify.com'
const SUP = 'sup_dropship_toggle'
const ROBE = 'gid://shopify/Product/777001'
const OPEN = 'gid://test/Order/dst-open'
const UNMAPPED = 'gid://test/Order/dst-unmapped'
const SHIPPED = 'gid://test/Order/dst-shipped'
let storeId = ''

const order = (id: string, number: string, status: string, supplierId: string | null, extra: Record<string, unknown> = {}) => prisma.order.create({ data: {
  id, projectId: 'proj_dst', storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1,
  totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-11-01'), pipelineStatus: status, orderType: 'NON_CUSTOM', ...extra,
  lines: { create: [{ shopifyLineId: 'r1', sku: 'RM-ROBE', productTitle: 'Christmas Grump Hooded Robe', variantTitle: 'Classic Robe', qty: 1, linePosition: 1, unitPrice: 1,
    resolvedSupplierId: supplierId, resolvedSupplierSku: supplierId ? 'ROBE-1' : null, shopifyProductId: ROBE, shopifyVariantId: `v-${number}` }] },
} })

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_dst' }, create: { id: 'proj_dst', name: 'DST', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dst' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DSTOG' }, create: { id: SUP, name: 'Robe Dropship', code: 'DSTOG' }, update: {} })
  const sp = await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'ROBE-1', productName: 'Grump Robe', baseCost: 18 } })
  await prisma.variantManualMapping.create({ data: { shopifyVariantId: 'v-#DST1', shopifyProductTitle: 'Christmas Grump Hooded Robe', supplierProductId: sp.id } })
  await order(OPEN, '#DST1', 'PENDING_DESIGN', SUP)
  await order(UNMAPPED, '#DST2', 'PENDING_MAPPING', null)
  await order(SHIPPED, '#DST3', 'FULFILLED', SUP, { fulfillmentStatus: 'FULFILLED' })
  for (const id of [OPEN, UNMAPPED]) await syncDesignTasks(id)
  await prisma.designTask.create({ data: { orderId: SHIPPED, shopifyLineId: 'r1', taskKey: 'DST3_1', status: 'REJECTED' } })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { projectId: 'proj_dst' } })
  await prisma.productProfile.deleteMany({ where: { storeId } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
})

const taskOf = (orderId: string) => prisma.designTask.findFirstOrThrow({ where: { orderId }, include: { events: true } })

describe('dropship toggle on a product', () => {
  it('turning it on flags every line and cancels every open task, the shipped order included', async () => {
    expect((await taskOf(OPEN)).status).toBe('NEW')
    const r = await saveProfile(toRouteKey(storeId, ROBE), { dropship: true })
    expect(r.profile.dropship).toBe(true)
    expect(r.dropship?.lines).toBe(3)
    expect(await prisma.orderLine.count({ where: { shopifyProductId: ROBE, dropship: true } })).toBe(3)
    for (const id of [OPEN, UNMAPPED, SHIPPED]) {
      const t = await taskOf(id)
      expect(t.status).toBe('CANCELLED')
      expect(t.events.map(e => e.message)).toContain(DROPSHIP_TASK_MESSAGE)
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: OPEN } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: SHIPPED } })).pipelineStatus).toBe('FULFILLED')
  })
  it('lists the open lines: the unmapped one to map, the mapped one waiting to be sent', async () => {
    const { unmapped, mapped } = await listDropshipLines()
    expect(unmapped.map(r => r.orderNumber)).toEqual(['#DST2'])
    expect(mapped.map(r => [r.orderNumber, r.supplier?.name, r.supplierSku])).toEqual([['#DST1', 'Robe Dropship', 'ROBE-1']])
    expect((await listDropshipLines({ q: 'DST2' })).mapped).toEqual([])
  })
  it('turning it off reopens the tasks on open orders only', async () => {
    const r = await saveProfile(toRouteKey(storeId, ROBE), { dropship: false })
    expect(r.dropship?.tasks).toBe(2)
    expect(await prisma.orderLine.count({ where: { shopifyProductId: ROBE, dropship: true } })).toBe(0)
    for (const id of [OPEN, UNMAPPED]) {
      const t = await taskOf(id)
      expect(t.status).toBe('NEW')
      expect(t.events.map(e => e.message)).toContain(DROPSHIP_OFF_MESSAGE)
    }
    expect((await taskOf(SHIPPED)).status).toBe('CANCELLED')
  })
  it('a line already sent gets no task back when the flag goes off', async () => {
    await saveProfile(toRouteKey(storeId, ROBE), { dropship: true })
    await prisma.orderLine.updateMany({ where: { orderId: OPEN }, data: { exportedAt: new Date() } })
    await saveProfile(toRouteKey(storeId, ROBE), { dropship: false })
    expect((await taskOf(OPEN)).status).toBe('CANCELLED')
    expect((await taskOf(UNMAPPED)).status).toBe('NEW')
  })
})
