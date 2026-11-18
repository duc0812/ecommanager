import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { setCsvLocked } from '@/lib/csv-lock'
import { handoffOrderCsv, handoffStateFor } from '@/lib/supplier-handoff'
import { pushedShipmentRows } from '@/lib/fulfillment/auto-fulfill'
import { syncCatkissfishTracking } from '@/lib/repos/catkissfish-push'
import { syncApiSupplierTracking } from '@/lib/repos/supplier-tracking-sync'
import { CATKISSFISH_KEYS, catkissfishSession, getCatkissfishSettings } from '@/lib/catkissfish-settings'
import { GET as getPreview } from '@/app/api/fulfillment/catkissfish/orders/[orderId]/preview/route'
import { POST as postPush } from '@/app/api/fulfillment/catkissfish/orders/[orderId]/push/route'
import { POST as postCancel } from '@/app/api/fulfillment/catkissfish/orders/[orderId]/cancel/route'
import { POST as postRefresh } from '@/app/api/fulfillment/catkissfish/orders/[orderId]/refresh/route'
import { GET as getSettingsRoute, PUT as putSettingsRoute } from '@/app/api/fulfillment/catkissfish/settings/route'
import { POST as postSettingsTest } from '@/app/api/fulfillment/catkissfish/settings/test/route'

const SHOP = 'ckfstore.myshopify.com'
const PROJECT = 'proj_ckf'
const SUP = 'sup_ckf'
const SKU = 'CKF-KNIT-SCARF-35X193'
const STYLE = 'Scarf & Silk Scarf1-14'
const ORIGIN = 'https://www.catkissfish.com'
const APP_URL = 'https://tool.shop-example.com'
const API = '/website/open/api'
const CLIENT_ID = 'CLIENT-ID-123456'
const SECRET = 'client-secret-value'

let storeId = ''
let adminToken = ''
let superToken = ''
let seq = 0

type Call = { path: string; query: URLSearchParams; method: string; headers: Record<string, string>; body: unknown }
type Reply = { status: number; json: unknown } | 'network-error'
type RemoteOrder = { id: string; state: number; tracking: { logisticName: string; logisticKey: string; logisticNumber: string }[] }
let calls: Call[] = []
let handler: (call: Call) => Reply
let remoteOrders: Map<string, RemoteOrder>
let tokensIssued = 0
let nextId = 9000
let dimensions: unknown[] = []

const ok = (data: unknown): Reply => ({ status: 200, json: { code: 0, message: '', data } })
const refused = (code: number, message: string): Reply => ({ status: 200, json: { code, message, data: null } })
const tracking = (logisticNumber: string) => ({ logisticName: 'USPS', logisticKey: 'usps', logisticNumber })
const byId = (id: string | null) => Array.from(remoteOrders.values()).find(o => o.id === id)

function defaultHandler(call: Call): Reply {
  if (call.path === '/website/oauth2/client_token') {
    tokensIssued++
    return { status: 200, json: { code: 200, msg: 'ok', data: { client_token: `tok-${tokensIssued}`, expires_in: 7200, client_id: CLIENT_ID } } }
  }
  const p = call.path.replace(API, '')
  if (p === '/products/detail') {
    if (call.query.get('styleCode') !== STYLE) return refused(404, 'style not found')
    return ok({ name: 'Custom Unisex Knit Scarf', styleCode: STYLE, sizeNameList: ['Unisize'], colorInfoList: [{ colorEnName: 'white' }], colorSizeInfoList: [{ color: 'white', size: 'Unisize', saleState: true }], dimensions: null })
  }
  if (p === '/products/auto/design/list') return ok({ total: 1, records: [{ styleCode: STYLE, dimensions }] })
  if (p === '/order/list') {
    const wanted = JSON.parse(String(call.body)).platformOrderId
    const o = remoteOrders.get(wanted)
    return ok({ total: o ? 1 : 0, records: o ? [{ id: o.id, shopOrderId: wanted, state: o.state }] : [] })
  }
  if (p === '/order/create/auto/design/order') {
    const id = String(nextId++)
    remoteOrders.set(JSON.parse(String(call.body)).platformOrderId, { id, state: 1, tracking: [] })
    return ok([id])
  }
  if (p === '/order/detail') {
    const o = byId(call.query.get('id'))
    return o ? ok({ shopOrderId: 'any', pyShopOrderId: o.id, state: o.state }) : refused(404, 'order not found')
  }
  if (p === '/order/cancel') {
    const o = byId(call.query.get('id'))
    if (o) o.state = 6
    return ok({})
  }
  if (p === '/order/query/order/tracking/number') return ok(byId(call.query.get('id'))?.tracking ?? [])
  return { status: 404, json: { code: 404, message: `unexpected path in test: ${p}` } }
}

