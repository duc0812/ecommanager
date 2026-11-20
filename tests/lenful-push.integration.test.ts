import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { setCsvLocked } from '@/lib/csv-lock'
import { handoffOrderCsv, handoffStateFor } from '@/lib/supplier-handoff'
import { pushedShipmentRows } from '@/lib/fulfillment/auto-fulfill'
import { findLenfulSupplier, syncLenfulTracking } from '@/lib/repos/lenful-push'
import { syncApiSupplierTracking } from '@/lib/repos/supplier-tracking-sync'
import { LENFUL_KEYS, getLenfulSettings } from '@/lib/lenful-settings'
import { vietnamDay } from '@/lib/lenful'
import { GET as getPreview } from '@/app/api/fulfillment/lenful/orders/[orderId]/preview/route'
import { POST as postPush } from '@/app/api/fulfillment/lenful/orders/[orderId]/push/route'
import { POST as postCancel } from '@/app/api/fulfillment/lenful/orders/[orderId]/cancel/route'
import { POST as postRefresh } from '@/app/api/fulfillment/lenful/orders/[orderId]/refresh/route'
import { GET as getSettingsRoute, PUT as putSettingsRoute } from '@/app/api/fulfillment/lenful/settings/route'
import { POST as postSettingsTest } from '@/app/api/fulfillment/lenful/settings/test/route'
import { GET as getSkuMap } from '@/app/api/fulfillment/lenful/sku-map/route'

const SHOP = 'lfstore.myshopify.com'
const PROJECT = 'proj_lf'
const SUP = 'sup_lf'
const SUP_OLD = 'sup_lf_old'
const SKU = 'LFUA47WLNO'
const LF_SKU = 'LF-USTSHIRT-WHITEL'
const PRODUCT_ID = '11111111-2222-4333-8444-555555555555'
const ORIGIN = 'https://seller-v8.lenful.com'
const API = '/api/public/v1'
const APP_URL = 'https://tool.shop-example.com'
const KEY = 'lf_live_secret_key_value_123456'
const STORE_ID = '9a7b3c1e-2d4f-4a6b-8c9d-0e1f2a3b4c5d'

let storeId = ''
let adminToken = ''
let superToken = ''
let seq = 0

type Call = { path: string; query: URLSearchParams; method: string; headers: Record<string, string>; body: any }
type Reply = { status: number; json: unknown } | 'network-error'
type RemoteItem = { id: string; sku: string; quantity: number; workflow_status: string; item_revenue: number }
type RemoteOrder = {
  id: string; code: string; store: string; external_order_id: string; workflow_status: string; payment_status: string
  revenue_total: number; items: RemoteItem[]; trackings: { order_item_id: string; carrier: string; tracking_number: string; status: string; is_current: boolean }[]
}
let calls: Call[] = []
let handler: (call: Call) => Reply
let remote: RemoteOrder[] = []
let nextId = 1
let product: { id: string; name: string; type: string; print_positions: { code: string; label: string; is_primary: boolean }[] }

const ok = (data: unknown, status = 200): Reply => ({ status, json: { success: true, message: 'ok', data } })
const fail = (status: number, message: string, data: unknown = null): Reply => ({ status, json: { success: false, message, data } })
const orderJson = (o: RemoteOrder) => ({
  id: o.id, code: o.code, store_id: o.store, external_order_id: o.external_order_id, workflow_status: o.workflow_status,
  payment_status: o.payment_status, revenue_total: o.revenue_total, currency: 'USD', created_at: '2026-11-20T09:00:00Z', items: o.items,
})
const byId = (id: string) => remote.find(o => o.id === id)

