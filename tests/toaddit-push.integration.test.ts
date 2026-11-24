import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { postToadditHttp2 } from '@/lib/toaddit-transport'
import { buildToadditPush, cancelToadditPush, pushToadditOrder, refreshToadditPush, syncToadditCatalog, syncToadditTracking } from '@/lib/repos/toaddit-push'
import { getToadditSettings, saveToadditSettings } from '@/lib/toaddit-settings'
import { listToadditTemplates, toadditAccount, toadditAccountId } from '@/lib/toaddit'
import { handoffStateFor } from '@/lib/supplier-handoff'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GET as settingsGet, PUT as settingsPut } from '@/app/api/fulfillment/toaddit/settings/route'
import { POST as pushRoute } from '@/app/api/fulfillment/toaddit/orders/[orderId]/push/route'

vi.mock('@/lib/toaddit-transport', () => ({ postToadditHttp2: vi.fn() }))
const PROJECT = 'project-toaddit-fixture'
const SUP = 'supplier-toaddit-fixture'
const APPKEY = 'toaddit-fixture-key'
const SECRET = 'toaddit-fixture-secret'
let storeId = ''
let adminToken = ''
let superToken = ''
let seq = 0
let remote: any[] = []
let creates = 0
let mode: 'ok' | 'timeout' | 'refused' | 'payment-unknown' = 'ok'
let cancelRefused = false
let collections: any[] = []
let trackingRows: any[] = []
let calls: Array<{ path: string; body: any; headers: Record<string, string>; origin: string }> = []