const callsTo = (suffix: string) => calls.filter(c => c.path.endsWith(suffix))
const creates = () => callsTo('/order/create/auto/design/order')

async function req(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

const send = (method: string, body: unknown) => ({ method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const base = (orderId: string) => `http://x/api/fulfillment/catkissfish/orders/${encodeURIComponent(orderId)}`
const SETTINGS = 'http://x/api/fulfillment/catkissfish/settings'
const preview = async (orderId: string) => getPreview(await req(`${base(orderId)}/preview`, adminToken), { params: { orderId } })
const previewJson = async (orderId: string) => (await preview(orderId)).json()
const push = async (orderId: string, payloadHash: string) =>
  postPush(await req(`${base(orderId)}/push`, adminToken, send('POST', { confirm: true, payloadHash })), { params: { orderId } })
const pushFresh = async (orderId: string) => push(orderId, (await previewJson(orderId)).payloadHash)
const cancel = async (orderId: string) => postCancel(await req(`${base(orderId)}/cancel`, adminToken, send('POST', { confirm: true })), { params: { orderId } })
const refresh = async (orderId: string) => postRefresh(await req(`${base(orderId)}/refresh`, adminToken, send('POST', {})), { params: { orderId } })
const codes = (issues: { code: string }[]) => issues.map(i => i.code)
const pushRow = (orderId: string) => prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: 'desc' } })

async function makeOrder(opts: { approved?: boolean; country?: string; printWidth?: number; apiMockup?: boolean; number?: string } = {}) {
  seq++
  const id = `gid://test/Order/ckf-${seq}`
  const number = `#${opts.number ?? `CKF${1000 + seq}`}`
  const lineId = `ckfl-${seq}`
  const country = opts.country ?? 'US'
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 39.95, expectedPayout: 38, totalFees: 1.95, refundedAmount: 0, placedAt: new Date('2026-11-15T19:28:06Z'),
      pipelineStatus: 'READY_TO_PRODUCTION', orderType: 'NON_CUSTOM', designReady: opts.approved !== false,
      customerEmail: 'sal@example.com', customerName: 'Sal Paint', shippingName: 'Sal Paint', shippingAddress1: '12 Main St', shippingAddress2: 'Apt 4',
      shippingCity: country === 'US' ? 'Denver' : 'London', shippingZip: country === 'US' ? '80202' : 'SW1A 1AA',
      shippingPhone: country === 'US' ? '+1 303 555 0100' : '+44 20 7946 0000', shippingCountry: country, shippingState: country === 'US' ? 'Colorado' : null,
      lines: { create: [{
        shopifyLineId: lineId, productTitle: 'Happiness Is a Warm Hug Scarf', variantTitle: 'Coral Pink', qty: 1, linePosition: 1, unitPrice: 39.95,
        resolvedSupplierId: SUP, resolvedSupplierSku: SKU, customized: false, imageUrl: 'https://cdn.shopify.com/s/files/scarf.jpg',
        designDriveLink: opts.approved === false ? null : '/api/design-studio/file/placeholder', designNote: 'internal CS note',
      }] },
      designTasks: { create: [{ shopifyLineId: lineId, taskKey: `CKF${1000 + seq}_1`, status: opts.approved === false ? 'REVIEW' : 'DONE' }] },
    },
  })
  await prisma.designArtwork.create({
    data: {
      orderId: id, shopifyLineId: lineId, printArea: 'Print', version: 1, fileName: 'print.jpg', storagePath: `design/ckf-${seq}/print.jpg`,
      size: 1000, mimeType: 'image/jpeg', widthPx: opts.printWidth ?? 15412, heightPx: 5744,
    },
  })
  await prisma.designArtwork.create({
    data: {
      orderId: id, shopifyLineId: lineId, printArea: 'Preview', kind: 'MOCKUP', version: 1, fileName: 'mockup.jpg', storagePath: `design/ckf-${seq}/mockup.jpg`,
      size: 500, mimeType: 'image/jpeg', widthPx: 1254, heightPx: 1254,
    },
  })
  return { id, number: number.replace('#', '') }
}

