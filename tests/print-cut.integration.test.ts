import { beforeAll, afterAll, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { POST } from '@/app/api/fulfillment/suppliers/[id]/print-templates/route'
import { loadTask, requiredSlotsForLine, uploadSlotsForLine, syncDesignTasks, transitionTask, type Actor } from '@/lib/design-tasks'
import { loadTemplateContext, pickTemplate } from '@/lib/print-template-resolve'
import { collectLineFiles } from '@/lib/repos/supplier-push-core'
import { buildOrdersForCsv } from '@/lib/export-orders'
import { listOrdersWithLines } from '@/lib/repos/orders'
import { PRINT_CUT_SIZING } from '@/lib/print-cut'

const id = 'print-cut-integration'
let actor: Actor
let cookie: string
let templateId: string
beforeAll(async () => {
  process.env.AUTH_SECRET = 'print-cut-integration-test'
  const user = await prisma.appUser.create({ data: { id, name: 'Pair admin', email: 'pair@print-cut.test', role: 'SUPERADMIN' } })
  actor = { id: user.id, name: user.name, role: user.role }
  cookie = await signToken({ userId: user.id, email: user.email, name: user.name, role: 'SUPERADMIN', permissions: [] })
  await prisma.project.create({ data: { id, name: 'Print/cut', startDate: new Date() } })
  await prisma.shopifyStore.create({ data: { id, shop: 'pair-print-cut.myshopify.com', projectId: id } })
  await prisma.supplier.create({ data: { id, name: 'Pair supplier', code: id } })
  await prisma.supplierProduct.create({ data: { id, supplierId: id, sku: '6-IN', productName: 'Tree Topper', baseCost: 10 } })
  await prisma.order.create({ data: {
    id, projectId: id, storeId: id, shopifyOrderNumber: '#PAIR9001', placedAt: new Date(), financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
    lines: { create: { id, shopifyLineId: id, productTitle: 'Tree Topper', customized: true, qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: id, resolvedSupplierSku: '6-IN' } },
  } })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id } })
  await prisma.supplier.deleteMany({ where: { id } })
  await prisma.shopifyStore.deleteMany({ where: { id } })
  await prisma.project.deleteMany({ where: { id } })
  await prisma.appUser.deleteMany({ where: { id } })
})
async function art(area: string, w: number, h: number, version = 1) {
  return prisma.designArtwork.create({ data: {
    orderId: id, shopifyLineId: id, printArea: area, version, widthPx: w, heightPx: h,
    fileName: `${area}.png`, storagePath: `${id}/${area}${version}.png`, size: 1, mimeType: 'image/png',
  } })
}

it('creates and resolves two API-configured print/cut slots', async () => {
  const req = new NextRequest('http://localhost/api/fulfillment/suppliers/pair/print-templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    name: 'Topper — print/cut', widthPx: 2000, heightPx: 1000, dpi: 300, bleedIn: 0, safeIn: 0,
    areas: ['Print', 'Cut'].map((name, i) => ({ name, x: i * 1000, y: 0, w: 1000, h: 1000, sizing: PRINT_CUT_SIZING })),
    supplierProductIds: [id],
  }) })
  req.cookies.set(AUTH_COOKIE, cookie)
  const response = await POST(req, { params: { id } })
  expect(response.status).toBe(201)
  templateId = (await response.json()).template.id
  await syncDesignTasks(id)
  const detail = await loadTask('PAIR9001_1')
  expect(detail?.template?.id).toBe(templateId)
  expect(detail?.slots).toEqual(['Print', 'Cut'])
  expect(detail?.template?.areas.every(a => a.sizing === PRINT_CUT_SIZING)).toBe(true)
})

