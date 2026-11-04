import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { syncDesignTasks } from '@/lib/design-tasks'
import { LOCAL_LIBRARY_KEY } from '@/lib/artwork-library-state'

const PROJECT = 'proj_rd', STORE = 'store-rd', SUP = 'sup-rd', TPL = 'tpl-rd', PRODUCT = 'gid://test/Product/rd', ORDER = 'gid://test/Order/rd1', ORDER_LATE = 'gid://test/Order/rd2', ORDER_OFF = 'gid://test/Order/rd3'
const printFiles = { key: '_print_files', value: JSON.stringify([{ print_area: 'PRINT', url: 'https://cdn.example/p.png' }]) }
const saidNo = { key: 'Custom Name Yes Or No', value: 'No' }
let before: string | null = null

function order(id: string, n: string, product: string) {
  return prisma.order.create({ data: {
    id, projectId: PROJECT, storeId: STORE, shopifyOrderNumber: n, financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-11-01'), pipelineStatus: 'PENDING_DESIGN', orderType: 'MIXED',
    lines: { create: [{ shopifyLineId: 'l1', sku: 'RD260001-L', productTitle: 'Jersey', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP, resolvedSupplierSku: 'RDJ-L', shopifyProductId: product, customized: true, customAttributesJson: JSON.stringify([printFiles]), customallFieldsJson: JSON.stringify([saidNo]) }] },
  } })
}

beforeAll(async () => {
  before = (await prisma.appSetting.findUnique({ where: { key: LOCAL_LIBRARY_KEY } }))?.value ?? null
  await prisma.project.create({ data: { id: PROJECT, name: 'RD', startDate: new Date('2026-06-01') } })
  await prisma.shopifyStore.create({ data: { id: STORE, shop: 'rd.myshopify.com', projectId: PROJECT } })
  await prisma.supplier.create({ data: { id: SUP, name: 'RD Sup', code: 'RDSUP' } })
  await prisma.printTemplate.create({ data: { id: TPL, supplierId: SUP, supplierSku: 'RDJ', name: 'RD', widthPx: 100, heightPx: 100, dpi: 150, bleedIn: 0, safeIn: 0, mirror: false, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 100, h: 100 }]) } })
  const entries = [{ id: 'flat-text:RD260001', storeId: STORE, shopifyProductId: PRODUCT, printTemplateId: TPL, optionKey: '', status: 'READY', specs: [{ design: 'RD260001', supplierSku: 'RDJ', fields: ['Custom name'] }] }]
  await prisma.appSetting.upsert({ where: { key: LOCAL_LIBRARY_KEY }, create: { key: LOCAL_LIBRARY_KEY, value: JSON.stringify({ entries }) }, update: { value: JSON.stringify({ entries }) } })
  await order(ORDER, '#RD1', PRODUCT)
  await order(ORDER_LATE, '#RD2', PRODUCT)
  await order(ORDER_OFF, '#RD3', 'gid://test/Product/rd-off')
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId: STORE } })
  await prisma.printTemplate.deleteMany({ where: { id: TPL } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.shopifyStore.deleteMany({ where: { id: STORE } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  if (before === null) await prisma.appSetting.deleteMany({ where: { key: LOCAL_LIBRARY_KEY } })
  else await prisma.appSetting.update({ where: { key: LOCAL_LIBRARY_KEY }, data: { value: before } })
})

describe('readiness of a line with the personaliser print files', () => {
  it('is AUTO when the library serves it', async () => {
    await syncDesignTasks(ORDER)
    expect((await prisma.designTask.findFirstOrThrow({ where: { orderId: ORDER } })).readiness).toBe('AUTO')
  })
  it('stays LOW when the library does not serve it', async () => {
    await syncDesignTasks(ORDER_OFF)
    expect((await prisma.designTask.findFirstOrThrow({ where: { orderId: ORDER_OFF } })).readiness).toBe('LOW')
  })
  it('a task already labelled LOW moves to AUTO on the next sync', async () => {
    await prisma.designTask.create({ data: { orderId: ORDER_LATE, shopifyLineId: 'l1', taskKey: 'RD2_1', status: 'NEW', readiness: 'LOW' } })
    await syncDesignTasks(ORDER_LATE)
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'RD2_1' } })).readiness).toBe('AUTO')
  })
})