function defaultHandler(call: Call): Reply {
  if (call.headers.Authorization !== `Bearer ${KEY}`) return { status: 401, json: { error: true, statusCode: 401, statusMessage: 'Server Error', message: 'Invalid API key' } }
  const p = call.path.replace(API, '')
  if (p === '/stores') return ok({ items: [{ id: STORE_ID, name: 'Default store', platform: 'manual', is_default: true, status: 'connected' }] })
  if (p === '/wallet') return ok({ balance: 12345, currency: 'USD' })
  if (p === '/products/list') {
    const q = String(call.body?.q ?? '').toLowerCase()
    const hit = q && (LF_SKU.toLowerCase().includes(q) || product.name.toLowerCase().includes(q))
    return ok({ items: hit ? [product] : [], total: hit ? 1 : 0, page: 1, limit: 100 })
  }
  if (p === `/products/${PRODUCT_ID}/variants`) {
    return ok({ items: [
      { id: 'v1', sku: LF_SKU, list_price: 950, attributes: { size: 'L', color: 'white' } },
      { id: 'v2', sku: 'LF-USTSHIRT-WHITEM', list_price: 950, attributes: { size: 'M', color: 'white' } },
    ] })
  }
  if (p === '/orders' && call.method === 'POST') {
    const b = call.body
    const store = b.store_id ?? STORE_ID
    const existing = remote.find(o => o.store === store && o.external_order_id === b.external_order_id)
    if (existing) return { status: 409, json: { success: false, message: 'Order already exists', data: orderJson(existing) } }
    const n = nextId++
    const o: RemoteOrder = {
      id: `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`, code: `LF-2026-${String(n).padStart(6, '0')}`, store, external_order_id: b.external_order_id,
      workflow_status: 'pending', payment_status: 'paid', revenue_total: 1450,
      items: b.line_items.map((li: any, i: number) => ({ id: `item-${n}-${i}`, sku: li.sku, quantity: li.quantity, workflow_status: 'pending', item_revenue: 1450 })),
      trackings: [],
    }
    remote.push(o)
    return ok(orderJson(o), 201)
  }
  if (p === '/orders' && call.method === 'GET') {
    const store = call.query.get('store_id')
    return ok({ items: remote.filter(o => !store || o.store === store).map(orderJson).reverse(), page: 1, limit: 100, total: remote.length, totalPages: 1 })
  }
  const one = p.match(/^\/orders\/([^/]+)(\/[a-z]+)?$/)
  if (one) {
    const o = byId(decodeURIComponent(one[1]))
    if (!o) return fail(404, 'Order not found')
    if (!one[2]) return ok(orderJson(o))
    if (one[2] === '/cancel') {
      for (const i of o.items) if (i.workflow_status === 'pending') i.workflow_status = 'cancel'
      if (o.items.every(i => i.workflow_status === 'cancel')) o.workflow_status = 'cancel'
      return ok(orderJson(o))
    }
    if (one[2] === '/trackings') return ok({ items: o.trackings })
  }
  return { status: 404, json: { success: false, message: `unexpected path in test: ${call.method} ${p}` } }
}

const callsTo = (method: string, suffix: string | RegExp) => calls.filter(c => c.method === method && (typeof suffix === 'string' ? c.path.endsWith(suffix) : suffix.test(c.path)))
const creates = () => calls.filter(c => c.method === 'POST' && c.path === `${API}/orders`)

async function req(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

const send = (method: string, body: unknown) => ({ method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const base = (orderId: string) => `http://x/api/fulfillment/lenful/orders/${encodeURIComponent(orderId)}`
const SETTINGS = 'http://x/api/fulfillment/lenful/settings'
const preview = async (orderId: string) => getPreview(await req(`${base(orderId)}/preview`, adminToken), { params: { orderId } })
const previewJson = async (orderId: string) => (await preview(orderId)).json()
const push = async (orderId: string, payloadHash: string) =>
  postPush(await req(`${base(orderId)}/push`, adminToken, send('POST', { confirm: true, payloadHash })), { params: { orderId } })
const pushFresh = async (orderId: string) => push(orderId, (await previewJson(orderId)).payloadHash)
const cancel = async (orderId: string) => postCancel(await req(`${base(orderId)}/cancel`, adminToken, send('POST', { confirm: true })), { params: { orderId } })
const refresh = async (orderId: string) => postRefresh(await req(`${base(orderId)}/refresh`, adminToken, send('POST', {})), { params: { orderId } })
const codes = (issues: { code: string }[]) => issues.map(i => i.code)
const pushRow = (orderId: string) => prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: 'desc' } })

