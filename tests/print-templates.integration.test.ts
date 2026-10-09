import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { templateForLine } from '@/lib/design-tasks'
import { GET as listRoute, POST as createRoute } from '@/app/api/fulfillment/suppliers/[id]/print-templates/route'
import { PATCH as patchRoute, DELETE as deleteRoute } from '@/app/api/fulfillment/suppliers/[id]/print-templates/[templateId]/route'
import { GET as sourceRoute } from '@/app/api/fulfillment/suppliers/[id]/print-templates/[templateId]/source/route'
import { PATCH as linkRoute } from '@/app/api/fulfillment/suppliers/[id]/products/print-template/route'
import { GET as guideRoute } from '@/app/api/design-studio/file/guide/[templateId]/route'

const SUP = 'sup_ptpl'
const SUP_OTHER = 'sup_ptpl_other'
const SP_20 = 'sp_ptpl_20'
const SP_30 = 'sp_ptpl_30'
const SP_OTHER = 'sp_ptpl_other'
const TPL_SKU = 'tpl_ptpl_sku'
const TPL_LINKED = 'tpl_ptpl_linked'
const TPL_PROFILE = 'tpl_ptpl_profile'
const TPL_OTHER = 'tpl_ptpl_other'
const OPEN_ID = 'gid://test/Order/ptpl-open'
const EXPORTED_ID = 'gid://test/Order/ptpl-exported'
const SHOP = 'ptpl.myshopify.com'
const EMAILS = ['admin@ptpl.test', 'support@ptpl.test']
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('guide')])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptpl-storage-'))

let adminToken = ''
let supportToken = ''
let storeId = ''

function req(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

const base = `http://localhost/api/fulfillment/suppliers/${SUP}`

function multipart(fields: Record<string, string>, files: Record<string, { name: string; bytes: Buffer }> = {}) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  for (const [k, f] of Object.entries(files)) form.append(k, new File([new Uint8Array(f.bytes)], f.name))
  return form
}

function create(form: FormData, token = adminToken) {
  return createRoute(req(`${base}/print-templates`, token, { method: 'POST', body: form }), { params: { id: SUP } })
}

