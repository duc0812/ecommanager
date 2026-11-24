import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { buildPrintpossPush, pushPrintpossOrder, refreshPrintpossPush, syncPrintpossCatalog, syncPrintpossTracking } from '@/lib/repos/printposs-push'
import { getPrintpossSettings, savePrintpossSettings } from '@/lib/printposs-settings'
import { handoffStateFor } from '@/lib/supplier-handoff'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GET as getSettings, PUT as putSettings } from '@/app/api/fulfillment/printposs/settings/route'
import { GET as previewRoute } from '@/app/api/fulfillment/printposs/orders/[orderId]/preview/route'
import { POST as pushRoute } from '@/app/api/fulfillment/printposs/orders/[orderId]/push/route'
import type { PrintpossOrder } from '@/lib/printposs'

const PROJECT = 'proj-printposs-test'
const SUP = 'sup-printposs-test'
const TOKEN = 'printposs-fixture-token'
let storeId = ''
let superToken = ''
let adminToken = ''
let sellerToken = ''
let seq = 0
let remote: PrintpossOrder[] = []
let creates = 0
let mode: 'ok' | 'timeout' | 'refused' = 'ok'
let active = true

async function order(opts: { approved?: boolean; multi?: boolean; foreign?: boolean } = {}) {
  const id = `pp-order-${++seq}`
  const lineId = `${id}-line`
  await prisma.order.create({ data: {
    id, storeId, projectId: PROJECT, shopifyOrderNumber: `#PPTEST${1000 + seq}`, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 30, expectedPayout: 28, totalFees: 2, refundedAmount: 0, placedAt: new Date(), pipelineStatus: 'READY_TO_PRODUCTION', designReady: true,
    customerName: 'Jo Doe', shippingName: 'Jo Doe', shippingAddress1: '12 Main St', shippingCity: 'Denver', shippingState: 'Colorado', shippingZip: '80202', shippingCountry: 'US',
    lines: { create: [{ shopifyLineId: lineId, productTitle: 'Case', qty: 1, unitPrice: 30, linePosition: 1, resolvedSupplierId: SUP, resolvedSupplierSku: 'case-one',
      imageUrl: 'https://cdn.shopify.com/mockup.png', designDriveLink: '/api/design-studio/file/placeholder' },
      ...(opts.foreign ? [{ shopifyLineId: `${id}-other`, productTitle: 'Another supplier item', qty: 1, unitPrice: 10, linePosition: 2, resolvedSupplierId: 'sup-pp-other', resolvedSupplierSku: 'other', imageUrl: null, designDriveLink: null }] : [])] },
    designTasks: { create: { shopifyLineId: lineId, taskKey: `PPTEST${1000 + seq}_1`, status: opts.approved === false ? 'REVIEW' : 'DONE' } },
  } })
  for (const area of opts.multi ? ['Front', 'Back'] : ['Artwork']) {
    await prisma.designArtwork.create({ data: { orderId: id, shopifyLineId: lineId, printArea: area, version: 1, fileName: `${area}.png`, storagePath: `test/${id}-${area}.png`,
      mimeType: 'image/png', size: 100, widthPx: 1000, heightPx: 1000 } })
  }
  return id
}

