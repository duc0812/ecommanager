import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { loadTask, syncDesignTasks, templateForLine } from '@/lib/design-tasks'
import { profileKey } from '@/lib/product-mapping'
import { toRouteKey } from '@/lib/product-profiles'
import { loadProductProfilesForResolver } from '@/lib/repos/mapping'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'
import { GET as listRoute } from '@/app/api/design-studio/products/route'
import { GET as getRoute, PUT as putRoute } from '@/app/api/design-studio/products/[key]/route'

const SHOP_A = 'pp-a.myshopify.com'
const SHOP_B = 'pp-b.myshopify.com'
const GID = 'gid://shopify/Product/7770001'
const OTHER_GID = 'gid://shopify/Product/7770002'
const OPEN_ID = 'gid://test/Order/pp-open'
const HELD_ID = 'gid://test/Order/pp-held'
const EXPORTED_ID = 'gid://test/Order/pp-exported'
const OTHER_STORE_ID = 'gid://test/Order/pp-store-b'
const NO_PID_ID = 'gid://test/Order/pp-no-pid'
const SUP_A = 'sup_pp_a'
const SUP_B = 'sup_pp_b'
const SUP_OFF = 'sup_pp_off'
const SP_OLD = 'sp_pp_old'
const SP_NEW = 'sp_pp_new'
const SP_OFF = 'sp_pp_off'
const TPL_SKU = 'tpl_pp_sku'
const TPL_PROFILE = 'tpl_pp_profile'
const TPL_A = 'tpl_pp_a'
const MASTER = 'https://cdn.example/pp-master.png'
const EMAILS = ['admin@pp.test', 'support@pp.test']
const SNAPSHOT_AT = new Date('2026-09-01T00:00:00Z')

let storeA = ''
let storeB = ''
let key = ''
let adminToken = ''
let supportToken = ''