it('resolves the Topper preset before supplier mapping and exposes the same upload slots', async () => {
  const empty = { byId: new Map(), bySupplier: new Map(), productTemplate: new Map() }
  const line = { orderId: id, resolvedSupplierId: null, resolvedSupplierSku: null, shopifyProductType: 'Tree Topper' }
  expect(pickTemplate(line, null, empty)?.areas.map(a => a.name)).toEqual(['Print', 'Cut'])
  await prisma.orderLine.update({ where: { id }, data: { shopifyProductType: 'Tree Topper', resolvedSupplierId: null, resolvedSupplierSku: null } })
  try {
    expect((await loadTask('PAIR9001_1'))?.slots).toEqual(['Print', 'Cut'])
    expect(await requiredSlotsForLine(id, id)).toEqual(['Print', 'Cut'])
    expect(await uploadSlotsForLine(id, id)).toEqual(['Print', 'Cut'])
  } finally {
    await prisma.orderLine.update({ where: { id }, data: { resolvedSupplierId: id, resolvedSupplierSku: '6-IN' } })
  }
})

it('loads the supplier identity and limits the automatic preset to Gỗ 3D VN', async () => {
  const supplier = await prisma.supplier.create({ data: { id: `${id}-go3d`, name: 'Gỗ 3D VN', code: '3' } })
  try {
    const line = { orderId: id, resolvedSupplierId: supplier.id, resolvedSupplierSku: 'TOPPER-6IN', shopifyProductType: 'Tree Topper' }
    const ctx = await loadTemplateContext([line], [])
    expect(pickTemplate(line, null, ctx)?.name).toContain('Gỗ 3D VN')
    const anotherSupplier = { ...ctx, supplierCodes: new Map([[supplier.id, 'BONDRE']]) }
    expect(pickTemplate(line, null, anotherSupplier)).toBeNull()
    expect(pickTemplate(line, null, { ...ctx, supplierCodes: new Map() })).toBeNull()
  } finally {
    await prisma.supplier.delete({ where: { id: supplier.id } })
  }
})

it('blocks missing or mismatched pairs, even with approval overrides', async () => {
  await transitionTask('PAIR9001_1', actor, { to: 'DOING' })
  await art('Print', 731, 1254)
  await expect(transitionTask('PAIR9001_1', actor, { to: 'REVIEW', continue: true })).rejects.toThrow('Thiếu file: Cut')
  await art('Cut', 732, 1254)
  await expect(transitionTask('PAIR9001_1', actor, { to: 'REVIEW' })).rejects.toThrow('lệch khổ')
  await art('Cut', 731, 1254, 2)
  expect((await transitionTask('PAIR9001_1', actor, { to: 'REVIEW' })).task.status).toBe('REVIEW')
  await art('Print', 500, 500, 2)
  await expect(transitionTask('PAIR9001_1', actor, { to: 'DONE', acceptMissingAreas: true })).rejects.toThrow('lệch khổ')
  expect((await loadTask('PAIR9001_1'))?.task.status).toBe('REVIEW')
})

it('rechecks the pair before supplier API handoff and accepts a corrected pair', async () => {
  const line = (await prisma.orderLine.findUniqueOrThrow({ where: { id } }))
  const errors: string[] = []
  const collect = async () => collectLineFiles(line, await prisma.designArtwork.findMany({ where: { orderId: id } }),
    { refId: 'PAIR9001_1', approved: false, baseUrl: null, supplierName: 'Pair supplier' },
    { error: code => errors.push(code), warning: () => {} })
  await collect()
  expect(errors).toContain('PRINT_CUT_MISMATCH')
  errors.length = 0
  await art('Cut', 500, 500, 3)
  const result = await collect()
  expect(errors).not.toContain('PRINT_CUT_MISMATCH')
  expect(result.files.map(f => f.expectedWidthPx)).toEqual([null, null])
  expect((await transitionTask('PAIR9001_1', actor, { to: 'DONE' })).task.status).toBe('DONE')
})

it('blocks a replacement mismatch after approval on CSV/sheet exports, even without a design column', async () => {
  await art('Print', 400, 500, 3)
  const orders = await listOrdersWithLines({ ids: [id] })
  const build = () => buildOrdersForCsv({ orders, supplierId: id, columns: [{ source: 'order.shopifyOrderNumber' }], perOrder: true, linesOf: o => o.lines })
  const blocked = await build()
  expect(blocked.ordersForCsv).toEqual([])
  expect(blocked.problems[0].reason).toContain('lệch khổ')
  await art('Cut', 400, 500, 4)
  expect((await build()).problems).toEqual([])
})