const setting = (key: string, value: string) => prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
const saveCreds = () => Promise.all([setting(CATKISSFISH_KEYS.clientId, CLIENT_ID), setting(CATKISSFISH_KEYS.clientSecret, SECRET)])
const clearCreds = () => prisma.appSetting.deleteMany({ where: { key: { in: Object.values(CATKISSFISH_KEYS) } } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await setCsvLocked(false)
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'CKF', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'catkissfish' }, create: { id: SUP, name: 'CatKissFish', code: 'catkissfish' }, update: {} })
  const template = await prisma.printTemplate.create({
    data: { supplierId: SUP, supplierSku: SKU, name: 'Khăn len 35x193', widthPx: 15412, heightPx: 5744, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 15412, h: 5744 }]) },
  })
  // As on prod: the "SKU API" still repeats the tool SKU, and the blank's color and size sit on the variant columns.
  await prisma.supplierProduct.create({
    data: { supplierId: SUP, sku: SKU, apiSku: SKU, productName: 'Knit Scarf', variant1Name: 'Size', variant1Value: 'Unisize', variant2Name: 'Color', variant2Value: 'white', baseCost: 13.15, printTemplateId: template.id },
  })
  const adminId = (await prisma.appUser.upsert({ where: { email: 'admin@ckf.test' }, create: { name: 'Admin', email: 'admin@ckf.test', role: 'ADMIN', permissions: JSON.stringify([]), passwordHash: 'x' }, update: {} })).id
  adminToken = await signToken({ userId: adminId, email: 'admin@ckf.test', name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
  const superId = (await prisma.appUser.upsert({ where: { email: 'super@ckf.test' }, create: { name: 'Super', email: 'super@ckf.test', role: 'SUPERADMIN', permissions: JSON.stringify([]), passwordHash: 'x' }, update: {} })).id
  superToken = await signToken({ userId: superId, email: 'super@ckf.test', name: 'Super', role: 'SUPERADMIN', permissions: [], tv: 0 })
})

