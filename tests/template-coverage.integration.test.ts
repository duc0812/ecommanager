import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { effectiveTemplateCoverage, loadTask, syncDesignTasks } from '@/lib/design-tasks'
import { toRouteKey } from '@/lib/product-profiles'
import { listProducts, loadProduct } from '@/lib/repos/product-profiles'

const SHOP = 'tc-a.myshopify.com'
const PROJECT = 'proj_tc_a'
const SUP = 'sup_tc_pg'
const TPL = 'tpl_tc_tumbler'
const MASTER = 'https://cdn.example/tc-master.png'
const P_OVERRIDE = 'gid://shopify/Product/7780001'
const P_PARTIAL = 'gid://shopify/Product/7780002'
const P_UNMAPPED = 'gid://shopify/Product/7780003'
const ORDERS = ['gid://test/Order/tc-1', 'gid://test/Order/tc-2', 'gid://test/Order/tc-3']

let storeId = ''

function line(n: number, productId: string, supplierSku: string | null) {
  return {
    shopifyLineId: `tc-${productId.slice(-1)}-l${n}`, productTitle: 'TC Tumbler', qty: 1, linePosition: n, unitPrice: 1, customized: true,
    sku: `SHOP-${n}`, shopifyProductId: productId,
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
  const withTpl = await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'UT2-20OZ', baseCost: 3, printTemplateId: TPL } })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'TU20-40OZ', baseCost: 4 } })

  await order(ORDERS[0], '#TC1', [line(1, P_OVERRIDE, 'UT2-20OZ'), line(2, P_OVERRIDE, 'UT2-20OZ')])
  await order(ORDERS[1], '#TC2', [line(1, P_PARTIAL, 'UT2-20OZ'), line(2, P_PARTIAL, 'TU20-40OZ')])
  await order(ORDERS[2], '#TC3', [line(1, P_UNMAPPED, null)])

  const base = { storeId, title: 'TC Tumbler', masterArtworkUrl: MASTER }
  await prisma.productProfile.create({ data: {
    ...base, shopifyProductId: P_OVERRIDE, overrides: JSON.stringify([{ combo: { Size: '20oz' }, supplierProductId: withTpl.id }]),
  } })
  await prisma.productProfile.create({ data: { ...base, shopifyProductId: P_PARTIAL } })
  await prisma.productProfile.create({ data: { ...base, shopifyProductId: P_UNMAPPED, printTemplateId: TPL } })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: ORDERS } } })
  await prisma.productProfile.deleteMany({ where: { storeId } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
})

describe('profile template coverage', () => {
  it('an override-only profile whose supplier product has a template is not NO_TEMPLATE', async () => {
    expect(await effectiveTemplateCoverage(storeId, P_OVERRIDE)).toEqual({ covered: 2, total: 2, missingSkus: [] })
    const detail = await loadProduct(toRouteKey(storeId, P_OVERRIDE))
    expect(detail?.status).toBe('READY')
    expect(detail?.templateCoverage).toEqual({ covered: 2, total: 2, missingSkus: [] })

    await syncDesignTasks(ORDERS[0])
    const task = await prisma.designTask.findFirstOrThrow({ where: { orderId: ORDERS[0] } })
    const t = await loadTask(task.taskKey)
    expect(t?.template?.id).toBe(TPL)
    expect(t?.profile?.status).toBe('READY')
  })

  it('a product where some mapped lines lack a template is NO_TEMPLATE and lists the SKUs', async () => {
    expect(await effectiveTemplateCoverage(storeId, P_PARTIAL)).toEqual({ covered: 1, total: 2, missingSkus: ['TU20-40OZ'] })
    const detail = await loadProduct(toRouteKey(storeId, P_PARTIAL))
    expect(detail?.status).toBe('NO_TEMPLATE')
    expect(detail?.templateCoverage.missingSkus).toEqual(['TU20-40OZ'])
  })

  it('with no mapped lines the profile template satisfies the rule', async () => {
    expect(await effectiveTemplateCoverage(storeId, P_UNMAPPED)).toEqual({ covered: 0, total: 0, missingSkus: [] })
    expect((await loadProduct(toRouteKey(storeId, P_UNMAPPED)))?.status).toBe('READY')
  })

  it('the product list uses the same rule', async () => {
    const { products } = await listProducts({ q: 'tc tumbler' })
    const status = (gid: string) => products.find(p => p.storeId === storeId && p.shopifyProductId === gid)?.status
    expect(status(P_OVERRIDE)).toBe('READY')
    expect(status(P_PARTIAL)).toBe('NO_TEMPLATE')
    expect(status(P_UNMAPPED)).toBe('READY')
  })
})
