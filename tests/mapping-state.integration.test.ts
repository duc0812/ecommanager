import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { mappingStates } from '@/lib/mapping-state'

const SHOP = 'mapping-state.myshopify.com'
const SUP = 'sup_mapping_state'
let storeId = ''

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_ms' }, create: { id: 'proj_ms', name: 'MS', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ms' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'MSTATE' }, create: { id: SUP, name: 'Blanket Co', code: 'MSTATE' }, update: {} })
  const tpl = await prisma.printTemplate.create({ data: { supplierId: SUP, name: 'Blanket 50x60', supplierSku: 'FBZ-M', widthPx: 100, heightPx: 120, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 100, h: 120 }]) } })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'FBZ-M', productName: 'Fleece blanket', baseCost: 10, printTemplateId: tpl.id } })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'SCARF-1', productName: 'Scarf', baseCost: 5 } })
  await prisma.order.create({ data: {
    id: 'gid://test/Order/ms-1', projectId: 'proj_ms', storeId, shopifyOrderNumber: '#MS1', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-11-01'), pipelineStatus: 'PENDING_DESIGN', orderType: 'NON_CUSTOM',
    lines: { create: [
      { shopifyLineId: 'a', productTitle: 'Old blanket', shopifyProductType: 'Blanket', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP, resolvedSupplierSku: 'FBZ-M' },
      { shopifyLineId: 'b', productTitle: 'Scarf', shopifyProductType: 'Scarf', qty: 1, linePosition: 2, unitPrice: 1, resolvedSupplierId: SUP, resolvedSupplierSku: 'SCARF-1' },
    ] },
  } })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { projectId: 'proj_ms' } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
})

describe('mappingStates', () => {
  it('sorts lines into ready, unmapped with a hint from their type, and missing a template', async () => {
    const line = (key: string, sku: string | null, type: string) => ({ key, storeId, orderId: 'x', resolvedSupplierId: sku ? SUP : null, resolvedSupplierSku: sku, shopifyProductId: null, shopifyProductType: type })
    const v = await mappingStates([line('mapped-tpl', 'FBZ-M', 'Blanket'), line('mapped-no-tpl', 'SCARF-1', 'Scarf'), line('new-blanket', null, ' blanket '), line('new-scarf', null, 'Scarf'), line('new-lamp', null, 'Lamp')])
    expect(v.get('mapped-tpl')).toEqual({ state: 'READY', hint: null })
    expect(v.get('mapped-no-tpl')).toEqual({ state: 'NO_TEMPLATE', hint: null })
    expect(v.get('new-blanket')).toEqual({ state: 'UNMAPPED', hint: 'Blanket Co · Fleece blanket' })
    expect(v.get('new-scarf')).toEqual({ state: 'NO_TEMPLATE', hint: null })
    expect(v.get('new-lamp')).toEqual({ state: 'NO_TEMPLATE', hint: null })
  })
})