afterAll(async () => {
  await clearCreds()
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['admin@ckf.test', 'super@ckf.test'] } } })
  delete process.env.NEXT_PUBLIC_APP_URL
})

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = APP_URL
  await clearCreds()
  await saveCreds()
  calls = []
  remoteOrders = new Map()
  tokensIssued = 0
  dimensions = []
  handler = defaultHandler
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin !== ORIGIN) throw new Error(`test blocked a call to ${url.origin}`)
    const call: Call = { path: url.pathname, query: url.searchParams, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body }
    calls.push(call)
    const reply = handler(call)
    if (reply === 'network-error') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('CatKissFish preview', () => {
  it('builds the scarf order from the supplier SKU, not from the Shopify design variant', async () => {
    const o = await makeOrder()
    const p = await previewJson(o.id)
    expect(p.canPush).toBe(true)
    expect(p.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(p.payload.platformOrderId).toBe(o.number)
    expect(p.payload.shippingId).toBe('90JFKFC')
    const [info] = p.payload.designInfos
    expect(info).toMatchObject({ styleCode: STYLE, customSku: `${o.number}_1`, customerSku: `${o.number}_1`, color: 'white', size: 'Unisize', quantity: 1 })
    expect(info.designList).toEqual([{ imageUrl: expect.stringMatching(`^${APP_URL}/api/public/artwork/.+`) }])
    expect(info.mockupList).toEqual([{ imageUrl: expect.stringMatching(`^${APP_URL}/api/public/artwork/.+`) }])
    expect(p.payload.shippingAddress).toEqual({
      userName: 'Sal Paint', country: 'US', countryAbbreviation: 'US', province: 'CO', city: 'Denver', detailAddress: '12 Main St, Apt 4', postalCode: '80202', countryCode: '+1', phone: '3035550100',
    })
    expect(p.lines[0]).toMatchObject({ apiSku: STYLE, shipClass: 'USPS' })
    expect(creates()).toHaveLength(0)
  })

  it('keeps the internal note out of the order and says so', async () => {
    const p = await previewJson((await makeOrder()).id)
    expect(JSON.stringify(p.payload)).not.toContain('internal CS note')
    expect(codes(p.issues)).toContain('DESIGN_NOTE')
  })

  it('puts the file on the design area when the style names one', async () => {
    dimensions = [{ fieldName: 'Design_1', name: 'Scarf', supportUploadFormat: '0,1' }]
    const p = await previewJson((await makeOrder()).id)
    expect(p.payload.designInfos[0].designList[0].printableDesignArea).toBe('Design_1')
  })

  it('sends the scarf file on the area the live API names "1"', async () => {
    dimensions = [{ type: 1, supportUploadFormat: '0,1', name: 'Scarf', fieldName: '1' }]
    const p = await previewJson((await makeOrder()).id)
    expect(p.payload.designInfos[0].designList).toEqual([{ printableDesignArea: '1', imageUrl: expect.stringContaining('/api/public/artwork/') }])
  })

  it('leaves the carrier to CatKissFish when set to choose itself', async () => {
    await setting(CATKISSFISH_KEYS.shippingId, 'AUTO')
    const p = await previewJson((await makeOrder()).id)
    expect(p.canPush).toBe(true)
    expect(p.payload).not.toHaveProperty('shippingId')
    expect(p.lines[0].shipClass).toBe('CatKissFish tự chọn')
  })

  it('warns when the design area does not name the format of the file', async () => {
    dimensions = [{ fieldName: 'Design_1', name: 'Scarf', supportUploadFormat: '0' }]
    const p = await previewJson((await makeOrder()).id)
    expect(p.issues.find((i: any) => i.code === 'CKF_FILE_FORMAT')).toMatchObject({ level: 'warning' })
  })

  it('without a key says so and calls nothing', async () => {
    await clearCreds()
    const p = await previewJson((await makeOrder()).id)
    expect(p.canPush).toBe(false)
    expect(codes(p.issues)).toContain('NO_CREDENTIALS')
    expect(calls).toHaveLength(0)
  })

  it('blocks a design not approved yet and gives out no file link', async () => {
    const p = await previewJson((await makeOrder({ approved: false })).id)
    expect(p.canPush).toBe(false)
    expect(codes(p.issues)).toContain('NOT_APPROVED')
    expect(JSON.stringify(p.payload)).not.toContain('/api/public/artwork/')
  })

  it('blocks a print file off the scarf template size', async () => {
    const p = await previewJson((await makeOrder({ printWidth: 2067 })).id)
    expect(p.canPush).toBe(false)
    expect(p.issues.find((i: any) => i.code === 'SIZE_MISMATCH')).toMatchObject({ level: 'error' })
  })

  it('holds an order outside the US until a carrier is chosen, then sends the email the carrier may need', async () => {
    const o = await makeOrder({ country: 'GB' })
    const before = await previewJson(o.id)
    expect(before.canPush).toBe(false)
    expect(before.issues.find((i: any) => i.code === 'SHIP_METHOD').message).toContain('ngoài Mỹ')
    await setting(CATKISSFISH_KEYS.shippingIdIntl, '60VQCAA')
    const after = await previewJson(o.id)
    expect(after.canPush).toBe(true)
    expect(after.payload.shippingId).toBe('60VQCAA')
    expect(after.payload.shippingAddress).toMatchObject({ countryAbbreviation: 'GB', province: 'London', countryCode: '+44', phone: '2079460000', email: 'sal@example.com' })
    expect(codes(after.issues)).toContain('ADDRESS_STATE')
  })

  it('blocks when CatKissFish does not know the style', async () => {
    handler = c => c.path.endsWith('/products/detail') ? refused(404, 'style not found') : defaultHandler(c)
    const p = await previewJson((await makeOrder()).id)
    expect(p.canPush).toBe(false)
    expect(p.issues.find((i: any) => i.code === 'CKF_PRODUCT').message).toContain('style not found')
  })
})

describe('CatKissFish push', () => {
  it('creates the order, keeps its id and state, and marks the line exported', async () => {
    const o = await makeOrder()
    const p = await previewJson(o.id)
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.exported).toBe(true)
    expect(body.push).toMatchObject({ status: 'CREATED', supplierOrderCode: remoteOrders.get(o.number)!.id, remoteStatus: 'Chưa thanh toán' })
    expect(creates()).toHaveLength(1)
    expect(JSON.parse(String(creates()[0].body))).toEqual(p.payload)
    expect(creates()[0].headers['access-token']).toBe('tok-1')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { lines: true } })
    expect(order.pipelineStatus).toBe('EXPORTED')
    expect(order.supplierHandoffMode).toBe('API')
    expect(order.lines[0].exportedToSupplierId).toBe(SUP)
  })

  it('touches no payment: only product, order and token calls go out', async () => {
    const o = await makeOrder()
    await pushFresh(o.id)
    const paths = Array.from(new Set(calls.map(c => c.path.replace(API, ''))))
    expect(paths.sort()).toEqual(['/order/create/auto/design/order', '/order/list', '/products/auto/design/list', '/products/detail', '/website/oauth2/client_token'].sort())
  })

  it('reuses the token for the 2 hours it lasts', async () => {
    const o = await makeOrder()
    await previewJson(o.id)
    await pushFresh(o.id)
    expect(tokensIssued).toBe(1)
  })

  it('asks for a new token when the saved one is about to expire', async () => {
    await setting(CATKISSFISH_KEYS.accessToken, 'old')
    await setting(CATKISSFISH_KEYS.tokenExpiresAt, new Date(Date.now() + 60_000).toISOString())
    expect(await catkissfishSession(await getCatkissfishSettings()).token()).toBe('tok-1')
    await setting(CATKISSFISH_KEYS.tokenExpiresAt, new Date(Date.now() + 3600_000).toISOString())
    expect(await catkissfishSession(await getCatkissfishSettings()).token()).toBe('tok-1')
    expect(tokensIssued).toBe(1)
  })

  it('never sends the same order twice', async () => {
    const o = await makeOrder()
    const { payloadHash } = await previewJson(o.id)
    expect((await push(o.id, payloadHash)).status).toBe(200)
    const again = await push(o.id, payloadHash)
    expect(again.status).toBe(409)
    expect(creates()).toHaveLength(1)
  })

  it('refuses when the order changed after the preview', async () => {
    const o = await makeOrder()
    const res = await push(o.id, 'stale-hash')
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PAYLOAD_CHANGED')
    expect(creates()).toHaveLength(0)
  })

  it('links an order CatKissFish already holds under this number instead of making a second one', async () => {
    const o = await makeOrder()
    remoteOrders.set(o.number, { id: 'EXISTING', state: 2, tracking: [] })
    const body = await (await pushFresh(o.id)).json()
    expect(body.push).toMatchObject({ status: 'CREATED', supplierOrderCode: 'EXISTING', remoteStatus: 'Chờ sản xuất' })
    expect(creates()).toHaveLength(0)
  })

  it('sends nothing when it cannot check for a duplicate, and a retry works', async () => {
    const o = await makeOrder()
    const { payloadHash } = await previewJson(o.id)
    handler = c => c.path.endsWith('/order/list') ? 'network-error' : defaultHandler(c)
    const res = await push(o.id, payloadHash)
    expect(res.status).toBe(504)
    expect((await res.json()).code).toBe('CHECK_FAILED')
    expect(creates()).toHaveLength(0)
    expect((await pushRow(o.id)).status).toBe('FAILED')
    handler = defaultHandler
    expect((await push(o.id, payloadHash)).status).toBe(200)
    expect(creates()).toHaveLength(1)
  })

  it('records a refusal, leaves the order open, and retries under the same number', async () => {
    const o = await makeOrder()
    const { payloadHash } = await previewJson(o.id)
    handler = c => c.path.endsWith('/order/create/auto/design/order') ? refused(5001, 'Bad address') : defaultHandler(c)
    const res = await push(o.id, payloadHash)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Bad address')
    expect(await pushRow(o.id)).toMatchObject({ status: 'FAILED', activeKey: null, exportMarked: false })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
    handler = defaultHandler
    const retried = await (await push(o.id, payloadHash)).json()
    expect(retried.push).toMatchObject({ status: 'CREATED', externalOrderId: o.number })
  })

  it('says a carrier refusal created nothing, and a retry after changing the carrier goes out', async () => {
    const o = await makeOrder()
    handler = c => c.path.endsWith('/order/create/auto/design/order') && JSON.parse(String(c.body)).shippingId === '90JFKFC'
      ? refused(1000, 'The selected logistics ID does not support all required logistics channels') : defaultHandler(c)
    const res = await pushFresh(o.id)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Đổi cách ship')
    await setting(CATKISSFISH_KEYS.shippingId, 'AUTO')
    const body = await (await pushFresh(o.id)).json()
    expect(body.push).toMatchObject({ status: 'CREATED', externalOrderId: o.number })
    expect(remoteOrders.size).toBe(1)
  })

  it('on no answer holds the send, and a refresh finds the order that did land', async () => {
    const o = await makeOrder()
    const { payloadHash } = await previewJson(o.id)
    handler = c => {
      if (!c.path.endsWith('/order/create/auto/design/order')) return defaultHandler(c)
      defaultHandler(c)
      return 'network-error'
    }
    const res = await push(o.id, payloadHash)
    expect(res.status).toBe(504)
    expect((await res.json()).code).toBe('UNKNOWN_RESULT')
    expect((await pushRow(o.id)).status).toBe('SENDING')
    handler = defaultHandler
    expect((await push(o.id, payloadHash)).status).toBe(409)
    expect(creates().length).toBe(1)
    const refreshed = await (await refresh(o.id)).json()
    expect(refreshed).toMatchObject({ found: true, push: { status: 'CREATED', supplierOrderCode: remoteOrders.get(o.number)!.id } })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('EXPORTED')
  })

  it('frees the order once CatKissFish still has nothing after the grace time', async () => {
    const o = await makeOrder()
    const { payloadHash } = await previewJson(o.id)
    handler = c => c.path.endsWith('/order/create/auto/design/order') ? 'network-error' : defaultHandler(c)
    await push(o.id, payloadHash)
    handler = defaultHandler
    expect(await (await refresh(o.id)).json()).toMatchObject({ found: false, push: { status: 'SENDING' } })
    const row = await pushRow(o.id)
    await prisma.supplierOrderPush.update({ where: { id: row.id }, data: { pushedAt: new Date(Date.now() - 10 * 60_000) } })
    expect(await (await refresh(o.id)).json()).toMatchObject({ found: false, push: { status: 'FAILED' } })
  })

  it('keeps the id the create answered with when the lookup after it fails, and gets the state on refresh', async () => {
    const o = await makeOrder()
    const { payloadHash } = await previewJson(o.id)
    let lists = 0
    handler = c => c.path.endsWith('/order/list') && ++lists > 1 ? 'network-error' : defaultHandler(c)
    const body = await (await push(o.id, payloadHash)).json()
    expect(body.push).toMatchObject({ status: 'CREATED', supplierOrderCode: remoteOrders.get(o.number)!.id, remoteStatus: null })
    handler = defaultHandler
    expect((await (await refresh(o.id)).json()).push.remoteStatus).toBe('Chưa thanh toán')
  })
})

