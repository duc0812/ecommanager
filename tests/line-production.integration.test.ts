import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { signToken, AUTH_COOKIE } from '@/lib/auth'
import { PATCH, GET } from '@/app/api/design-studio/tasks/[key]/production/route'
import { editLineProduction } from '@/lib/repos/line-production'
import { upsertOrderWithLines, listOrdersWithLines, type UpsertOrderInput } from '@/lib/repos/orders'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'
import { loadTask } from '@/lib/design-tasks'
import { applyLineProps, linePersonalization } from '@/lib/design-studio'
import { buildOrdersForCsv } from '@/lib/export-orders'
import { sizeLabel } from '@/lib/sheet-channel'
import { syncStoreOrders } from '@/lib/shopify-order-sync'
import { saveStoreCredential } from '@/lib/store-connections'
import { customNameOf } from '@/lib/custom-name'

const P = 'production-edit-test'
const SUP = `${P}-supplier`
const ORDER = `${P}-order`
const KEY = 'PE6061_1'
const LINE = `${P}-shopify-line`
let storeId = '', adminId = '', adminToken = '', supportToken = ''
const attrs = JSON.stringify([{ key: '_Custom Name:', value: 'Yes' }])
function input(): UpsertOrderInput {
  return { id: ORDER, projectId: P, storeId, shopifyOrderNumber: '#PE6061', customerEmail: null, customerName: null, shippingCountry: 'US', shippingState: null,
    financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', currency: 'USD', grossAmount: 84.98, expectedPayout: 80, totalFees: 4.98, refundedAmount: 0, defaultSupplierId: SUP,
    placedAt: new Date('2026-11-03'), pipelineStatus: 'PENDING_DESIGN', shippingZone: 'US',
    lines: [{ shopifyLineId: LINE, shopifyVariantId: `${P}-variant-S`, sku: 'TN2605261712-Turquoise', variantTitle: 'Turquoise / S / Unisex', variantOptions: JSON.stringify({ Color: 'Turquoise', Size: 'S', Style: 'Unisex' }), productTitle: 'Jeep Girl Hoodie', shopifyProductId: `${P}-product`, qty: 1, unitPrice: 84.98, resolvedSupplierId: SUP, resolvedSupplierSku: 'WZIP-S', resolvedBaseCost: 20, customized: true, customAttributesJson: attrs }],
  }
}
const patch = (extra: Record<string, unknown> = {}, token = adminToken) => new NextRequest(`http://localhost/api/design-studio/tasks/${KEY}/production`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: `${AUTH_COOKIE}=${token}` }, body: JSON.stringify({ supplierProductId: `${P}-L`, customName: 'Marcie', reason: 'Khách yêu cầu Large và tên Marcie', revision: null, ...extra }),
})
async function line() { return prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER, shopifyLineId: LINE } }) }
async function clean() {
  await prisma.order.deleteMany({ where: { id: ORDER } })
  await prisma.variantManualMapping.deleteMany({ where: { shopifyVariantId: `${P}-variant-S` } })
  await prisma.productProfile.deleteMany({ where: { storeId } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
}
beforeAll(async () => {
  process.env.AUTH_SECRET = 'production-test-secret-is-long-enough-for-auth'
  await prisma.project.create({ data: { id: P, name: P, startDate: new Date() } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: `${P}.myshopify.com`, projectId: P, orderPrefix: 'PE' } })).id
  await prisma.supplier.create({ data: { id: SUP, name: 'Mangoshao Test', code: P } })
  const admin = await prisma.appUser.create({ data: { name: 'Production Admin', email: `${P}-admin@test.local`, role: 'ADMIN', permissions: '[]' } })
  adminId = admin.id
  adminToken = await signToken({ userId: admin.id, email: admin.email, name: admin.name, role: 'ADMIN', permissions: [], tv: 0 })
  const support = await prisma.appUser.create({ data: { name: 'Designer', email: `${P}-support@test.local`, role: 'SUPPORT', permissions: '["design_tasks"]' } })
  supportToken = await signToken({ userId: support.id, email: support.email, name: support.name, role: 'SUPPORT', permissions: ['design_tasks'], tv: 0 })
})
beforeEach(async () => {
  await clean()
  for (const size of ['S', 'L']) {
    await prisma.printTemplate.create({ data: { id: `${P}-tpl-${size}`, supplierId: SUP, supplierSku: `WZIP-${size}`, name: `WZIP ${size}`, widthPx: size === 'L' ? 20 : 10, heightPx: 30, areas: JSON.stringify([{ name: 'FRONT', x: 0, y: 0, w: size === 'L' ? 20 : 10, h: 30 }]) } })
    await prisma.supplierProduct.create({ data: { id: `${P}-${size}`, supplierId: SUP, sku: `WZIP-${size}`, baseSku: 'WZIP', productName: 'Fleece Zip', baseCost: size === 'L' ? 22 : 20, variant1Name: 'Size', variant1Value: size, requiresDesign: true, printTemplateId: `${P}-tpl-${size}` } })
  }
  await upsertOrderWithLines(input())
  await prisma.productProfile.create({ data: { storeId, shopifyProductId: `${P}-product`, title: 'Jeep Girl', printTemplateId: `${P}-tpl-S` } })
  await prisma.designTask.create({ data: { taskKey: KEY, orderId: ORDER, shopifyLineId: LINE, status: 'REVIEW', readiness: 'MANUAL' } })
  await prisma.variantManualMapping.create({ data: { shopifyVariantId: `${P}-variant-S`, shopifyProductTitle: 'Jeep Girl', supplierProductId: `${P}-S` } })
})
afterAll(async () => {
  await clean()
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: { startsWith: P } } })
  await prisma.shopifyStore.delete({ where: { id: storeId } })
  await prisma.project.delete({ where: { id: P } })
})