async function makeOrder(opts: { approved?: boolean; country?: string; lines?: number; number?: string; areas?: string[] } = {}) {
  seq++
  const id = `gid://test/Order/lf-${seq}`
  const number = `#${opts.number ?? `LF${1000 + seq}`}`
  const country = opts.country ?? 'US'
  const count = opts.lines ?? 1
  const lineIds = Array.from({ length: count }, (_, i) => `lfl-${seq}-${i + 1}`)
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 29.95, expectedPayout: 28, totalFees: 1.95, refundedAmount: 0, placedAt: new Date('2026-11-19T19:28:06Z'),
      pipelineStatus: 'READY_TO_PRODUCTION', orderType: 'NON_CUSTOM', designReady: opts.approved !== false,
      customerEmail: 'jo@example.com', customerName: 'Jo Doe', shippingName: 'Jo Doe', shippingAddress1: '12 Main St', shippingAddress2: 'Apt 4',
      shippingCity: country === 'US' ? 'Denver' : 'Toronto', shippingZip: country === 'US' ? '80202' : 'M5V 2T6',
      shippingPhone: '+1 303 555 0100', shippingCountry: country, shippingState: country === 'US' ? 'Colorado' : null,
      lines: { create: lineIds.map((lineId, i) => ({
        shopifyLineId: lineId, productTitle: `Jeep Girl Tee ${i + 1}`, variantTitle: 'Adult / L', qty: 1, linePosition: i + 1, unitPrice: 29.95,
        resolvedSupplierId: SUP, resolvedSupplierSku: SKU, customized: false, imageUrl: 'https://cdn.shopify.com/s/files/tee.jpg',
        designDriveLink: opts.approved === false ? null : '/api/design-studio/file/placeholder', designNote: i === 0 ? 'internal CS note' : null,
      })) },
      designTasks: { create: lineIds.map((lineId, i) => ({ shopifyLineId: lineId, taskKey: `LF${1000 + seq}_${i + 1}`, status: opts.approved === false ? 'REVIEW' : 'DONE' })) },
    },
  })
  for (const lineId of lineIds) {
    for (const area of opts.areas ?? ['Front', 'Back']) {
      await prisma.designArtwork.create({
        data: {
          orderId: id, shopifyLineId: lineId, printArea: area, version: 1, fileName: `${area.toLowerCase()}.png`, storagePath: `design/lf-${seq}/${lineId}-${area}.png`,
          size: 1000, mimeType: 'image/png', widthPx: 4200, heightPx: 4800,
        },
      })
    }
    await prisma.designArtwork.create({
      data: {
        orderId: id, shopifyLineId: lineId, printArea: 'Preview', kind: 'MOCKUP', version: 1, fileName: 'mockup.jpg', storagePath: `design/lf-${seq}/${lineId}-mockup.jpg`,
        size: 500, mimeType: 'image/jpeg', widthPx: 1200, heightPx: 1200,
      },
    })
  }
  return { id, number: number.replace('#', ''), lineIds }
}

const setting = (key: string, value: string) => prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
const saveKey = () => setting(LENFUL_KEYS.apiKey, KEY)
const clearSettings = () => prisma.appSetting.deleteMany({ where: { key: { in: Object.values(LENFUL_KEYS) } } })
const setApiSku = (apiSku: string | null, apiShipClass: string | null = null) =>
  prisma.supplierProduct.updateMany({ where: { supplierId: SUP, sku: SKU }, data: { apiSku, apiShipClass } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await setCsvLocked(false)
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'LF', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  // As on prod: an active "lenful" holding the lines and an older inactive spelling of the same name.
  await prisma.supplier.upsert({ where: { code: 'LENFUL' }, create: { id: SUP_OLD, name: 'Lenful', code: 'LENFUL', isActive: false }, update: {} })
  await prisma.supplier.upsert({ where: { code: 'lenful' }, create: { id: SUP, name: 'lenful', code: 'lenful' }, update: {} })
  const template = await prisma.printTemplate.create({
    data: {
      supplierId: SUP, supplierSku: SKU, name: 'Tee 2 mặt', widthPx: 8400, heightPx: 4800,
      areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 4200, h: 4800 }, { name: 'Back', x: 4200, y: 0, w: 4200, h: 4800 }]),
    },
  })
  await prisma.supplierProduct.create({
    data: { supplierId: SUP, sku: SKU, apiSku: LF_SKU, productName: 'US Unisex T-Shirt 2D', variant1Name: 'Size', variant1Value: 'L', baseCost: 9, printTemplateId: template.id },
  })
  const adminId = (await prisma.appUser.upsert({ where: { email: 'admin@lf.test' }, create: { name: 'Admin', email: 'admin@lf.test', role: 'ADMIN', permissions: JSON.stringify([]), passwordHash: 'x' }, update: {} })).id
  adminToken = await signToken({ userId: adminId, email: 'admin@lf.test', name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
  const superId = (await prisma.appUser.upsert({ where: { email: 'super@lf.test' }, create: { name: 'Super', email: 'super@lf.test', role: 'SUPERADMIN', permissions: JSON.stringify([]), passwordHash: 'x' }, update: {} })).id
  superToken = await signToken({ userId: superId, email: 'super@lf.test', name: 'Super', role: 'SUPERADMIN', permissions: [], tv: 0 })
})