async function preview(id: string) { return (await buildPrintpossPush(id))!.preview }
async function send(id: string) { return pushPrintpossOrder(id, { payloadHash: (await preview(id)).payloadHash!, userId: null }) }
const row = (id: string) => prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: id } })
function req(path: string, token: string, body?: unknown) {
  const r = new NextRequest(`http://test/api/fulfillment/printposs/${path}`, body === undefined ? undefined : { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  r.cookies.set(AUTH_COOKIE, token)
  return r
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'printposs-test-secret-long-enough-for-tests'
  await prisma.project.create({ data: { id: PROJECT, name: 'Printposs test', startDate: new Date() } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: 'printposs-test.myshopify.com', projectId: PROJECT } })).id
  await prisma.supplier.createMany({ data: [{ id: SUP, name: 'Printposs', code: 'printposs', apiType: 'printposs' }, { id: 'sup-pp-other', name: 'Other PP test', code: 'pp-other-test' }] })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'case-one', apiSku: '501', baseCost: 5, requiresDesign: true } })
  for (const role of ['SUPERADMIN', 'ADMIN', 'SELLER'] as const) {
    const email = `${role.toLowerCase()}@printposs.test`
    const user = await prisma.appUser.create({ data: { email, name: role, role, passwordHash: 'x', permissions: role === 'SELLER' ? JSON.stringify(['fulfillment_export', 'fulfillment_orders']) : '[]' } })
    const token = await signToken({ userId: user.id, email, name: role, role, permissions: role === 'SELLER' ? ['fulfillment_export', 'fulfillment_orders'] : [], tv: 0 })
    if (role === 'SUPERADMIN') superToken = token
    else if (role === 'ADMIN') adminToken = token
    else sellerToken = token
  }
})

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
  await savePrintpossSettings({ token: TOKEN, storeId: null })
  remote = []; creates = 0; mode = 'ok'; active = true
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const u = new URL(String(input))
    expect(u.origin).toBe('https://api.printposs.com')
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` })
    if (u.pathname.endsWith('/products')) return Response.json({ success: true, data: [{ name: 'Case', variants: [
      { id: 501, sku: 'case-one', variant_name: 'Case One', is_active: active, base_cost: '5.50' },
      { id: 502, sku: 'case-inactive', variant_name: 'Inactive', is_active: false, base_cost: '6.00' },
    ] }], meta: { last_page: 1 } })
    if (u.pathname.endsWith('/stores')) return Response.json({ data: [{ id: 3, name: 'Printposs store' }], meta: { last_page: 1 } })
    if (u.pathname.endsWith('/orders') && init?.method === 'POST') {
      creates++
      if (mode === 'refused') return Response.json({ message: 'Bad address' }, { status: 422 })
      const payload = JSON.parse(String(init.body))
      const o: PrintpossOrder = { ...payload, order_number: `PP${creates}`, order_status: 'pending_payment', payment_status: 'unpaid', total_cost: 5.5,
        items: payload.items.map((i: any, n: number) => ({ ...i, id: n + 10 })), packages: [] }
      remote.push(o)
      if (mode === 'timeout') throw new Error('lost response after create')
      return Response.json({ success: true, data: o }, { status: 201 })
    }
    if (u.pathname.endsWith('/orders')) return Response.json({ data: remote, meta: { last_page: 1 } })
    const found = remote.find(o => u.pathname.endsWith(`/${o.order_number}`))
    if (found) return Response.json({ success: true, data: found })
    throw new Error(`Unexpected request ${u.pathname}`)
  }))
})

afterEach(() => vi.unstubAllGlobals())
afterAll(async () => {
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplierCostHistory.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP, 'sup-pp-other'] } } })
  await prisma.appUser.deleteMany({ where: { email: { endsWith: '@printposs.test' } } })
  await prisma.shopifyStore.delete({ where: { id: storeId } })
  await prisma.project.delete({ where: { id: PROJECT } })
  await savePrintpossSettings({ token: null, storeId: null })
  delete process.env.NEXT_PUBLIC_APP_URL
})

describe('Printposs integration', () => {
  it('previews and sends only approved supplier lines, marks them sent and blocks duplicates', async () => {
    const id = await order({ foreign: true })
    const p = await preview(id)
    expect(p.canPush).toBe(true)
    expect(p.payload).toMatchObject({ first_name: 'Jo', last_name: 'Doe', region: 'CO', country: 'US', items: [{ product_variant_id: 501 }] })
    expect(JSON.stringify(p)).not.toContain(TOKEN)
    const state = await handoffStateFor(id)
    expect(state?.apiKind).toBe('printposs')
    await send(id)
    const db = await prisma.order.findUniqueOrThrow({ where: { id }, include: { lines: true } })
    expect(db.pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect(db.lines.find(l => l.resolvedSupplierId === SUP)?.exportedAt).toBeTruthy()
    expect(db.lines.find(l => l.resolvedSupplierId !== SUP)?.exportedAt).toBeNull()
    await expect(send(id)).rejects.toMatchObject({ code: 'DUPLICATE' })
    expect(creates).toBe(1)
  })

  it('does not send multi-part artwork, unapproved lines, inactive variants or a stale preview', async () => {
    expect((await preview(await order({ multi: true }))).issues.map(i => i.code)).toContain('SINGLE_DESIGN')
    expect((await preview(await order({ approved: false }))).canPush).toBe(false)
    const id = await order()
    const p = await preview(id)
    active = false
    expect((await preview(id)).issues.map(i => i.code)).toContain('VARIANT_INACTIVE')
    active = true
    await prisma.order.update({ where: { id }, data: { shippingAddress1: '99 Changed St' } })
    await expect(pushPrintpossOrder(id, { payloadHash: p.payloadHash!, userId: null })).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' })
    expect(creates).toBe(0)
  })

  it('reserves once for concurrent clicks', async () => {
    const id = await order()
    const p = await preview(id)
    const results = await Promise.allSettled([1, 2].map(() => pushPrintpossOrder(id, { payloadHash: p.payloadHash!, userId: null })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(creates).toBe(1)
  })

  it('holds a timed-out create until exact reconciliation and never releases it merely because it is absent', async () => {
    const id = await order()
    mode = 'timeout'
    await expect(send(id)).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' })
    expect((await row(id)).status).toBe('SENDING')
    const saved = remote; remote = []
    await prisma.supplierOrderPush.update({ where: { id: (await row(id)).id }, data: { pushedAt: new Date(Date.now() - 3600_000) } })
    expect((await refreshPrintpossPush(id)).found).toBe(false)
    expect((await row(id)).status).toBe('SENDING')
    remote = saved
    expect((await refreshPrintpossPush(id)).push.status).toBe('CREATED')
    await expect(send(id)).rejects.toMatchObject({ code: 'DUPLICATE' })
    expect(creates).toBe(1)
  })

  it('makes a definite validation refusal retryable', async () => {
    const id = await order(); mode = 'refused'
    await expect(send(id)).rejects.toMatchObject({ code: 'CREATE_FAILED' })
    expect((await row(id)).status).toBe('FAILED')
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: id } })).exportedAt).toBeNull()
    mode = 'ok'; await send(id)
    expect((await row(id)).status).toBe('CREATED')
  })

  it('writes paid item-specific tracking and keeps it tied to the supplier', async () => {
    const id = await order(); await send(id)
    remote[0].order_status = 'shipped'; remote[0].payment_status = 'paid'
    remote[0].packages = [{ id: 20, status: 'in_transit', tracking_number: 'PPTRACK', carrier: 'USPS', items: [{ order_item_id: 10, quantity: 1 }] }]
    expect((await refreshPrintpossPush(id)).shipments).toBe(1)
    const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(shipment).toMatchObject({ supplierId: SUP, trackingNumber: 'PPTRACK', shopifyLineId: `${id}-line` })
    expect((await syncPrintpossTracking()).shipments).toBe(0)
  })

  it('imports active variants and costs without dropping a template or shipping rate', async () => {
    await prisma.supplierProduct.update({ where: { supplierId_sku: { supplierId: SUP, sku: 'case-one' } }, data: { shippingByRegion: '{"US":{"first":5,"additional":2}}' } })
    expect(await syncPrintpossCatalog()).toMatchObject({ supplierId: SUP, imported: 1, inactive: 1 })
    const product = await prisma.supplierProduct.findUniqueOrThrow({ where: { supplierId_sku: { supplierId: SUP, sku: 'case-one' } } })
    expect(product).toMatchObject({ apiSku: '501', baseCost: 5.5, shippingByRegion: '{"US":{"first":5,"additional":2}}' })
  })

  it('protects credentials, preserves a blank token and refuses another store’s order', async () => {
    expect((await putSettings(req('settings', adminToken, { token: 'wrong' }))).status).toBe(403)
    const updated = await putSettings(req('settings', superToken, { token: '', storeId: '3' }))
    expect(updated.status).toBe(200)
    expect(await getPrintpossSettings()).toMatchObject({ token: TOKEN, storeId: '3' })
    const view = await (await getSettings(req('settings', superToken))).json()
    expect(view).toEqual({ hasToken: true, storeId: '3' })
    const id = await order()
    expect((await previewRoute(req(`orders/${id}/preview`, sellerToken), { params: { orderId: id } })).status).toBe(403)
    const sendReq = new NextRequest(`http://test/api/fulfillment/printposs/orders/${id}/push`, { method: 'POST', body: JSON.stringify({ confirm: true, payloadHash: 'a'.repeat(64) }) })
    sendReq.cookies.set(AUTH_COOKIE, sellerToken)
    expect((await pushRoute(sendReq, { params: { orderId: id } })).status).toBe(403)
    expect(creates).toBe(0)
  })
})