function req(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

function put(body: unknown, token = adminToken, k = key) {
  return putRoute(
    req(`http://localhost/api/design-studio/products/${k}`, token, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    { params: { key: k } },
  )
}

const ATTRS = JSON.stringify([{ key: 'Name', value: 'Ann' }])

function order(id: string, storeId: string, projectId: string, num: string, pipelineStatus: string, line: Record<string, unknown>, extra: Record<string, unknown>[] = []) {
  return prisma.order.create({
    data: {
      id, projectId, storeId, shopifyOrderNumber: num, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date(Date.now() - 86400_000),
      pipelineStatus, orderType: 'CUSTOM',
      lines: { create: [
        { shopifyLineId: `${num}-l1`, productTitle: 'PP Hoodie', qty: 1, linePosition: 1, unitPrice: 1, customized: true, ...line },
        ...extra.map((e, i) => ({ shopifyLineId: `${num}-x${i + 2}`, productTitle: 'PP Other', qty: 1, linePosition: i + 2, unitPrice: 1, ...e })),
      ] },
    },
  })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  for (const id of ['proj_pp_a', 'proj_pp_b']) {
    await prisma.project.upsert({ where: { id }, create: { id, name: id, startDate: new Date('2026-06-01') }, update: {} })
  }
  storeA = (await prisma.shopifyStore.upsert({ where: { shop: SHOP_A }, create: { shop: SHOP_A, projectId: 'proj_pp_a' }, update: {} })).id
  storeB = (await prisma.shopifyStore.upsert({ where: { shop: SHOP_B }, create: { shop: SHOP_B, projectId: 'proj_pp_b' }, update: {} })).id
  key = toRouteKey(storeA, GID)

  await prisma.supplier.create({ data: { id: SUP_A, name: 'PP A', code: 'PPSUPA' } })
  await prisma.supplier.create({ data: { id: SUP_B, name: 'PP B', code: 'PPSUPB' } })
  await prisma.supplier.create({ data: { id: SUP_OFF, name: 'PP Off', code: 'PPSUPOFF', isActive: false } })
  await prisma.supplierProduct.create({ data: { id: SP_OLD, supplierId: SUP_A, sku: 'PP-OLD', baseCost: 5 } })
  await prisma.supplierProduct.create({ data: { id: SP_NEW, supplierId: SUP_B, sku: 'PP-NEW', baseCost: 9 } })
  await prisma.supplierProduct.create({ data: { id: SP_OFF, supplierId: SUP_OFF, sku: 'PP-OFF', baseCost: 1 } })
  const tpl = { widthPx: 100, heightPx: 100, areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 100, h: 100 }]) }
  await prisma.printTemplate.create({ data: { id: TPL_SKU, supplierId: SUP_B, supplierSku: 'PP-NEW', name: 'By SKU', ...tpl } })
  await prisma.printTemplate.create({ data: { id: TPL_PROFILE, supplierId: SUP_B, supplierSku: 'PP-PROFILE', name: 'By profile', ...tpl } })
  await prisma.printTemplate.create({ data: { id: TPL_A, supplierId: SUP_A, supplierSku: 'PP-A', name: 'Supplier A', ...tpl } })
  await prisma.skuDesign.create({ data: { sku: 'PP-SHOP-SKU', driveLink: 'https://drive.example/sku-master' } })

  const resolvedOld = { resolvedSupplierId: SUP_A, resolvedSupplierSku: 'PP-OLD', resolvedBaseCost: 5, costSnapshotAt: SNAPSHOT_AT }
  await order(OPEN_ID, storeA, 'proj_pp_a', '#PP1', 'PENDING_DESIGN', { sku: 'PP-SHOP-SKU', shopifyProductId: GID, customAttributesJson: ATTRS, ...resolvedOld },
    [{ sku: 'PP-OTHER', shopifyProductId: OTHER_GID, ...resolvedOld }])
  await order(HELD_ID, storeA, 'proj_pp_a', '#PP5', 'ON_HOLD', {
    sku: 'PP-SHOP-SKU', shopifyProductId: GID, customAttributesJson: ATTRS,
    resolvedSupplierId: SUP_B, resolvedSupplierSku: 'PP-NEW', resolvedBaseCost: 7, costSnapshotAt: SNAPSHOT_AT,
  })
  await order(EXPORTED_ID, storeA, 'proj_pp_a', '#PP2', 'EXPORTED', { sku: 'PP-SHOP-SKU', shopifyProductId: GID, customAttributesJson: ATTRS, ...resolvedOld })
  await order(OTHER_STORE_ID, storeB, 'proj_pp_b', '#PP3', 'PENDING_MAPPING', { sku: 'PP-SHOP-SKU', shopifyProductId: GID, customAttributesJson: ATTRS })
  await order(NO_PID_ID, storeA, 'proj_pp_a', '#PP4', 'PENDING_MAPPING', { sku: 'PP-NOPID' })

  const admin = await prisma.appUser.upsert({ where: { email: EMAILS[0] }, create: { name: 'Admin', email: EMAILS[0], role: 'ADMIN' }, update: {} })
  const support = await prisma.appUser.upsert({ where: { email: EMAILS[1] }, create: { name: 'Support', email: EMAILS[1], role: 'SUPPORT' }, update: {} })
  adminToken = await signToken({ userId: admin.id, email: EMAILS[0], name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
  supportToken = await signToken({ userId: support.id, email: EMAILS[1], name: 'Support', role: 'SUPPORT', permissions: [], tv: 0 })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: [OPEN_ID, HELD_ID, EXPORTED_ID, OTHER_STORE_ID, NO_PID_ID] } } })
  await prisma.productProfile.deleteMany({ where: { storeId: { in: [storeA, storeB] } } })
  await prisma.skuDesign.deleteMany({ where: { sku: 'PP-SHOP-SKU' } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP_A, SUP_B, SUP_OFF] } } })
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { in: [storeA, storeB] } } })
  await prisma.project.deleteMany({ where: { id: { in: ['proj_pp_a', 'proj_pp_b'] } } })
})