function link(body: unknown, token = adminToken) {
  return linkRoute(
    req(`${base}/products/print-template`, token, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    { params: { id: SUP } },
  )
}

function order(id: string, num: string, pipelineStatus: string) {
  return prisma.order.create({
    data: {
      id, projectId: 'proj_ptpl', storeId, shopifyOrderNumber: num, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date(Date.now() - 86400_000),
      pipelineStatus, orderType: 'CUSTOM',
      lines: { create: [{ shopifyLineId: `${num}-l1`, sku: 'SHOP-30', productTitle: 'Tumbler', qty: 1, linePosition: 1, unitPrice: 1, customized: true,
        resolvedSupplierId: SUP, resolvedSupplierSku: 'PT-30OZ', resolvedBaseCost: 1 }] },
    },
  })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: 'proj_ptpl' }, create: { id: 'proj_ptpl', name: 'PTPL', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ptpl' }, update: {} })).id
  await prisma.supplier.create({ data: { id: SUP, name: 'PT Supplier', code: 'PTPLSUP' } })
  await prisma.supplier.create({ data: { id: SUP_OTHER, name: 'PT Other', code: 'PTPLOTHER' } })
  await prisma.supplierProduct.create({ data: { id: SP_20, supplierId: SUP, sku: 'PT-20OZ', productName: 'Tumbler 20Oz', variant1Name: 'Size', variant1Value: '20oz', baseCost: 5 } })
  await prisma.supplierProduct.create({ data: { id: SP_30, supplierId: SUP, sku: 'PT-30OZ', productName: 'Tumbler 30Oz', variant1Name: 'Size', variant1Value: '30oz', baseCost: 6 } })
  await prisma.supplierProduct.create({ data: { id: SP_OTHER, supplierId: SUP_OTHER, sku: 'PT-20OZ', baseCost: 5 } })
  const tpl = { widthPx: 100, heightPx: 100, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 100, h: 100 }]) }
  await prisma.printTemplate.create({ data: { id: TPL_SKU, supplierId: SUP, supplierSku: 'PT-20OZ', name: 'By SKU', ...tpl } })
  await prisma.printTemplate.create({ data: { id: TPL_LINKED, supplierId: SUP, name: 'Linked', ...tpl } })
  await prisma.printTemplate.create({ data: { id: TPL_PROFILE, supplierId: SUP, name: 'Profile', ...tpl } })
  await prisma.printTemplate.create({ data: { id: TPL_OTHER, supplierId: SUP_OTHER, name: 'Other', ...tpl } })
  await order(OPEN_ID, '#PTPL1', 'PENDING_DESIGN')
  await order(EXPORTED_ID, '#PTPL2', 'EXPORTED')

  const admin = await prisma.appUser.upsert({ where: { email: EMAILS[0] }, create: { name: 'Admin', email: EMAILS[0], role: 'ADMIN' }, update: {} })
  const support = await prisma.appUser.upsert({ where: { email: EMAILS[1] }, create: { name: 'Support', email: EMAILS[1], role: 'SUPPORT' }, update: {} })
  adminToken = await signToken({ userId: admin.id, email: EMAILS[0], name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
  supportToken = await signToken({ userId: support.id, email: EMAILS[1], name: 'Support', role: 'SUPPORT', permissions: [], tv: 0 })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: [OPEN_ID, EXPORTED_ID] } } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP, SUP_OTHER] } } })
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
  await prisma.project.deleteMany({ where: { id: 'proj_ptpl' } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('templateForLine with a template linked on the supplier product', () => {
  const line = { orderId: OPEN_ID, shopifyProductId: null, resolvedSupplierId: SUP, resolvedSupplierSku: 'PT-20OZ' }

  it('falls back to the supplier-SKU template when the variant has no linked template', async () => {
    expect((await templateForLine(line, null))?.id).toBe(TPL_SKU)
  })

  it('the linked template beats the supplier-SKU match', async () => {
    await prisma.supplierProduct.update({ where: { id: SP_20 }, data: { printTemplateId: TPL_LINKED } })
    expect((await templateForLine(line, null))?.id).toBe(TPL_LINKED)
  })

  it('a profile template of the same supplier beats the linked template', async () => {
    expect((await templateForLine(line, { printTemplateId: TPL_PROFILE }))?.id).toBe(TPL_PROFILE)
  })

  it('a profile template of another supplier is skipped in favour of the linked one', async () => {
    expect((await templateForLine(line, { printTemplateId: TPL_OTHER }))?.id).toBe(TPL_LINKED)
    await prisma.supplierProduct.update({ where: { id: SP_20 }, data: { printTemplateId: null } })
  })
})

describe('supplier print template routes', () => {
  let createdId = ''

  it('rejects a non-admin create with 403', async () => {
    const res = await create(multipart({ name: 'X', widthPx: '100', heightPx: '100' }), supportToken)
    expect(res.status).toBe(403)
  })

  it.each([
    ['zero width', { name: 'X', widthPx: '0', heightPx: '100' }],
    ['missing name', { widthPx: '100', heightPx: '100' }],
    ['area outside the canvas', { name: 'X', widthPx: '100', heightPx: '100', areas: JSON.stringify([{ name: 'A', x: 50, y: 0, w: 60, h: 10 }]) }],
    ['empty areas', { name: 'X', widthPx: '100', heightPx: '100', areas: '[]' }],
    ['area without a name', { name: 'X', widthPx: '100', heightPx: '100', areas: JSON.stringify([{ x: 0, y: 0, w: 10, h: 10 }]) }],
  ])('400 for %s', async (_label, fields) => {
    const res = await create(multipart(fields as Record<string, string>))
    expect(res.status).toBe(400)
  })

  it('400 for a guide that is not PNG/JPG and leaves no row behind', async () => {
    const before = await prisma.printTemplate.count({ where: { supplierId: SUP } })
    const res = await create(multipart({ name: 'Bad guide', widthPx: '100', heightPx: '100' }, { guide: { name: 'g.png', bytes: Buffer.from('nope') } }))
    expect(res.status).toBe(400)
    expect(await prisma.printTemplate.count({ where: { supplierId: SUP } })).toBe(before)
  })

  it('creates a template with a default area, guide, source file and linked variants', async () => {
    const res = await create(multipart(
      { name: 'Tumbler 30oz', widthPx: '3270', heightPx: '1860', dpi: '300', bleedIn: '0', safeIn: '0.19', mirror: 'false', supplierProductIds: JSON.stringify([SP_30]) },
      { guide: { name: 'guide.png', bytes: PNG }, source: { name: 'Template 30oz.tif', bytes: Buffer.from('tif-bytes') } },
    ))
    expect(res.status).toBe(201)
    const body = await res.json()
    createdId = body.template.id
    expect(body.template).toMatchObject({
      name: 'Tumbler 30oz', widthPx: 3270, heightPx: 1860, bleedIn: 0, safeIn: 0.19, mirror: false,
      areas: [{ name: 'Print', x: 0, y: 0, w: 3270, h: 1860 }], sourceFileName: 'Template_30oz.tif', supplierProductIds: [SP_30],
    })
    expect(body.tasksTouched).toBe(1)
    const row = await prisma.printTemplate.findUniqueOrThrow({ where: { id: createdId } })
    expect(row.guideImagePath).toBe(`templates/${createdId}/guide.png`)
    expect(row.sourceFilePath).toBe(`templates/${createdId}/source.tif`)
    expect(fs.readFileSync(path.join(tmp, row.guideImagePath!))).toEqual(PNG)
    expect(await prisma.designTask.count({ where: { orderId: OPEN_ID } })).toBe(1)
    expect(await prisma.designTask.count({ where: { orderId: EXPORTED_ID } })).toBe(0)
  })

  it('serves the guide from the new location and the source as an attachment', async () => {
    const g = await guideRoute(req(`http://localhost/api/design-studio/file/guide/${createdId}`, null), { params: { templateId: createdId } })
    expect(g.status).toBe(200)
    expect(g.headers.get('Content-Type')).toBe('image/png')
    const s = await sourceRoute(req(`${base}/print-templates/${createdId}/source`, adminToken), { params: { id: SUP, templateId: createdId } })
    expect(s.status).toBe(200)
    expect(s.headers.get('Content-Disposition')).toContain('attachment')
    expect(s.headers.get('Content-Type')).toBe('image/tiff')
    expect(await s.text()).toBe('tif-bytes')
    const wrong = await sourceRoute(req(`http://x/source`, adminToken), { params: { id: SUP_OTHER, templateId: createdId } })
    expect(wrong.status).toBe(404)
  })

  it('lists the supplier templates with linked variants', async () => {
    const res = await listRoute(req(`${base}/print-templates`, adminToken), { params: { id: SUP } })
    const body = await res.json()
    const row = body.templates.find((t: any) => t.id === createdId)
    expect(row.supplierProductIds).toEqual([SP_30])
    expect(row.guideImageUrl).toMatch(new RegExp(`^/api/design-studio/file/guide/${createdId}\\?v=\\d+$`))
    expect(body.templates.some((t: any) => t.id === TPL_OTHER)).toBe(false)
  })

  it('PATCH with JSON keeps omitted fields and validates areas against the new size', async () => {
    const patch = (body: unknown) => patchRoute(
      req(`${base}/print-templates/${createdId}`, adminToken, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { params: { id: SUP, templateId: createdId } },
    )
    expect((await patch({ widthPx: 1000 })).status).toBe(400)
    const res = await patch({ name: 'Tumbler 30oz v2', widthPx: 1000, areas: [{ name: 'Wrap', x: 0, y: 0, w: 1000, h: 1860 }], supplierProductIds: [SP_30, SP_20] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.template).toMatchObject({ name: 'Tumbler 30oz v2', widthPx: 1000, heightPx: 1860, safeIn: 0.19, sourceFileName: 'Template_30oz.tif' })
    expect(body.template.supplierProductIds.sort()).toEqual([SP_20, SP_30].sort())
    expect((await patch({ supplierProductIds: [SP_OTHER] })).status).toBe(400)
  })

  it('link route assigns and unassigns many variants, refusing other suppliers', async () => {
    expect((await link({ supplierProductIds: [SP_OTHER], printTemplateId: TPL_LINKED })).status).toBe(400)
    expect((await link({ supplierProductIds: [SP_20], printTemplateId: TPL_OTHER })).status).toBe(400)
    expect((await link({ supplierProductIds: [SP_20], printTemplateId: TPL_LINKED }, supportToken)).status).toBe(403)
    const res = await link({ supplierProductIds: [SP_20, SP_30], printTemplateId: TPL_LINKED })
    expect(res.status).toBe(200)
    expect((await res.json()).updated).toBe(2)
    expect((await templateForLine({ orderId: OPEN_ID, resolvedSupplierId: SUP, resolvedSupplierSku: 'PT-30OZ' }, null))?.id).toBe(TPL_LINKED)
    await link({ supplierProductIds: [SP_30], printTemplateId: null })
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { id: SP_30 } })).printTemplateId).toBeNull()
  })

  it('DELETE removes the template and its files and unlinks variants', async () => {
    await link({ supplierProductIds: [SP_30], printTemplateId: createdId })
    const res = await deleteRoute(req(`${base}/print-templates/${createdId}`, adminToken, { method: 'DELETE' }), { params: { id: SUP, templateId: createdId } })
    expect(res.status).toBe(200)
    expect(await prisma.printTemplate.findUnique({ where: { id: createdId } })).toBeNull()
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { id: SP_30 } })).printTemplateId).toBeNull()
    expect(fs.existsSync(path.join(tmp, 'templates', createdId))).toBe(false)
  })
})
