import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { loadWorkspace } from '@/lib/design-studio'

const ORDER_ID = 'gid://test/Order/ds-ws-1'
const SHOP = 'ds-ws.myshopify.com'
const SUP = 'sup_ds_ws'
let storeId = ''

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_ds_ws' }, create: { id: 'proj_ds_ws', name: 'DS ws', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_ws' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DSWS' }, create: { id: SUP, name: 'DS WS Supplier', code: 'DSWS' }, update: {} })
  await prisma.supplierProduct.upsert({
    where: { supplierId_sku: { supplierId: SUP, sku: 'SUP-SOCK' } },
    create: { supplierId: SUP, sku: 'SUP-SOCK', baseCost: 5, designTemplateUrl: 'https://drive.example/template' },
    update: { designTemplateUrl: 'https://drive.example/template' },
  })
  await prisma.skuDesign.upsert({ where: { sku: 'DSWS-SKU' }, create: { sku: 'DSWS-SKU', driveLink: 'https://drive.example/master' }, update: { driveLink: 'https://drive.example/master' } })
  await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_ds_ws', storeId, shopifyOrderNumber: '#DSW1', financialStatus: 'PAID',
      currency: 'USD', grossAmount: 50, expectedPayout: 48, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [
        {
          shopifyLineId: 'dsw-1', sku: 'DSWS-SKU', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 50,
          resolvedSupplierId: SUP, resolvedSupplierSku: 'SUP-SOCK', customized: true,
          customAttributesJson: JSON.stringify([
            { key: 'Custom Name', value: 'Ashley' },
            { key: '_print_files', value: JSON.stringify([{ print_area: 'Front', url: 'https://cdn.example/f.png' }]) },
          ]),
        },
        { shopifyLineId: 'dsw-2', sku: 'OTHER', productTitle: 'Mug', qty: 1, linePosition: 2, unitPrice: 20, customAttributesJson: null },
        {
          shopifyLineId: 'dsw-3', sku: 'DSWS-SKU-2', productTitle: 'Socks 2', qty: 1, linePosition: 3, unitPrice: 50,
          shopifyVariantId: 'gid://shopify/ProductVariant/123',
          customAttributesJson: JSON.stringify([
            { key: '_design', value: JSON.stringify({ v: 'cm1', layout: null, layers: [] }) },
            { key: '_product_url', value: 'https://shop.example/products/socks' },
          ]),
        },
        {
          shopifyLineId: 'dsw-4', sku: 'DSWS-SKU-3', productTitle: 'Socks 3', qty: 1, linePosition: 4, unitPrice: 50,
          shopifyVariantId: 'gid://shopify/ProductVariant/456',
          customAttributesJson: JSON.stringify([
            { key: '_design', value: JSON.stringify({ v: 'cm1', layout: null, layers: [] }) },
          ]),
        },
      ] },
    },
  })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.skuDesign.deleteMany({ where: { sku: 'DSWS-SKU' } })
})

describe('loadWorkspace', () => {
  it('returns null for an unknown order', async () => {
    expect(await loadWorkspace('nope')).toBeNull()
  })
  it('joins supplier, template, master artwork and print areas per line', async () => {
    const ws = await loadWorkspace(ORDER_ID)
    expect(ws?.order.shopifyOrderNumber).toBe('#DSW1')
    const [l1, l2, l3, l4] = ws!.lines
    expect(l1.supplier?.code).toBe('DSWS')
    expect(l1.templateUrl).toBe('https://drive.example/template')
    expect(l1.masterArtworkUrl).toBe('https://drive.example/master')
    expect(l1.personalization).toEqual([{ key: 'Custom Name', value: 'Ashley' }])
    expect(l1.printAreas).toEqual(['Front'])
    expect(l1.sourcePrintFiles[0].url).toBe('https://cdn.example/f.png')
    expect(l1.attributesLoaded).toBe(true)
    expect(l2.attributesLoaded).toBe(false)
    expect(l2.templateUrl).toBeNull()
    expect(l2.printAreas).toEqual(['Artwork'])
    expect(l3.customerDesignLink).not.toBeNull()
    expect(l3.customerDesignLink).toMatch(/^https:\/\/shop\.example\/products\/socks\?variant=123#cm-design=/)
    expect(l4.customerDesignLink).toBeNull()
  })
})
