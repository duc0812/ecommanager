import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { loadTask, syncDesignTasks } from '@/lib/design-tasks'
import { toRouteKey } from '@/lib/product-profiles'
import { productArtworkStatus } from '@/lib/artwork-slots'
import { listLibraryProducts, loadLibraryProduct } from '@/lib/repos/artwork-library'

const SHOP = 'tc-a.myshopify.com'
const PROJECT = 'proj_tc_a'
const SUP = 'sup_tc_pg'
const TPL = 'tpl_tc_tumbler'
const P_OVERRIDE = 'gid://shopify/Product/7780001'
const P_PARTIAL = 'gid://shopify/Product/7780002'
const P_UNMAPPED = 'gid://shopify/Product/7780003'
const ORDERS = ['gid://test/Order/tc-1', 'gid://test/Order/tc-2', 'gid://test/Order/tc-3']

let storeId = ''

function line(n: number, productId: string, supplierSku: string | null) {
  return {
    shopifyLineId: `tc-${productId.slice(-1)}-l${n}`, productTitle: 'TC Tumbler', qty: 1, linePosition: n, unitPrice: 1, customized: true,
    sku: `SHOP-${n}`, shopifyProductId: productId, variantOptions: JSON.stringify({ Size: supplierSku?.includes('40') ? '40oz' : '20oz' }),
    ...(supplierSku ? { resolvedSupplierId: SUP, resolvedSupplierSku: supplierSku, resolvedBaseCost: 3 } : {}),
  }
}

function order(id: string, num: string, lines: ReturnType<typeof line>[]) {
  return prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: num, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date(Date.now() - 86400_000),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM', lines: { create: lines },
    },
  })
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: PROJECT, startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.create({ data: { id: SUP, name: 'TC PG', code: 'TCPG' } })
  await prisma.printTemplate.create({ data: {
    id: TPL, supplierId: SUP, supplierSku: 'TC-TEMPLATE-ONLY', name: 'Tumbler 20oz', widthPx: 100, heightPx: 100,
    areas: JSON.stringify([{ name: 'Wrap', x: 0, y: 0, w: 100, h: 100 }]),
  } })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'UT2-20OZ', baseCost: 3, printTemplateId: TPL } })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'TU20-40OZ', baseCost: 4 } })

  await order(ORDERS[0], '#TC1', [line(1, P_OVERRIDE, 'UT2-20OZ'), line(2, P_OVERRIDE, 'UT2-20OZ')])
  await order(ORDERS[1], '#TC2', [line(1, P_PARTIAL, 'UT2-20OZ'), line(2, P_PARTIAL, 'TU20-40OZ')])
  await order(ORDERS[2], '#TC3', [line(1, P_UNMAPPED, null)])
  await prisma.productProfile.create({ data: {
    storeId, shopifyProductId: P_UNMAPPED, title: 'TC Tumbler', masterArtworkUrl: 'https://cdn.example/tc-master.png',
    layerMap: JSON.stringify([{ field: 'Name', layer: 'name_text', fit: 'shrink' }]),
  } })
})

afterAll(async () => {
  await prisma.artworkEntry.deleteMany({ where: { storeId } })
  await prisma.order.deleteMany({ where: { id: { in: ORDERS } } })
  await prisma.productProfile.deleteMany({ where: { storeId } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
})

describe('combined product status (mapping × template × artwork)', () => {
  it('every slot has a template but no artwork yet → EMPTY; a READY entry makes it READY, also on the task pill', async () => {
    expect(await productArtworkStatus(storeId, P_OVERRIDE)).toBe('EMPTY')
    await prisma.artworkEntry.create({ data: { storeId, shopifyProductId: P_OVERRIDE, printTemplateId: TPL, supplierId: SUP, title: 'TC Tumbler', status: 'READY' } })
    expect(await productArtworkStatus(storeId, P_OVERRIDE)).toBe('READY')
    expect((await loadLibraryProduct(toRouteKey(storeId, P_OVERRIDE)))?.status).toBe('READY')

    await syncDesignTasks(ORDERS[0])
    const task = await prisma.designTask.findFirstOrThrow({ where: { orderId: ORDERS[0] } })
    const t = await loadTask(task.taskKey)
    expect(t?.template?.id).toBe(TPL)
    expect(t?.profile).toEqual({ key: toRouteKey(storeId, P_OVERRIDE), status: 'READY', layerMap: [] })
    expect(t?.library).toMatchObject({ status: 'READY', optionKey: '', layers: [] })
  })

  it('a mapped line without a template makes the product NO_TEMPLATE and shows its SKU as its own slot', async () => {
    const detail = await loadLibraryProduct(toRouteKey(storeId, P_PARTIAL))
    expect(detail?.status).toBe('NO_TEMPLATE')
    expect(detail?.slots.map(s => [s.template?.id ?? null, s.supplierSkus, s.title])).toEqual([
      [TPL, ['UT2-20OZ'], 'Size: 20oz'],
      [null, ['TU20-40OZ'], 'Size: 40oz'],
    ])
  })

  it('an unmapped line makes the product NO_MAPPING even when a legacy profile exists', async () => {
    const detail = await loadLibraryProduct(toRouteKey(storeId, P_UNMAPPED))
    expect(detail).toMatchObject({ status: 'NO_MAPPING', unmapped: 1, legacyMasterUrl: 'https://cdn.example/tc-master.png' })
  })

  it('the product list uses the same rule and filters by it', async () => {
    const { products } = await listLibraryProducts({ q: 'tc tumbler' })
    const status = (gid: string) => products.find(p => p.storeId === storeId && p.shopifyProductId === gid)?.status
    expect(status(P_OVERRIDE)).toBe('READY')
    expect(status(P_PARTIAL)).toBe('NO_TEMPLATE')
    expect(status(P_UNMAPPED)).toBe('NO_MAPPING')
    const unmapped = await listLibraryProducts({ q: 'tc tumbler', status: 'NO_MAPPING' })
    expect(unmapped.products.map(p => p.shopifyProductId)).toEqual([P_UNMAPPED])
  })
})