describe('CatKissFish tracking', () => {
  async function sent() {
    const o = await makeOrder()
    await pushFresh(o.id)
    return { ...o, remote: remoteOrders.get(o.number)! }
  }
  const shipments = (orderId: string) => prisma.shipment.findMany({ where: { orderId } })

  it('does not read tracking before the parcel leaves', async () => {
    const o = await sent()
    o.remote.state = 3
    o.remote.tracking = [tracking('9400')]
    expect(await (await refresh(o.id)).json()).toMatchObject({ found: true, shipments: 0, push: { remoteStatus: 'Đang sản xuất' } })
    expect(callsTo('/tracking/number')).toHaveLength(0)
    expect(await shipments(o.id)).toHaveLength(0)
  })

  it('writes the tracking on the line, where Auto Fulfilled takes it from', async () => {
    const o = await sent()
    o.remote.state = 4
    o.remote.tracking = [tracking('9400111')]
    expect(await (await refresh(o.id)).json()).toMatchObject({ shipments: 1, push: { remoteStatus: 'Đã gửi hàng' } })
    expect(await shipments(o.id)).toEqual([expect.objectContaining({ lineKey: `${o.number}_1`, trackingNumber: '9400111', carrier: 'USPS', supplierId: SUP })])
    const rows = await pushedShipmentRows(storeId)
    expect(rows.get(o.number)).toEqual([{ lineKey: `${o.number}_1`, tracking: '9400111' }])
  })

  it('does not guess between several tracking numbers', async () => {
    const o = await sent()
    o.remote.state = 4
    o.remote.tracking = [tracking('A1'), tracking('B2')]
    const body = await (await refresh(o.id)).json()
    expect(body.shipments).toBe(0)
    expect(body.push.error).toContain('2 mã tracking')
    expect(await shipments(o.id)).toHaveLength(0)
  })

  it('reports an order cancelled on CatKissFish and writes no tracking', async () => {
    const o = await sent()
    o.remote.state = 6
    o.remote.tracking = [tracking('9400')]
    const body = await (await refresh(o.id)).json()
    expect(body.push).toMatchObject({ status: 'CREATED', remoteStatus: 'Đã huỷ' })
    expect(body.push.error).toContain('bấm Huỷ')
    expect(await shipments(o.id)).toHaveLength(0)
  })

  it('syncs every open push, and one failure does not stop the next', async () => {
    const a = await sent()
    const b = await sent()
    a.remote.state = 4
    b.remote.state = 4
    b.remote.tracking = [tracking('B-TRACK')]
    handler = c => c.path.endsWith('/order/detail') && c.query.get('id') === a.remote.id ? 'network-error' : defaultHandler(c)
    const r = await syncCatkissfishTracking()
    expect(r).toMatchObject({ found: 1, shipments: 1 })
    expect((await shipments(b.id))[0].trackingNumber).toBe('B-TRACK')
  })

  it('is part of the supplier tracking run, and skips quietly without a key', async () => {
    await clearCreds()
    const all = await syncApiSupplierTracking()
    expect(all.find(r => r.name === 'CatKissFish')).toMatchObject({ skipped: 'no CatKissFish account' })
    expect(calls).toHaveLength(0)
  })
})