describe('PUT /api/design-studio/products/[key] validation', () => {
  it('rejects a non-admin with 403', async () => {
    const res = await put({ supplierProductId: SP_NEW }, supportToken)
    expect(res.status).toBe(403)
  })

  it.each([
    ['overrides not an array', { overrides: 'x' }],
    ['override with empty combo', { overrides: [{ combo: {}, supplierProductId: SP_NEW }] }],
    ['override with non-string value', { overrides: [{ combo: { Size: 3 }, supplierProductId: SP_NEW }] }],
    ['override to an unknown supplier product', { overrides: [{ combo: { Size: 'XL' }, supplierProductId: 'nope' }] }],
    ['unknown default supplier product', { supplierProductId: 'nope' }],
    ['unknown template', { printTemplateId: 'nope' }],
    ['non-http master', { masterArtworkUrl: 'javascript:alert(1)' }],
    ['layer with bad fit', { layerMap: [{ field: 'Name', layer: 'n', fit: 'stretch' }] }],
    ['layer with non-positive maxChars', { layerMap: [{ field: 'Name', layer: 'n', fit: 'none', maxChars: 0 }] }],
    ['duplicate layer field', { layerMap: [{ field: 'Name', layer: 'a', fit: 'none' }, { field: 'name', layer: 'b', fit: 'none' }] }],
    ['supplier product of an inactive supplier', { supplierProductId: SP_OFF }],
    ['override to an inactive supplier', { overrides: [{ combo: { Size: 'XL' }, supplierProductId: SP_OFF }] }],
  ])('400 for %s', async (_label, body) => {
    const res = await put(body)
    expect(res.status).toBe(400)
    expect(await prisma.productProfile.count({ where: { storeId: storeA } })).toBe(0)
  })

  it('400 when the template belongs to another supplier', async () => {
    const res = await put({ supplierProductId: SP_NEW, printTemplateId: TPL_A })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Template thuộc xưởng khác')
  })

  it('400 when the template matches none of the override suppliers', async () => {
    const res = await put({ overrides: [{ combo: { Size: 'XL' }, supplierProductId: SP_OLD }], printTemplateId: TPL_PROFILE })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Template thuộc xưởng khác')
  })

  it('400 for a key that is not storeId~number', async () => {
    const res = await put({}, adminToken, 'not-a-key')
    expect(res.status).toBe(400)
  })
})