const response = (data: any, page?: any) => ({ status: 200, text: JSON.stringify({ code: 0, data, ...(page ? { page } : {}) }) })
async function makeOrder(opts: { foreign?: boolean; approved?: boolean; qty?: number } = {}) {
  const id = `toaddit-order-${++seq}`
  await prisma.order.create({ data: {
    id, storeId, projectId: PROJECT, shopifyOrderNumber: `#TDTEST${1000 + seq}`, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 30, expectedPayout: 28, totalFees: 2, refundedAmount: 0, placedAt: new Date(), pipelineStatus: 'READY_TO_PRODUCTION', designReady: opts.approved !== false,
    customerName: 'Jo Doe', shippingName: 'Jo Doe', shippingPhone: '+13035550100', shippingAddress1: '12 Main St', shippingAddress2: 'Apt 4', shippingCity: 'Denver', shippingState: 'Colorado', shippingZip: '80202', shippingCountry: 'US',
    lines: { create: [{ shopifyLineId: `${id}-line`, productTitle: 'Toaddit Case', qty: opts.qty ?? 1, unitPrice: 30, linePosition: 1, resolvedSupplierId: SUP, resolvedSupplierSku: 'TD-BASE',
      imageUrl: 'https://cdn.shopify.com/mockup.png', designDriveLink: '/api/design-studio/file/placeholder' },
      ...(opts.foreign ? [{ shopifyLineId: `${id}-other`, productTitle: 'Other supplier', qty: 1, unitPrice: 10, linePosition: 2, resolvedSupplierId: 'supplier-td-other', resolvedSupplierSku: 'OTHER', imageUrl: null, designDriveLink: null }] : [])] },
    designTasks: { create: { shopifyLineId: `${id}-line`, taskKey: `TDTEST${1000 + seq}_1`, status: opts.approved === false ? 'REVIEW' : 'DONE' } },
  } })
  await prisma.designArtwork.create({ data: { orderId: id, shopifyLineId: `${id}-line`, printArea: 'Artwork', version: 1, fileName: 'print.png', storagePath: `fixture/${id}.png`, mimeType: 'image/png', size: 100, widthPx: 1000, heightPx: 1000 } })
  return id
}
const preview = async (id: string, selection = {}) => (await buildToadditPush(id, selection))!.preview
const send = async (id: string, templateIds = {}) => pushToadditOrder(id, { payloadHash: (await preview(id, templateIds)).payloadHash!, userId: null, confirmTemplates: true, templateIds })
const pushRow = (orderId: string) => prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: 'desc' } })
function request(path: string, token: string, body?: unknown, method = 'PUT') {
  const r = new NextRequest(`http://fixture/api/fulfillment/toaddit/${path}`, body === undefined ? undefined : { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  r.cookies.set(AUTH_COOKIE, token); return r
}
const set = (key: string, value: string) => prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'toaddit-test-secret-long-enough-for-fixtures'
  await prisma.project.create({ data: { id: PROJECT, name: 'Toaddit fixture', startDate: new Date() } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: 'toaddit-fixture.myshopify.com', projectId: PROJECT } })).id
  await prisma.supplier.createMany({ data: [{ id: SUP, name: 'Toaddit', code: 'toaddit', apiType: 'toaddit' }, { id: 'supplier-td-other', name: 'TD Other', code: 'toaddit-fixture-other' }] })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'TD-BASE', apiSku: '501', baseCost: 5, requiresDesign: true } })
  for (const role of ['ADMIN', 'SUPERADMIN'] as const) {
    const user = await prisma.appUser.create({ data: { email: `${role}@toaddit.fixture`, name: role, role, passwordHash: 'x', permissions: '[]' } })
    const token = await signToken({ userId: user.id, email: user.email, name: role, role, permissions: [], tv: 0 })
    if (role === 'ADMIN') adminToken = token; else superToken = token
  }
})

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
  await saveToadditSettings({ appKey: APPKEY, appSecret: SECRET, environment: 'production', shippingMethod: '1', payOnCreate: false })
  await prisma.supplierProduct.update({ where: { supplierId_sku: { supplierId: SUP, sku: 'TD-BASE' } }, data: { apiSku: '501' } })
  creates = 0; calls = []; remote = []; trackingRows = []; mode = 'ok'; cancelRefused = false
  collections = [501, 502].map((id, i) => ({ id: 10 + i, englishName: `Final design ${i + 1}`, referChange: 0, createTime: '2026-11-24 12:00:00',
    customProductList: [{ id: 100 + i, styleId: 1, customShowImageList: [{ clearPath: `https://cdn.toaddit.com/design-${id}.png` }],
      customSpecificProductList: [{ id, customSku: `TD-FINAL-${id}`, sizeId: 20 }] }],
    productPrototype: { styleList: [{ id: 1, name: 'Black', status: 1 }], sizeList: [{ id: 20, sizeName: 'L', status: 1, lowerLimitPrice: 5.5 }] },
  }))
  vi.mocked(postToadditHttp2).mockImplementation(async (origin, endpoint, headers, raw) => {
    const path = endpoint.replace('/openapi/toaddit/v1', '')
    const body = JSON.parse(raw)
    calls.push({ path, body, headers, origin })
    expect(headers['X-App-Key']).toBeTruthy()
    expect(headers['X-Timestamp']).toMatch(/^\d{10}$/)
    expect(headers['X-Nonce']).toMatch(/^[a-f0-9-]{36}$/)
    if (path === '/app/token' || path === '/app/refreshToken') return response({ accessToken: path === '/app/token' ? 'td-access' : 'td-renewed', refreshToken: 'td-refresh', accessTokenExpiresIn: 86400, refreshTokenExpiresIn: 2592000 })
    expect(headers['X-Access-Token']).toBeTruthy()
    if (path === '/productService/productCollectionList') return response(collections, { total: collections.length, pageIndex: 1, pageSize: 100 })
    if (path === '/order/list') { const hits = remote.filter(o => o.externalOrderCode === body.externalOrderCode); return response(hits, { total: hits.length, pageIndex: 1, pageSize: 100 }) }
    if (path === '/order/create') {
      creates++
      if (mode === 'refused') return { status: 200, text: JSON.stringify({ code: 310130, message: 'Invalid country' }) }
      const orderId = `2702623869149929${String(400 + creates)}`
      const orderCode = `Toaddit-test-${seq}-${creates}`
      remote.push({ id: orderId, orderCode, externalOrderCode: body.externalOrderCode, status: body.isPayment ? 41 : 30, isWholesale: 0,
        items: body.items.map((item: any, index: number) => ({ ...item, id: `item-${index}` })), logistics: body.logistics,
        orderFinance: { paymentProductAmount: 5.5, finalFreightAmount: 6, paymentTax: 0 } })
      if (mode === 'timeout') throw new Error('lost response')
      if (mode === 'payment-unknown') return { status: 200, text: JSON.stringify({ code: 510103, message: 'Insufficient balance' }) }
      return response({ orderId, orderCode, paymentResult: body.isPayment, isWholesale: 0 })
    }
    if (path === '/order/cancel') {
      if (cancelRefused) return { status: 200, text: JSON.stringify({ code: 310302, message: 'Cannot cancel in production' }) }
      const order = remote.find(o => o.id === body.id)
      order.status = 80
      return response({ id: order.id, newStatus: 80, statusIsChanged: 1 })
    }
    if (path === '/orderLogistics/trackInfo') return response(trackingRows)
    throw new Error(`Unexpected Toaddit path: ${path}`)
  })
})
afterEach(() => vi.mocked(postToadditHttp2).mockReset())
afterAll(async () => {
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplierCostHistory.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP, 'supplier-td-other'] } } })
  await prisma.appUser.deleteMany({ where: { email: { endsWith: '@toaddit.fixture' } } })
  await prisma.shopifyStore.delete({ where: { id: storeId } }); await prisma.project.delete({ where: { id: PROJECT } })
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'toaddit.' } } })
  delete process.env.NEXT_PUBLIC_APP_URL
})