describe('per-line production edits', () => {
  it('saves Large/Marcie with audit and resolves the Large template while preserving the source', async () => {
    const r = await PATCH(patch(), { params: { key: KEY } })
    expect(r.status).toBe(200)
    const view = await r.json()
    expect(view.override.source.variantTitle).toBe('Turquoise / S / Unisex')
    expect(view.override.history[0].byId).toBe(adminId)
    const l = await line()
    expect(l).toMatchObject({ variantTitle: 'Turquoise / L / Unisex', resolvedSupplierSku: 'WZIP-L', resolvedBaseCost: 22 })
    expect(linePersonalization({ ...l, previewCdnUrl: null })).toContainEqual({ key: 'Custom Name', value: 'Marcie' })
    const task = await loadTask(KEY)
    expect(task?.template?.id).toBe(`${P}-tpl-L`)
    expect(task?.task.status).toBe('REVIEW')
    expect(await prisma.designTaskEvent.count({ where: { task: { taskKey: KEY }, message: { contains: 'Marcie' } } })).toBe(1)
  })

  it('keeps the edit after Shopify replaces lines, props refresh and mapping/cost recalculation', async () => {
    await PATCH(patch(), { params: { key: KEY } })
    const before = await line()
    await upsertOrderWithLines(input())
    expect((await line()).id).not.toBe(before.id)
    await applyLineProps(ORDER, [{ sku: 'TN2605261712-Turquoise', title: 'Jeep Girl Hoodie', variantTitle: 'Turquoise / S / Unisex', quantity: 1, productType: 'Hoodie', productUrl: null, customAttributes: [{ key: 'Custom Name', value: 'OLD SHOPIFY NAME' }], imageUrl: null, variantId: `${P}-variant-S` }])
    await recalculateMissingOrderLineCosts({ orderIds: [ORDER], refreshExisting: true })
    const after = await line()
    expect(after).toMatchObject({ variantTitle: 'Turquoise / L / Unisex', resolvedSupplierSku: 'WZIP-L', resolvedBaseCost: 22, productionOverrideJson: before.productionOverrideJson })
    expect(JSON.parse(after.customAttributesJson!)).toContainEqual({ key: 'Custom Name', value: 'Marcie' })
    expect(JSON.parse(after.customAttributesJson!).some((a: any) => a.value === 'OLD SHOPIFY NAME')).toBe(false)
    const orders = await listOrdersWithLines({ ids: [ORDER] })
    const csv = await buildOrdersForCsv({ orders, supplierId: SUP, columns: [{ source: 'line.supplierSku' }], perOrder: false, linesOf: o => o.lines })
    const out = csv.ordersForCsv[0].lines[0]
    expect(out.supplierSku).toBe('WZIP-L')
    expect(sizeLabel(out.supplierVariant1Value, out.variantTitle)).toBe('L')
    expect(customNameOf(linePersonalization(after))).toBe('Marcie')
  })

  it('applies the override before the real Shopify sync classifies and resolves the incoming original S line', async () => {
    await PATCH(patch(), { params: { key: KEY } })
    await saveStoreCredential(storeId, { authMode: 'TOKEN', accessToken: 'test-only-token' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {
      shop: { ianaTimezone: 'America/Los_Angeles', timezoneAbbreviation: 'PST' },
      orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: ORDER, name: '#PE6061', createdAt: '2026-11-03T12:00:00Z', processedAt: '2026-11-03T12:00:00Z', cancelledAt: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', currencyCode: 'USD',
        currentTotalPriceSet: { shopMoney: { amount: '84.98' } }, currentSubtotalPriceSet: { shopMoney: { amount: '84.98' } }, currentTotalTaxSet: { shopMoney: { amount: '0' } }, currentShippingPriceSet: { shopMoney: { amount: '0' } }, taxLines: [],
        lineItems: { nodes: [{ id: LINE, sku: 'TN2605261712-Turquoise', title: 'Jeep Girl Hoodie', variantTitle: 'Turquoise / S / Unisex', quantity: 1, originalUnitPriceSet: { shopMoney: { amount: '84.98' } }, customAttributes: [{ key: 'Custom Name', value: 'No' }], product: { id: `${P}-product`, tags: [], productType: 'Hoodie' }, variant: { id: `${P}-variant-S`, selectedOptions: [{ name: 'Color', value: 'Turquoise' }, { name: 'Size', value: 'S' }, { name: 'Style', value: 'Unisex' }] } }] }, transactions: [], refunds: [],
      }] },
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    try {
      const result = await syncStoreOrders(storeId)
      expect(result.errors).toEqual([])
      const current = await line()
      expect(current).toMatchObject({ resolvedSupplierSku: 'WZIP-L', variantTitle: 'Turquoise / L / Unisex', customized: true, designDriveLink: null })
      expect(customNameOf(linePersonalization(current))).toBe('Marcie')
      expect(await prisma.order.findUniqueOrThrow({ where: { id: ORDER } })).toMatchObject({ designReady: false, orderType: 'CUSTOM', pipelineStatus: 'PENDING_DESIGN' })
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps sibling lines and global variant mappings unchanged', async () => {
    await prisma.orderLine.create({ data: { orderId: ORDER, shopifyLineId: `${LINE}-sibling`, sku: 'TN2605261712-Turquoise', productTitle: 'Jeep Girl Hoodie', variantTitle: 'Turquoise / S / Unisex', qty: 1, unitPrice: 84.98, resolvedSupplierId: SUP, resolvedSupplierSku: 'WZIP-S' } })
    await PATCH(patch(), { params: { key: KEY } })
    expect(await prisma.orderLine.findFirstOrThrow({ where: { shopifyLineId: `${LINE}-sibling` } })).toMatchObject({ resolvedSupplierSku: 'WZIP-S', productionOverrideJson: null })
    expect(await prisma.variantManualMapping.findUniqueOrThrow({ where: { shopifyVariantId: `${P}-variant-S` } })).toMatchObject({ supplierProductId: `${P}-S` })
  })

  it('rejects non-admin writes and stale revisions', async () => {
    expect((await PATCH(patch({}, supportToken), { params: { key: KEY } })).status).toBe(403)
    expect((await GET(new NextRequest(`http://localhost/api/design-studio/tasks/${KEY}/production`), { params: { key: KEY } })).status).toBe(401)
    await PATCH(patch(), { params: { key: KEY } })
    expect((await PATCH(patch(), { params: { key: KEY } })).status).toBe(409)
  })

  it('refuses a different product/color and leaves approved or exported lines unchanged', async () => {
    await prisma.supplierProduct.create({ data: { id: `${P}-wrong`, supplierId: SUP, sku: 'OTHER-L', productName: 'Other', baseCost: 30, variant1Value: 'L' } })
    expect((await PATCH(patch({ supplierProductId: `${P}-wrong` }), { params: { key: KEY } })).status).toBe(400)
    await prisma.designTask.update({ where: { taskKey: KEY }, data: { status: 'DONE' } })
    expect((await PATCH(patch(), { params: { key: KEY } })).status).toBe(409)
    expect((await line()).resolvedSupplierSku).toBe('WZIP-S')
    await prisma.designTask.update({ where: { taskKey: KEY }, data: { status: 'REVIEW' } })
    await prisma.orderLine.updateMany({ where: { orderId: ORDER }, data: { exportedAt: new Date(), exportedToSupplierId: SUP } })
    await expect(editLineProduction(KEY, { supplierProductId: `${P}-L`, customName: 'Marcie', reason: 'Customer', revision: null }, { id: adminId, name: 'Admin' })).rejects.toMatchObject({ status: 409 })
  })
})