describe('saving a profile', () => {
  let saved: any

  beforeAll(async () => {
    await syncDesignTasks(OPEN_ID)
    const res = await put({
      supplierProductId: SP_NEW,
      overrides: [{ combo: { Size: '6XL' }, supplierProductId: SP_OLD }],
      printTemplateId: TPL_PROFILE,
      masterArtworkUrl: MASTER,
      layerMap: [{ field: 'Name', layer: 'name_text', fit: 'shrink', maxChars: 12 }],
      notes: 'hello',
    })
    expect(res.status).toBe(200)
    saved = await res.json()
  })

  it('re-resolves the open line to the profile supplier at the new cost and renames its task supplier', async () => {
    expect(saved.reevaluation).toMatchObject({ ordersUpdated: 1, tasksTouched: 1 })
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: OPEN_ID, shopifyProductId: GID } })
    expect(line).toMatchObject({ resolvedSupplierId: SUP_B, resolvedSupplierSku: 'PP-NEW', resolvedBaseCost: 9 })
    expect(line.costSnapshotAt?.toISOString()).not.toBe(SNAPSHOT_AT.toISOString())
    const task = await prisma.designTask.findFirstOrThrow({ where: { orderId: OPEN_ID, shopifyLineId: line.shopifyLineId } })
    expect(task.supplierSnapshot).toBe('PP B')
  })

  it('leaves a line of another product in the same open order untouched', async () => {
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: OPEN_ID, shopifyProductId: OTHER_GID } })
    expect(line).toMatchObject({ resolvedSupplierId: SUP_A, resolvedSupplierSku: 'PP-OLD', resolvedBaseCost: 5 })
    expect(line.costSnapshotAt?.toISOString()).toBe(SNAPSHOT_AT.toISOString())
    const task = await prisma.designTask.findFirstOrThrow({ where: { orderId: OPEN_ID, shopifyLineId: line.shopifyLineId } })
    expect(task.supplierSnapshot).toBe('PP A')
  })

  it('keeps the cost snapshot of an open line already on the profile supplier', async () => {
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: HELD_ID } })
    expect(line).toMatchObject({ resolvedSupplierId: SUP_B, resolvedSupplierSku: 'PP-NEW', resolvedBaseCost: 7 })
    expect(line.costSnapshotAt?.toISOString()).toBe(SNAPSHOT_AT.toISOString())
  })

  it('leaves the exported order untouched', async () => {
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: EXPORTED_ID } })
    expect(line).toMatchObject({ resolvedSupplierId: SUP_A, resolvedSupplierSku: 'PP-OLD', resolvedBaseCost: 5 })
    expect(line.costSnapshotAt?.toISOString()).toBe(SNAPSHOT_AT.toISOString())
    expect(await prisma.designTask.count({ where: { orderId: EXPORTED_ID } })).toBe(0)
  })

  it('does not apply a store-A profile to a store-B line with the same product GID', async () => {
    const profiles = await loadProductProfilesForResolver()
    expect(profiles.get(profileKey(storeA, GID))?.supplierProductId).toBe(SP_NEW)
    expect(profiles.has(profileKey(storeB, GID))).toBe(false)

    await recalculateMissingOrderLineCosts({ orderIds: [OTHER_STORE_ID], refreshExisting: true })
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: OTHER_STORE_ID } })
    expect(line.resolvedSupplierId).toBeNull()
  })

  it('a notes-only save keeps fields the body leaves out and does not reprice', async () => {
    const before = await prisma.orderLine.findFirstOrThrow({ where: { orderId: OPEN_ID, shopifyProductId: GID } })
    const res = await put({ notes: 'second' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reevaluation).toMatchObject({ ordersUpdated: 0, tasksTouched: 0 })
    const after = await prisma.orderLine.findFirstOrThrow({ where: { orderId: OPEN_ID, shopifyProductId: GID } })
    expect(after.resolvedBaseCost).toBe(before.resolvedBaseCost)
    expect(after.costSnapshotAt?.toISOString()).toBe(before.costSnapshotAt?.toISOString())
    expect(body.profile).toMatchObject({ supplierProductId: SP_NEW, printTemplateId: TPL_PROFILE, masterArtworkUrl: MASTER, notes: 'second' })
    expect(body.profile.overrides).toEqual([{ combo: { Size: '6XL' }, supplierProductId: SP_OLD }])
  })

  it('loadTask prefers the profile template and master and exposes the profile', async () => {
    const task = await prisma.designTask.findFirstOrThrow({ where: { orderId: OPEN_ID, shopifyLineId: '#PP1-l1' } })
    const detail = await loadTask(task.taskKey)
    expect(detail?.template?.id).toBe(TPL_PROFILE)
    expect(detail?.slots).toEqual(['Front'])
    expect(detail?.profile).toEqual({
      key, status: 'READY', masterArtworkUrl: MASTER,
      layerMap: [{ field: 'Name', layer: 'name_text', fit: 'shrink', maxChars: 12 }],
    })
    expect(detail?.line.masterArtworkUrl).toBe(MASTER)
    expect(detail?.profileRouteKey).toBe(key)
  })

  it('without a profile template the SKU-matched template is used', async () => {
    await put({ printTemplateId: null })
    const task = await prisma.designTask.findFirstOrThrow({ where: { orderId: OPEN_ID, shopifyLineId: '#PP1-l1' } })
    const detail = await loadTask(task.taskKey)
    expect(detail?.template?.id).toBe(TPL_SKU)
    expect(detail?.profile?.status).toBe('NO_TEMPLATE')
    await put({ printTemplateId: TPL_PROFILE })
  })
})