afterAll(async () => {
  await clearSettings()
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP, SUP_OLD] } } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['admin@lf.test', 'super@lf.test'] } } })
  delete process.env.NEXT_PUBLIC_APP_URL
})

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = APP_URL
  await clearSettings()
  await saveKey()
  await setApiSku(LF_SKU)
  calls = []
  remote = []
  nextId = 1
  product = {
    id: PRODUCT_ID, name: 'US Unisex T-Shirt', type: 'pod',
    print_positions: [{ code: 'back', label: 'Back', is_primary: false }, { code: 'front', label: 'Front', is_primary: true }],
  }
  handler = defaultHandler
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin !== ORIGIN) throw new Error(`test blocked a call to ${url.origin}`)
    const raw = init?.body
    const call: Call = { path: url.pathname, query: url.searchParams, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: raw ? JSON.parse(String(raw)) : null }
    calls.push(call)
    const reply = handler(call)
    if (reply === 'network-error') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' } })
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('Lenful supplier', () => {
  it('picks the active "lenful" over the inactive spelling', async () => {
    expect(await findLenfulSupplier()).toMatchObject({ id: SUP, code: 'lenful' })
  })
})

describe('Lenful preview', () => {
  it('builds the order with the Lenful SKU, the primary position first, the mockup and the address', async () => {
    const o = await makeOrder()
    const p = await previewJson(o.id)
    expect(p.canPush).toBe(true)
    expect(p.payload).toMatchObject({
      external_order_id: o.number,
      shipping_address: { name: 'Jo Doe', line1: '12 Main St', line2: 'Apt 4', city: 'Denver', state_code: 'CO', postal: '80202', country_code: 'US', phone: '+1 303 555 0100' },
    })
    expect(p.payload.store_id).toBeUndefined()
    expect(p.payload.shipping_method_code).toBeUndefined()
    const [item] = p.payload.line_items
    expect(item.sku).toBe(LF_SKU)
    expect(item.quantity).toBe(1)
    expect(item.designs.map((d: any) => d.position)).toEqual(['front', 'back'])
    for (const d of item.designs) expect(d.design_url).toMatch(/^https:\/\/tool\.shop-example\.com\/api\/public\/artwork\//)
    expect(item.mockup_urls).toHaveLength(1)
    expect(p.estimate).toMatchObject({ goods: 9.5, wallet: 123.45 })
    expect(p.estimate.note).toContain('1 vùng in thêm')
    expect(p.lines[0]).toMatchObject({ supplierSku: SKU, apiSku: LF_SKU, shipClass: null })
    expect(creates()).toHaveLength(0)
  })

  it('keeps the internal note out of the order and says so', async () => {
    const o = await makeOrder()
    const p = await previewJson(o.id)
    expect(codes(p.issues)).toContain('DESIGN_NOTE')
    expect(JSON.stringify(p.payload)).not.toContain('internal CS note')
  })

  it('sends the store and shipping method saved at Setup, and a SKU method wins over it', async () => {
    await setting(LENFUL_KEYS.storeId, STORE_ID)
    await setting(LENFUL_KEYS.shippingMethodCode, '0')
    const o = await makeOrder()
    expect((await previewJson(o.id)).payload).toMatchObject({ store_id: STORE_ID, shipping_method_code: 0 })
    await setApiSku(LF_SKU, '3')
    const p = await previewJson(o.id)
    expect(p.payload.shipping_method_code).toBe(3)
    expect(p.lines[0]).toMatchObject({ shipClass: '3', shipClassSource: 'product' })
  })

  it('refuses a shipping method that is not a Lenful code', async () => {
    await setApiSku(LF_SKU, 'Express')
    const o = await makeOrder()
    expect(codes((await previewJson(o.id)).issues)).toContain('SHIP_METHOD')
  })

  it('without a key says so and calls nothing', async () => {
    await clearSettings()
    const o = await makeOrder()
    const p = await previewJson(o.id)
    expect(p.canPush).toBe(false)
    expect(codes(p.issues)).toContain('NO_CREDENTIALS')
    expect(calls).toHaveLength(0)
  })

  it('blocks a tool SKU with no Lenful SKU, with no fallback to the tool SKU', async () => {
    await setApiSku(null)
    const o = await makeOrder()
    const p = await previewJson(o.id)
    expect(codes(p.issues)).toContain('NO_API_SKU')
    expect(p.canPush).toBe(false)
  })

  it('blocks a Lenful SKU the catalog does not have', async () => {
    await setApiSku('LF-NOPE-XL')
    const o = await makeOrder()
    const p = await previewJson(o.id)
    expect(p.issues.find((i: any) => i.code === 'LF_SKU').message).toContain('LF-NOPE-XL')
  })

  it('blocks a print part Lenful has no position for', async () => {
    product.print_positions = [{ code: 'front', label: 'Front', is_primary: true }]
    const o = await makeOrder()
    const p = await previewJson(o.id)
    expect(p.issues.find((i: any) => i.code === 'LF_AREA').message).toContain('Back')
  })

  it('puts the one file of a one-position product there, whatever its name', async () => {
    product.print_positions = [{ code: 'face', label: 'Watch face', is_primary: true }]
    const o = await makeOrder({ areas: ['Print'] })
    const p = await previewJson(o.id)
    expect(p.payload.line_items[0].designs).toEqual([{ position: 'face', design_url: expect.any(String) }])
  })

  it('refuses a SKU Lenful lists as dropship, since it takes no print file', async () => {
    product.type = 'dropship'
    product.print_positions = []
    const o = await makeOrder()
    expect(codes((await previewJson(o.id)).issues)).toContain('LF_DROPSHIP')
  })

  it('blocks a design not approved yet and gives out no file link', async () => {
    const o = await makeOrder({ approved: false })
    const p = await previewJson(o.id)
    expect(codes(p.issues)).toContain('NOT_APPROVED')
    expect(JSON.stringify(p.payload)).not.toContain('/api/public/artwork/')
  })

  it('needs a state code for a Canadian order', async () => {
    const o = await makeOrder({ country: 'CA' })
    expect(codes((await previewJson(o.id)).issues)).toContain('ADDRESS_STATE')
  })
})

describe('Lenful push', () => {
  it('creates the order, keeps its code, id, total and status, and marks the line exported', async () => {
    const o = await makeOrder()
    const res = await pushFresh(o.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ exported: true, push: { status: 'CREATED', supplierOrderCode: 'LF-2026-000001', totalCost: 14.5, remoteStatus: 'Chờ xử lý' } })
    expect((await pushRow(o.id)).supplierInternalId).toBe(remote[0].id)
    expect(creates()).toHaveLength(1)
    expect(creates()[0].headers.Authorization).toBe(`Bearer ${KEY}`)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { lines: true } })
    expect(order.pipelineStatus).toBe('EXPORTED')
    expect(order.lines[0].exportedToSupplierId).toBe(SUP)
  })

  it('sends exactly the reviewed body and touches no payment call', async () => {
    const o = await makeOrder()
    const p = await previewJson(o.id)
    await push(o.id, p.payloadHash)
    expect(creates()[0].body).toEqual(p.payload)
    expect(calls.some(c => c.path.endsWith('/pay'))).toBe(false)
  })

  it('never sends the same order twice', async () => {
    const o = await makeOrder()
    const hash = (await previewJson(o.id)).payloadHash
    await push(o.id, hash)
    const again = await push(o.id, hash)
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

  it('links the order Lenful already holds under this number (409) instead of making a second one', async () => {
    const o = await makeOrder()
    remote.push({
      id: 'eeeeeeee-0000-4000-8000-000000000001', code: 'LF-2026-000777', store: STORE_ID, external_order_id: o.number, workflow_status: 'processing',
      payment_status: 'paid', revenue_total: 2000, items: [{ id: 'old-item', sku: LF_SKU, quantity: 1, workflow_status: 'processing', item_revenue: 2000 }], trackings: [],
    })
    const body = await (await pushFresh(o.id)).json()
    expect(body.push).toMatchObject({ status: 'CREATED', supplierOrderCode: 'LF-2026-000777', remoteStatus: 'Đang sản xuất', totalCost: 20 })
    expect(remote).toHaveLength(1)
  })

  it('records a refusal with every field error, leaves the order open, and retries under the same number', async () => {
    const o = await makeOrder()
    handler = c => c.method === 'POST' && c.path === `${API}/orders`
      ? fail(422, 'Validation failed', { errors: [{ field: 'line_items[0].designs[1].position', message: 'unknown print position' }] })
      : defaultHandler(c)
    const res = await pushFresh(o.id)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('line_items[0].designs[1].position: unknown print position')
    expect(await pushRow(o.id)).toMatchObject({ status: 'FAILED', activeKey: null })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
    handler = defaultHandler
    const p = await previewJson(o.id)
    expect(p.payload.external_order_id).toBe(o.number)
    expect((await push(o.id, p.payloadHash)).status).toBe(200)
  })

  it('says a refused key is the key', async () => {
    await setting(LENFUL_KEYS.apiKey, 'lf_live_wrong_key_000000')
    const o = await makeOrder()
    const p = await previewJson(o.id)
    expect(p.issues.find((i: any) => i.code === 'LF_SKU').message).toContain('API key')
  })

  it('on no answer holds the send, and a refresh finds the order that did land', async () => {
    const o = await makeOrder()
    handler = c => {
      if (c.method === 'POST' && c.path === `${API}/orders`) { defaultHandler(c); return 'network-error' }
      return defaultHandler(c)
    }
    const res = await pushFresh(o.id)
    expect(res.status).toBe(504)
    expect(await pushRow(o.id)).toMatchObject({ status: 'SENDING' })
    handler = defaultHandler
    const body = await (await refresh(o.id)).json()
    expect(body).toMatchObject({ found: true, push: { status: 'CREATED', supplierOrderCode: 'LF-2026-000001' } })
    expect(callsTo('GET', `${API}/orders`)[0].query.get('created_from')).toBe(vietnamDay(new Date(Date.now() - 24 * 3600_000)))
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('EXPORTED')
  })

  it('frees the order once Lenful still has nothing after the grace time', async () => {
    const o = await makeOrder()
    handler = c => c.method === 'POST' && c.path === `${API}/orders` ? 'network-error' : defaultHandler(c)
    await pushFresh(o.id)
    await prisma.supplierOrderPush.updateMany({ where: { orderId: o.id }, data: { pushedAt: new Date(Date.now() - 10 * 60_000) } })
    handler = defaultHandler
    const body = await (await refresh(o.id)).json()
    expect(body).toMatchObject({ found: false, push: { status: 'FAILED' } })
  })

  it('treats a 5xx as no answer, not as a refusal', async () => {
    const o = await makeOrder()
    handler = c => c.method === 'POST' && c.path === `${API}/orders` ? fail(502, 'Bad gateway') : defaultHandler(c)
    expect((await pushFresh(o.id)).status).toBe(504)
    expect((await pushRow(o.id)).status).toBe('SENDING')
  })
})