describe('CatKissFish cancel', () => {
  it('cancels by CatKissFish id and puts the order back in the queue', async () => {
    const o = await makeOrder()
    await pushFresh(o.id)
    const remote = remoteOrders.get(o.number)!
    const body = await (await cancel(o.id)).json()
    expect(body).toMatchObject({ exportReverted: true, push: { status: 'CANCELLED' } })
    expect(callsTo('/order/cancel')[0].query.get('id')).toBe(remote.id)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { lines: true } })
    expect(order.pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect(order.lines[0].exportedAt).toBeNull()
  })

  it('closes the push without another call when CatKissFish already cancelled it', async () => {
    const o = await makeOrder()
    await pushFresh(o.id)
    remoteOrders.get(o.number)!.state = 6
    expect((await cancel(o.id)).status).toBe(200)
    expect(callsTo('/order/cancel')).toHaveLength(0)
  })

  it('keeps the push when CatKissFish refuses the cancel', async () => {
    const o = await makeOrder()
    await pushFresh(o.id)
    handler = c => c.path.endsWith('/order/cancel') ? refused(9, 'already in production') : defaultHandler(c)
    const res = await cancel(o.id)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('already in production')
    expect((await pushRow(o.id)).status).toBe('CREATED')
  })

  it('sends the order again under a new number after a cancel', async () => {
    const o = await makeOrder()
    await pushFresh(o.id)
    await cancel(o.id)
    const p = await previewJson(o.id)
    expect(p.payload.platformOrderId).toBe(`${o.number}-R2`)
    expect(p.canPush).toBe(true)
  })
})