describe('Toaddit API integration', () => {
  it('caches server-only tokens and refreshes expired access without exposing secrets', async () => {
    const account = await toadditAccount()
    await listToadditTemplates(account); await listToadditTemplates(account)
    expect(calls.filter(c => c.path === '/app/token')).toHaveLength(1)
    const key = `toaddit.session.${toadditAccountId(account)}`
    const row = await prisma.appSetting.findUniqueOrThrow({ where: { key } })
    await set(key, JSON.stringify({ ...JSON.parse(row.value), accessExpiresAt: Date.now() - 1000 }))
    await listToadditTemplates(account)
    expect(calls.filter(c => c.path === '/app/refreshToken')).toHaveLength(1)
    expect(calls.at(-1)?.headers['X-Access-Token']).toBe('td-renewed')
    const view = await (await settingsGet(request('settings', superToken))).json()
    for (const secret of [APPKEY, SECRET, 'td-access', 'td-renewed', 'td-refresh']) expect(JSON.stringify(view)).not.toContain(secret)
    expect(new Set(calls.map(c => c.headers['X-Nonce'])).size).toBe(calls.length)
  })

  it('builds a template-based request and makes a per-order choice without changing shared mapping', async () => {
    const id = await makeOrder({ foreign: true })
    const p = await preview(id, { [`${id}-line`]: '502' })
    expect(p.canPush).toBe(true)
    expect(p.payload).toMatchObject({ items: [{ specificProductId: '502', count: 1 }], isPayment: 0, deliveryShippingType: 1, logistics: { consignee: 'Jo Doe', province: 'CO', phone: '+13035550100' } })
    expect(JSON.stringify(p.payload)).not.toContain('design_image_url')
    expect(p.toaddit.templates[0]).toMatchObject({ templateId: '502', images: ['https://cdn.toaddit.com/design-502.png'] })
    await send(id, { [`${id}-line`]: '502' })
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { supplierId_sku: { supplierId: SUP, sku: 'TD-BASE' } } })).apiSku).toBe('501')
    const db = await prisma.order.findUniqueOrThrow({ where: { id }, include: { lines: true } })
    expect(db.pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect(db.lines.find(l => l.resolvedSupplierId === SUP)?.exportedAt).toBeTruthy()
    expect(db.lines.find(l => l.resolvedSupplierId !== SUP)?.exportedAt).toBeNull()
    expect((await handoffStateFor(id))?.apiKind).toBe('toaddit')
    expect(calls.find(c => c.path === '/order/create')?.body.items[0].specificProductId).toBe('502')
    await expect(send(id)).rejects.toMatchObject({ code: 'DUPLICATE' })
    expect(creates).toBe(1)
  })

  it('requires explicit template confirmation and rejects stale template revisions', async () => {
    const id = await makeOrder(); const p = await preview(id)
    await expect(pushToadditOrder(id, { payloadHash: p.payloadHash!, userId: null, confirmTemplates: false })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_CONFIRMED' })
    collections[0].customProductList[0].customShowImageList[0].clearPath = 'https://cdn.toaddit.com/changed.png'
    await expect(pushToadditOrder(id, { payloadHash: p.payloadHash!, userId: null, confirmTemplates: true })).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' })
    expect(creates).toBe(0)
  })

  it('blocks unapproved designs, retired templates, missing phone, quantities and wholesale totals', async () => {
    expect((await preview(await makeOrder({ approved: false }))).canPush).toBe(false)
    const id = await makeOrder()
    collections[0].referChange = 1
    expect((await preview(id)).issues.map(i => i.code)).toContain('TEMPLATE_UNAVAILABLE')
    collections[0].referChange = 0
    await prisma.order.update({ where: { id }, data: { shippingPhone: null } })
    expect((await preview(id)).issues.map(i => i.code)).toContain('ADDRESS')
    expect((await preview(await makeOrder({ qty: 1000 }))).issues.map(i => i.code)).toContain('QUANTITY')
    expect((await preview(await makeOrder({ qty: 40 }))).issues.map(i => i.code)).toContain('WHOLESALE')
  })

  it('only one concurrent confirm creates an order', async () => {
    const id = await makeOrder(); const p = await preview(id)
    const results = await Promise.allSettled([1, 2].map(() => pushToadditOrder(id, { payloadHash: p.payloadHash!, userId: null, confirmTemplates: true })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(creates).toBe(1)
  })

  it.each(['timeout', 'payment-unknown'] as const)('holds an uncertain create (%s) and reconciles exact order content', async failure => {
    const id = await makeOrder(); mode = failure
    await expect(send(id)).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' })
    expect((await pushRow(id)).status).toBe('SENDING')
    const saved = remote; remote = []
    await refreshToadditPush(id)
    expect((await pushRow(id)).status).toBe('SENDING')
    remote = saved; remote[0].items[0].specificProductId = '999'
    await expect(refreshToadditPush(id)).rejects.toMatchObject({ code: 'REMOTE_MISMATCH' })
    remote[0].items[0].specificProductId = '501'
    expect((await refreshToadditPush(id)).push.status).toBe('CREATED')
    expect(creates).toBe(1)
  })

  it('retries only definite create refusals and honors pay-on-create configuration', async () => {
    const id = await makeOrder(); mode = 'refused'
    await expect(send(id)).rejects.toMatchObject({ code: 'CREATE_FAILED' })
    expect((await pushRow(id)).status).toBe('FAILED')
    mode = 'ok'; await saveToadditSettings({ payOnCreate: true, shippingMethod: '2' })
    await send(id)
    expect(calls.filter(c => c.path === '/order/create').at(-1)?.body).toMatchObject({ isPayment: 1, deliveryShippingType: 2 })
    expect(calls.some(c => c.path === '/order/payment')).toBe(false)
  })

  it('confirms cancellation remotely, restores only sent lines and uses a fresh resend number', async () => {
    const id = await makeOrder(); await send(id)
    cancelRefused = true
    await expect(cancelToadditPush(id)).rejects.toThrow()
    expect((await pushRow(id)).status).toBe('CREATED')
    cancelRefused = false
    expect((await cancelToadditPush(id)).push.status).toBe('CANCELLED')
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: id } })).exportedAt).toBeNull()
    expect((await preview(id)).payload).toMatchObject({ externalOrderCode: expect.stringMatching(/-R2$/) })
  })

  it('refuses sandbox production writes and account changes on existing pushes', async () => {
    const id = await makeOrder()
    await saveToadditSettings({ environment: 'sandbox' })
    expect((await preview(id)).canPush).toBe(false)
    await expect(syncToadditCatalog()).rejects.toMatchObject({ code: 'SANDBOX' })
    expect((await syncToadditTracking()).skipped).toContain('sandbox')
    await saveToadditSettings({ environment: 'production' }); await send(id)
    await saveToadditSettings({ appKey: 'different-account' })
    await expect(refreshToadditPush(id)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
  })

  it('only writes real, single-parcel tracking to the carried supplier lines', async () => {
    const id = await makeOrder({ foreign: true }); await send(id)
    remote[0].status = 70
    trackingRows = [{ orderId: remote[0].id, orderStatus: 70, productCount: 1, waybillStatus: 4, shippingMethodName: 'ToAddit', waybillCode: 'VIRTUAL', companyName: 'Toaddit' }]
    expect((await refreshToadditPush(id)).shipments).toBe(0)
    trackingRows[0] = { ...trackingRows[0], shippingMethodName: 'Standard', waybillCode: 'REALTRACK', companyName: 'USPS' }
    expect((await refreshToadditPush(id)).shipments).toBe(1)
    expect(await prisma.shipment.findMany({ where: { orderId: id } })).toMatchObject([{ supplierId: SUP, shopifyLineId: `${id}-line`, trackingNumber: 'REALTRACK' }])
    expect((await syncToadditTracking()).shipments).toBe(0)
  })

  it('imports active final template IDs, preserves shipping and keeps settings secret', async () => {
    await syncToadditCatalog()
    await prisma.supplierProduct.update({ where: { supplierId_sku: { supplierId: SUP, sku: 'TD-FINAL-501' } }, data: { shippingByRegion: '{"US":{"first":6,"additional":2}}' } })
    expect(await syncToadditCatalog()).toMatchObject({ imported: 2 })
    expect(await prisma.supplierProduct.findUniqueOrThrow({ where: { supplierId_sku: { supplierId: SUP, sku: 'TD-FINAL-501' } } })).toMatchObject({ apiSku: '501', baseCost: 5.5, shippingByRegion: '{"US":{"first":6,"additional":2}}' })
    expect((await settingsPut(request('settings', adminToken, { appKey: 'wrong' }))).status).toBe(403)
    expect((await settingsPut(request('settings', superToken, { appKey: '', appSecret: '' }))).status).toBe(200)
    expect(await getToadditSettings()).toMatchObject({ appKey: APPKEY, appSecret: SECRET })
    const id = await makeOrder()
    expect((await pushRoute(request(`orders/${id}/push`, adminToken, { confirm: true, payloadHash: 'a'.repeat(64) }, 'POST'), { params: { orderId: id } })).status).toBe(400)
  })
})