describe('Lenful tracking', () => {
  async function sent(lines = 1) {
    const o = await makeOrder({ lines })
    await pushFresh(o.id)
    return { ...o, remote: remote[remote.length - 1] }
  }
  const shipments = (orderId: string) => prisma.shipment.findMany({ where: { orderId }, orderBy: { lineKey: 'asc' } })

  it('reads no tracking while the order is pending, and counts an unpaid order', async () => {
    const o = await sent()
    o.remote.payment_status = 'unpaid'
    const body = await (await refresh(o.id)).json()
    expect(body).toMatchObject({ found: true, shipments: 0, push: { remoteStatus: 'Chờ xử lý · Chưa thanh toán' } })
    expect(callsTo('GET', /\/trackings$/)).toHaveLength(0)
    expect((await (await getSettingsRoute(await req(SETTINGS, adminToken))).json()).unpaidOrders).toBeGreaterThanOrEqual(1)
  })

  it('writes the current number of the item on its line, where Auto Fulfilled takes it from', async () => {
    const o = await sent()
    o.remote.workflow_status = 'fulfillment'
    o.remote.trackings = [
      { order_item_id: o.remote.items[0].id, carrier: 'USPS', tracking_number: 'OLD1', status: 'expired', is_current: false },
      { order_item_id: o.remote.items[0].id, carrier: 'USPS', tracking_number: '9400111', status: 'in_transit', is_current: true },
    ]
    expect(await (await refresh(o.id)).json()).toMatchObject({ shipments: 1, push: { remoteStatus: 'Đã giao vận chuyển' } })
    expect(await shipments(o.id)).toEqual([expect.objectContaining({ lineKey: `${o.number}_1`, trackingNumber: '9400111', carrier: 'USPS', supplierId: SUP })])
    const rows = await pushedShipmentRows(storeId)
    expect(rows.get(o.number)).toEqual([{ lineKey: `${o.number}_1`, tracking: '9400111' }])
  })

  it('gives each line the number of its own item', async () => {
    const o = await sent(2)
    o.remote.workflow_status = 'processing'
    o.remote.trackings = [
      { order_item_id: o.remote.items[1].id, carrier: 'USPS', tracking_number: 'B-2', status: 'in_transit', is_current: true },
      { order_item_id: o.remote.items[0].id, carrier: 'UPS', tracking_number: 'A-1', status: 'in_transit', is_current: true },
    ]
    expect((await (await refresh(o.id)).json()).shipments).toBe(2)
    expect((await shipments(o.id)).map(s => [s.lineKey, s.trackingNumber, s.carrier])).toEqual([[`${o.number}_1`, 'A-1', 'UPS'], [`${o.number}_2`, 'B-2', 'USPS']])
  })

  it('leaves a line whose item has no number yet', async () => {
    const o = await sent(2)
    o.remote.workflow_status = 'processing'
    o.remote.trackings = [{ order_item_id: o.remote.items[0].id, carrier: 'USPS', tracking_number: 'A-1', status: 'in_transit', is_current: true }]
    expect((await (await refresh(o.id)).json()).shipments).toBe(1)
    expect((await shipments(o.id)).map(s => s.lineKey)).toEqual([`${o.number}_1`])
  })

  it('reports an order cancelled on Lenful and writes no tracking', async () => {
    const o = await sent()
    o.remote.workflow_status = 'cancel'
    o.remote.trackings = [{ order_item_id: o.remote.items[0].id, carrier: 'USPS', tracking_number: 'X', status: 'x', is_current: true }]
    const body = await (await refresh(o.id)).json()
    expect(body.push).toMatchObject({ status: 'CREATED', remoteStatus: 'Đã huỷ' })
    expect(body.push.error).toContain('bấm Huỷ')
    expect(await shipments(o.id)).toHaveLength(0)
  })

  it('syncs every open push, and one failure does not stop the next', async () => {
    const a = await sent()
    const b = await sent()
    a.remote.workflow_status = 'fulfillment'
    b.remote.workflow_status = 'fulfillment'
    b.remote.trackings = [{ order_item_id: b.remote.items[0].id, carrier: 'USPS', tracking_number: 'B-TRACK', status: 'in_transit', is_current: true }]
    handler = c => c.path === `${API}/orders/${a.remote.id}` ? 'network-error' : defaultHandler(c)
    const r = await syncLenfulTracking()
    expect(r).toMatchObject({ found: 1, shipments: 1 })
    expect((await shipments(b.id))[0].trackingNumber).toBe('B-TRACK')
  })

  it('is part of the supplier tracking run, and skips quietly without a key', async () => {
    await clearSettings()
    const all = await syncApiSupplierTracking()
    expect(all.find(r => r.name === 'Lenful')).toMatchObject({ skipped: 'no Lenful key' })
    expect(calls).toHaveLength(0)
  })
})