describe('CatKissFish settings', () => {
  const put = async (token: string, body: unknown) => putSettingsRoute(await req(SETTINGS, token, send('PUT', body)))
  const get = async () => (await getSettingsRoute(await req(SETTINGS, adminToken))).json()
  const check = async () => postSettingsTest(await req(`${SETTINGS}/test`, adminToken, send('POST', {})))

  it('shows the key only masked and never the secret or token', async () => {
    await setting(CATKISSFISH_KEYS.accessToken, 'live-token-value')
    const view = await get()
    expect(view).toMatchObject({ hasClientId: true, clientIdMasked: 'CLIE…3456', hasClientSecret: true, shippingId: '90JFKFC', shippingIdIntl: null })
    expect(view.skus).toEqual([{ sku: SKU, styleCode: STYLE }])
    const text = JSON.stringify(view)
    for (const hidden of [SECRET, CLIENT_ID, 'live-token-value']) expect(text).not.toContain(hidden)
  })

  it('only a superadmin saves', async () => {
    expect((await put(adminToken, { clientId: 'x', clientSecret: 'y' })).status).toBe(403)
    expect((await getCatkissfishSettings()).clientId).toBe(CLIENT_ID)
  })

  it('keeps the stored key when the fields are left blank, and drops the old token when it changes', async () => {
    await setting(CATKISSFISH_KEYS.accessToken, 'old-token')
    expect((await put(superToken, { clientId: '', clientSecret: '', shippingIdIntl: 'YUNTU' })).status).toBe(200)
    expect(await getCatkissfishSettings()).toMatchObject({ clientId: CLIENT_ID, clientSecret: SECRET, accessToken: 'old-token', shippingIdIntl: '60VQCAA' })
    await put(superToken, { clientSecret: 'new-secret' })
    expect(await getCatkissfishSettings()).toMatchObject({ clientSecret: 'new-secret', accessToken: null })
  })

  it('accepts letting CatKissFish choose the carrier', async () => {
    expect((await put(superToken, { shippingId: 'AUTO' })).status).toBe(200)
    expect((await getCatkissfishSettings()).shippingId).toBe('AUTO')
  })

  it('refuses a carrier CatKissFish does not have', async () => {
    expect((await put(superToken, { shippingId: 'Overnight' })).status).toBe(400)
  })

  it('tests the key with a fresh token, reads the style and creates nothing', async () => {
    await setting(CATKISSFISH_KEYS.accessToken, 'old')
    await setting(CATKISSFISH_KEYS.tokenExpiresAt, new Date(Date.now() + 3600_000).toISOString())
    const res = await check()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, styles: [{ styleCode: STYLE, name: 'Custom Unisex Knit Scarf', colors: ['white'], sizes: ['Unisize'], error: null }] })
    expect(tokensIssued).toBe(1)
    expect(creates()).toHaveLength(0)
  })

  it('reports a wrong key without repeating it', async () => {
    handler = c => c.path.endsWith('/oauth2/client_token') ? { status: 200, json: { code: 10000, message: `bad ${SECRET}` } } : defaultHandler(c)
    const res = await check()
    expect(res.status).toBe(502)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('Open API')
    expect(text).not.toContain(SECRET)
  })

  it('counts the orders still waiting for payment on CatKissFish', async () => {
    const before = (await get()).unpaidOrders
    const o = await makeOrder()
    await pushFresh(o.id)
    expect((await get()).unpaidOrders).toBe(before + 1)
    remoteOrders.get(o.number)!.state = 2
    await refresh(o.id)
    expect((await get()).unpaidOrders).toBe(before)
  })
})

describe('CatKissFish in the supplier handoff', () => {
  it('stays on CSV until the key is saved, then goes by API only', async () => {
    const o = await makeOrder()
    await clearCreds()
    expect(await handoffStateFor(o.id)).toMatchObject({ mode: 'CSV', apiOpenKind: null })
    await saveCreds()
    expect(await handoffStateFor(o.id)).toMatchObject({ mode: 'API', apiKind: 'catkissfish', apiName: 'CatKissFish', apiOpenKind: 'catkissfish' })
    await expect(handoffOrderCsv(o.id, null)).rejects.toMatchObject({ code: 'CATKISSFISH_API_ONLY' })
  })
})