describe('templateForLine with a profile template', () => {
  const profile = { printTemplateId: TPL_PROFILE }
  const base = { orderId: OPEN_ID, shopifyProductId: GID }

  it('a line resolved to the template supplier gets the profile template', async () => {
    const t = await templateForLine({ ...base, resolvedSupplierId: SUP_B, resolvedSupplierSku: 'PP-NEW' }, profile)
    expect(t?.id).toBe(TPL_PROFILE)
  })

  it('a line without a resolved supplier gets the profile template', async () => {
    const t = await templateForLine({ ...base, resolvedSupplierId: null, resolvedSupplierSku: null }, profile)
    expect(t?.id).toBe(TPL_PROFILE)
  })

  it('an override line resolved to another supplier falls through to that supplier SKU template', async () => {
    const t = await templateForLine({ ...base, resolvedSupplierId: SUP_A, resolvedSupplierSku: 'PP-A' }, profile)
    expect(t?.id).toBe(TPL_A)
  })

  it('an override line on another supplier with no matching template gets none, not the profile template', async () => {
    const t = await templateForLine({ ...base, resolvedSupplierId: SUP_A, resolvedSupplierSku: 'PP-OLD' }, profile)
    expect(t).toBeNull()
  })
})

describe('GET product routes', () => {
  it('lists the product with counts and reports lines without a product id', async () => {
    const res = await listRoute(req('http://localhost/api/design-studio/products?q=pp hoodie', adminToken))
    expect(res.status).toBe(200)
    const body = await res.json()
    const rows = body.products.filter((p: any) => p.shopifyProductId === GID)
    expect(rows.map((r: any) => r.shop).sort()).toEqual([SHOP_A, SHOP_B])
    const a = rows.find((r: any) => r.storeId === storeA)
    expect(a).toMatchObject({ key, orderCount: 3, openTasks: 1, status: 'READY', hasProfile: true })
    expect(rows.find((r: any) => r.storeId === storeB)).toMatchObject({ status: 'NONE', hasProfile: false })
    expect(body.withoutProductId).toBeGreaterThanOrEqual(1)
  })

  it('filters by status and rejects an unknown one', async () => {
    const ready = await (await listRoute(req('http://localhost/api/design-studio/products?status=READY', adminToken))).json()
    expect(ready.products.every((p: any) => p.status === 'READY')).toBe(true)
    const bad = await listRoute(req('http://localhost/api/design-studio/products?status=WHATEVER', adminToken))
    expect(bad.status).toBe(400)
  })

  it('loads one product with its profile, observed fields and pickers, without costs for non-admins', async () => {
    const res = await getRoute(req(`http://localhost/api/design-studio/products/${key}`, supportToken), { params: { key } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.profile.supplierProductId).toBe(SP_NEW)
    expect(body.observedFields).toEqual(['Name'])
    expect(body.status).toBe('READY')
    expect(body.summary).toMatchObject({ title: 'PP Hoodie', orderCount: 3, openTasks: 1 })
    const sp = body.supplierProducts.find((p: any) => p.id === SP_NEW)
    expect(sp).toBeDefined()
    expect(sp).not.toHaveProperty('baseCost')
    expect(body.supplierProducts.some((p: any) => p.id === SP_OFF)).toBe(false)
    expect(body.templates.some((t: any) => t.id === TPL_PROFILE)).toBe(true)
  })

  it('includes supplier costs for an admin', async () => {
    const res = await getRoute(req(`http://localhost/api/design-studio/products/${key}`, adminToken), { params: { key } })
    const body = await res.json()
    expect(body.supplierProducts.find((p: any) => p.id === SP_NEW).baseCost).toBe(9)
  })

  it('404 for an unknown product', async () => {
    const k = toRouteKey(storeA, 'gid://shopify/Product/1')
    const res = await getRoute(req(`http://localhost/api/design-studio/products/${k}`, adminToken), { params: { key: k } })
    expect(res.status).toBe(404)
  })
})