describe('Lenful cancel', () => {
  it('cancels with a reason and puts the order back in the queue', async () => {
    const o = await makeOrder()
    await pushFresh(o.id)
    const body = await (await cancel(o.id)).json()
    expect(body).toMatchObject({ exportReverted: true, push: { status: 'CANCELLED' } })
    const call = callsTo('POST', /\/cancel$/)[0]
    expect(call.path).toBe(`${API}/orders/${remote[0].id}/cancel`)
    expect(call.body).toEqual({ reason: 'Cancelled from Ecom Manager' })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { lines: true } })
    expect(order.pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect(order.lines[0].exportedAt).toBeNull()
  })

  it('keeps the push when the items are already in production', async () => {
    const o = await makeOrder()
    await pushFresh(o.id)
    remote[0].workflow_status = 'processing'
    remote[0].items[0].workflow_status = 'processing'
    handler = c => c.path.endsWith('/cancel') ? { status: 409, json: { success: false, message: 'No item can be cancelled', data: null } } : defaultHandler(c)
    const res = await cancel(o.id)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('No item can be cancelled')
    expect((await pushRow(o.id)).status).toBe('CREATED')
  })

  it('closes the push without another call when Lenful already cancelled it', async () => {
    const o = await makeOrder()
    await pushFresh(o.id)
    remote[0].workflow_status = 'cancel'
    expect((await cancel(o.id)).status).toBe(200)
    expect(callsTo('POST', /\/cancel$/)).toHaveLength(0)
  })

  it('sends the order again under a new number after a cancel', async () => {
    const o = await makeOrder()
    await pushFresh(o.id)
    await cancel(o.id)
    const p = await previewJson(o.id)
    expect(p.payload.external_order_id).toBe(`${o.number}-R2`)
    expect(p.canPush).toBe(true)
  })
})

describe('Lenful settings', () => {
  const put = async (token: string, body: unknown) => putSettingsRoute(await req(SETTINGS, token, send('PUT', body)))
  const get = async () => (await getSettingsRoute(await req(SETTINGS, adminToken))).json()
  const check = async () => postSettingsTest(await req(`${SETTINGS}/test`, adminToken, send('POST', {})))

  it('shows the key only masked', async () => {
    const view = await get()
    expect(view).toMatchObject({ hasApiKey: true, apiKeyMasked: 'lf_l…3456', storeId: null, shippingMethodCode: null })
    expect(view.skus).toEqual([{ sku: SKU, lenfulSku: LF_SKU }])
    expect(JSON.stringify(view)).not.toContain(KEY)
  })

  it('only a superadmin saves', async () => {
    expect((await put(adminToken, { apiKey: 'lf_live_other' })).status).toBe(403)
    expect((await getLenfulSettings()).apiKey).toBe(KEY)
  })

  it('keeps the stored key when the field is left blank, and checks the store and method', async () => {
    expect((await put(superToken, { apiKey: '', storeId: STORE_ID, shippingMethodCode: '2' })).status).toBe(200)
    expect(await getLenfulSettings()).toMatchObject({ apiKey: KEY, storeId: STORE_ID, shippingMethodCode: '2' })
    expect((await put(superToken, { shippingMethodCode: 'fast' })).status).toBe(400)
    expect((await put(superToken, { storeId: 'my store' })).status).toBe(400)
    expect((await put(superToken, { storeId: '', shippingMethodCode: '' })).status).toBe(200)
    expect(await getLenfulSettings()).toMatchObject({ apiKey: KEY, storeId: null, shippingMethodCode: null })
    expect((await put(superToken, { apiKey: null })).status).toBe(200)
    expect((await getLenfulSettings()).apiKey).toBeNull()
  })

  it('tests the key: stores, wallet and the SKUs the tool sends, and creates nothing', async () => {
    const res = await check()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true, wallet: 123.45, problems: [],
      stores: [{ id: STORE_ID, name: 'Default store', isDefault: true }],
      skus: [{ lenfulSku: LF_SKU, product: 'US Unisex T-Shirt', type: 'pod', listPrice: 9.5, positions: ['back', 'front'], error: null }],
    })
    expect(creates()).toHaveLength(0)
  })

  it('reports a wrong key without repeating it', async () => {
    await setting(LENFUL_KEYS.apiKey, 'lf_live_wrong_key_000000')
    const res = await check()
    expect(res.status).toBe(502)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('Invalid API key')
    expect(text).not.toContain('lf_live_wrong_key_000000')
  })

  it('suggests the Lenful SKU from the catalog search', async () => {
    await setApiSku(null)
    const res = await getSkuMap(await req('http://x/api/fulfillment/lenful/sku-map?q=t-shirt', adminToken))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.supplierSkus.map((s: any) => s.skuName)).toEqual([LF_SKU, 'LF-USTSHIRT-WHITEM'])
    expect(body.products).toEqual([expect.objectContaining({ sku: SKU, apiSku: null })])
    expect(creates()).toHaveLength(0)
  })
})

describe('Lenful in the supplier handoff', () => {
  it('stays on CSV until the key is saved, then goes by API only', async () => {
    const o = await makeOrder()
    await clearSettings()
    expect(await handoffStateFor(o.id)).toMatchObject({ mode: 'CSV', apiOpenKind: null })
    await saveKey()
    expect(await handoffStateFor(o.id)).toMatchObject({ mode: 'API', apiKind: 'lenful', apiName: 'Lenful', apiOpenKind: 'lenful' })
    await expect(handoffOrderCsv(o.id, null)).rejects.toMatchObject({ code: 'LENFUL_API_ONLY' })
  })
})
