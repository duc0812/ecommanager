import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { setCsvLocked } from '@/lib/csv-lock'
import { handoffOrderCsv, handoffStateFor, listHandoffTabs } from '@/lib/supplier-handoff'
import { pushedShipmentRows } from '@/lib/fulfillment/auto-fulfill'
import { syncPrintwayTracking } from '@/lib/repos/printway-push'
import { syncApiSupplierTracking } from '@/lib/repos/supplier-tracking-sync'
import { resyncOrder } from './helpers/resync-order'
import { PRINTWAY_KEYS, getPrintwaySettings } from '@/lib/printway-settings'
import { GET as getPreview } from '@/app/api/fulfillment/printway/orders/[orderId]/preview/route'
import { POST as postPush } from '@/app/api/fulfillment/printway/orders/[orderId]/push/route'
import { POST as postCancel } from '@/app/api/fulfillment/printway/orders/[orderId]/cancel/route'
import { POST as postRefresh } from '@/app/api/fulfillment/printway/orders/[orderId]/refresh/route'
import { GET as getSettingsRoute, PUT as putSettingsRoute } from '@/app/api/fulfillment/printway/settings/route'
import { POST as postSettingsTest } from '@/app/api/fulfillment/printway/settings/test/route'
import { GET as getSkuMap } from '@/app/api/fulfillment/printway/sku-map/route'

const SHOP = 'pwstore.myshopify.com'
const PROJECT = 'proj_pw'
const SUP = 'sup_pw'
const SKU = '45-INCHES'
const API_SKU = 'PW-OCS-4.5 INCHES-ONE SIDE'
const ORIGIN = 'https://apis.printway.io'
const APP_URL = 'https://tool.shop-example.com'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-storage-'))

let storeId = ''
let adminToken = ''
let superToken = ''
let seq = 0

type Call = { path: string; query: URLSearchParams; method: string; headers: Record<string, string>; body: string }
type Reply = { status: number; json: unknown } | 'network-error'
type RemoteOrder = { pwOrderId: string; status: string; tracking: string | null }
let calls: Call[] = []
let handler: (call: Call) => Reply | Promise<Reply>
let remoteOrders: Map<string, RemoteOrder>
let nextId = 100

const ok = (data: unknown): Reply => ({ status: 200, json: { message: 'Success', data } })

function defaultHandler(call: Call): Reply {
  const p = call.path.replace('/v3', '')
  if (p === '/products/list-sku-catalogs') {
    return ok([
      { item_sku: API_SKU, variant_id: 77, product_name: 'Custom Shape Acrylic Ornament' },
      { item_sku: 'PW-OTHER', variant_id: 78, product_name: 'Mug' },
    ])
  }
  if (p === '/order/calculate-price') return ok({ total: 12.5 })
  if (p === '/order/create-new-order') {
    const body = JSON.parse(call.body)
    const pwOrderId = `PWN${nextId++}`
    remoteOrders.set(body.order_id, { pwOrderId, status: 'Unpaid', tracking: null })
    return ok({ pw_order_id: pwOrderId, order_id: body.order_id })
  }
  if (p === '/order/paid') {
    const id = JSON.parse(call.body).order_id
    for (const o of Array.from(remoteOrders.values())) if (o.pwOrderId === id) o.status = 'Paid'
    return ok({})
  }
  if (p === '/order/detail') {
    const o = remoteOrders.get(call.query.get('order_name') ?? '')
    if (!o) return { status: 404, json: { message: 'Order not found' } }
    return ok({
      pw_order_id: o.pwOrderId, order_status: o.status,
      order_items: [{ item_sku: API_SKU, tracking_number: o.tracking, carrier_name: o.tracking ? 'YunExpress' : null }],
    })
  }
  if (p === '/order/cancel-order-api') {
    const id = JSON.parse(call.body).pw_order_id
    for (const [name, o] of Array.from(remoteOrders.entries())) if (o.pwOrderId === id) remoteOrders.delete(name)
    return ok({})
  }
  return { status: 404, json: { message: `unexpected path in test: ${p}` } }
}

const callsTo = (suffix: string) => calls.filter(c => c.path.endsWith(suffix))

async function req(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const base = (orderId: string) => `http://x/api/fulfillment/printway/orders/${encodeURIComponent(orderId)}`
const preview = async (orderId: string) => getPreview(await req(`${base(orderId)}/preview`, adminToken), { params: { orderId } })
const push = async (orderId: string, payloadHash: string) =>
  postPush(await req(`${base(orderId)}/push`, adminToken, post({ confirm: true, payloadHash })), { params: { orderId } })
const cancel = async (orderId: string) => postCancel(await req(`${base(orderId)}/cancel`, adminToken, post({ confirm: true })), { params: { orderId } })
const refresh = async (orderId: string) => postRefresh(await req(`${base(orderId)}/refresh`, adminToken, post({})), { params: { orderId } })

async function makeOrder(opts: { approved?: boolean; supplierSku?: string; note?: string; phone?: string; country?: string; state?: string } = {}) {
  seq++
  const id = `gid://test/Order/pw-${seq}`
  const number = `#PW${1000 + seq}`
  const lineId = `pwl-${seq}`
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 29.45, expectedPayout: 28.3, totalFees: 1.15, refundedAmount: 0, placedAt: new Date('2026-10-15T19:28:06Z'),
      pipelineStatus: 'READY_TO_PRODUCTION', orderType: 'NON_CUSTOM', designReady: opts.approved !== false,
      customerEmail: 'sal@example.com', customerName: 'Sal Paint',
      shippingName: 'Sal Van Paint', shippingAddress1: '12 Main St', shippingAddress2: 'Apt 4', shippingCity: 'Leeds',
      shippingZip: 'LS1 1AA', shippingPhone: opts.phone ?? '07700 900123', shippingCountry: opts.country ?? 'GB', shippingState: opts.state ?? 'England', shippingStateCode: 'ENG',
      lines: { create: [{
        shopifyLineId: lineId, productTitle: 'Secret Family Ornament', variantTitle: '4.5 inches', qty: 2, linePosition: 1, unitPrice: 24.95,
        resolvedSupplierId: SUP, resolvedSupplierSku: opts.supplierSku ?? SKU, customized: false,
        imageUrl: 'https://cdn.shopify.com/s/files/orn.jpg', designNote: opts.note ?? null,
        designDriveLink: opts.approved === false ? null : '/api/design-studio/file/placeholder',
      }] },
      designTasks: { create: [{ shopifyLineId: lineId, taskKey: `PW${1000 + seq}_1`, status: opts.approved === false ? 'NEW' : 'DONE' }] },
    },
  })
  const rel = `design/pw-${seq}/print.png`
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), PNG)
  await prisma.designArtwork.create({
    data: {
      orderId: id, shopifyLineId: lineId, printArea: 'Print', version: 1, fileName: 'print.png', storagePath: rel,
      size: PNG.length, mimeType: 'image/png', widthPx: 1181, heightPx: 2362,
    },
  })
  return { id, number: number.replace('#', '') }
}

const saveToken = () => prisma.appSetting.upsert({ where: { key: PRINTWAY_KEYS.token }, create: { key: PRINTWAY_KEYS.token, value: 'pw-token-secret' }, update: { value: 'pw-token-secret' } })
const clearToken = () => prisma.appSetting.deleteMany({ where: { key: { in: Object.values(PRINTWAY_KEYS) } } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await setCsvLocked(false)
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'PW', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'printway' }, create: { id: SUP, name: 'Printway', code: 'printway' }, update: {} })
  const template = await prisma.printTemplate.create({
    data: { supplierId: SUP, supplierSku: SKU, name: 'Printway ornament', widthPx: 1181, heightPx: 2362, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 1181, h: 2362 }]) },
  })
  await prisma.supplierProduct.create({
    data: { supplierId: SUP, sku: SKU, apiSku: API_SKU, productName: 'Custom Shape Acrylic Ornament', variant1Name: 'Size', variant1Value: '4.5 inches', baseCost: 11.29, printTemplateId: template.id },
  })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'NOAPI', productName: 'Round Glass Ornament', variant1Name: 'Size', variant1Value: '3.07 IN', baseCost: 10 } })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'EXPRESS', apiSku: 'PW-EXPRESS', apiShipClass: 'UK Express', baseCost: 10 } })
  const adminId = (await prisma.appUser.upsert({ where: { email: 'admin@pw.test' }, create: { name: 'Admin', email: 'admin@pw.test', role: 'ADMIN', permissions: JSON.stringify([]), passwordHash: 'x' }, update: {} })).id
  adminToken = await signToken({ userId: adminId, email: 'admin@pw.test', name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
  const superId = (await prisma.appUser.upsert({ where: { email: 'super@pw.test' }, create: { name: 'Super', email: 'super@pw.test', role: 'SUPERADMIN', permissions: JSON.stringify([]), passwordHash: 'x' }, update: {} })).id
  superToken = await signToken({ userId: superId, email: 'super@pw.test', name: 'Super', role: 'SUPERADMIN', permissions: [], tv: 0 })
})

afterAll(async () => {
  await clearToken()
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['admin@pw.test', 'super@pw.test'] } } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
  delete process.env.NEXT_PUBLIC_APP_URL
})

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = APP_URL
  await clearToken()
  await saveToken()
  calls = []
  remoteOrders = new Map()
  handler = defaultHandler
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin !== ORIGIN) throw new Error(`test blocked a call to ${url.origin}`)
    const call: Call = { path: url.pathname, query: url.searchParams, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') }
    calls.push(call)
    const reply = await handler(call)
    if (reply === 'network-error') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('Printway preview', () => {
  it('builds the order from the mapped SKU and the approved file', async () => {
    const o = await makeOrder()
    const res = await preview(o.id)
    expect(res.status).toBe(200)
    const p = await res.json()
    expect(p.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(p.canPush).toBe(true)
    expect(p.payload).toMatchObject({
      order_id: o.number, firstName: 'Sal Van', lastName: 'Paint', shipping_phone: '+447700900123',
      shipping_address1: '12 Main St', shipping_address2: 'Apt 4', shipping_city: 'Leeds',
      shipping_province: 'England', shipping_province_code: 'ENG', shipping_zip: 'LS1 1AA', shipping_country: 'United Kingdom', shipping_country_code: 'GB',
      order_items: [{ item_sku: API_SKU, quantity: 2, mockup_url: 'https://cdn.shopify.com/s/files/orn.jpg' }],
    })
    expect(p.payload.order_items[0].artwork_front).toMatch(new RegExp(`^${APP_URL}/api/public/artwork/`))
  })

  it('sends no product title, shop domain, shopper email or CS note', async () => {
    const o = await makeOrder({ note: 'Customer is angry, refund next' })
    const p = await (await preview(o.id)).json()
    const sent = JSON.stringify(p.payload)
    expect(sent).not.toContain('Secret Family')
    expect(sent).not.toContain(SHOP)
    expect(sent).not.toContain('sal@example.com')
    expect(sent).not.toContain('Customer is angry')
    expect(p.issues.find((i: any) => i.code === 'DESIGN_NOTE')).toMatchObject({ level: 'warning' })
  })

  it('leaves out a phone it cannot make valid, and says so', async () => {
    const o = await makeOrder({ phone: 'call me maybe' })
    const p = await (await preview(o.id)).json()
    expect(p.payload.shipping_phone).toBeUndefined()
    expect(p.issues.find((i: any) => i.code === 'ADDRESS_PHONE')).toMatchObject({ level: 'warning' })
  })

  it('prices the order, which creates and charges nothing', async () => {
    const o = await makeOrder()
    await preview(o.id)
    expect(callsTo('/order/calculate-price')).toHaveLength(1)
    expect(JSON.parse(callsTo('/order/calculate-price')[0].body)).toMatchObject({
      shipping_country_code: 'GB', shipping_province_code: 'ENG', order_items: [{ item_sku: API_SKU, quantity: 2 }],
    })
    expect(callsTo('/order/create-new-order')).toHaveLength(0)
    expect(callsTo('/order/paid')).toHaveLength(0)
  })

  it('blocks what Printway refuses when pricing', async () => {
    const o = await makeOrder()
    handler = call => call.path.endsWith('/order/calculate-price') ? { status: 422, json: { message: 'SKU not found' } } : defaultHandler(call)
    const p = await (await preview(o.id)).json()
    expect(p.canPush).toBe(false)
    expect(p.issues.find((i: any) => i.code === 'PRINTWAY_REFUSED')).toMatchObject({ level: 'error', message: expect.stringContaining('SKU not found') })
  })

  it('still lets a person send when pricing gets no answer', async () => {
    const o = await makeOrder()
    handler = call => call.path.endsWith('/order/calculate-price') ? 'network-error' : defaultHandler(call)
    const p = await (await preview(o.id)).json()
    expect(p.canPush).toBe(true)
    expect(p.issues.find((i: any) => i.code === 'QUOTE_UNAVAILABLE')).toMatchObject({ level: 'warning' })
  })

  it('blocks a SKU not matched to Printway, an unapproved design and a line already sent', async () => {
    const unmapped = await makeOrder({ supplierSku: 'NOAPI' })
    const p1 = await (await preview(unmapped.id)).json()
    expect(p1.issues.find((i: any) => i.code === 'NO_API_SKU')).toMatchObject({ level: 'error' })
    expect(p1.canPush).toBe(false)

    const draft = await makeOrder({ approved: false })
    const p2 = await (await preview(draft.id)).json()
    expect(p2.issues.find((i: any) => i.code === 'NOT_APPROVED')).toMatchObject({ level: 'error' })

    const sent = await makeOrder()
    await prisma.orderLine.updateMany({ where: { orderId: sent.id }, data: { exportedAt: new Date(), exportedToSupplierId: SUP } })
    const p3 = await (await preview(sent.id)).json()
    expect(p3.issues.find((i: any) => i.code === 'ALREADY_EXPORTED')).toMatchObject({ level: 'error' })
  })

  it('passes the ship service set on the SKU', async () => {
    const o = await makeOrder({ supplierSku: 'EXPRESS' })
    expect((await (await preview(o.id)).json()).payload.shipping_service).toBe('UK Express')
    const plain = await makeOrder()
    expect((await (await preview(plain.id)).json()).payload.shipping_service).toBeUndefined()
  })

  it('needs the token to be saved', async () => {
    const o = await makeOrder()
    await clearToken()
    const p = await (await preview(o.id)).json()
    expect(p.hasCredentials).toBe(false)
    expect(p.canPush).toBe(false)
    expect(p.issues.find((i: any) => i.code === 'NO_CREDENTIALS')).toMatchObject({ level: 'error' })
    expect(calls).toHaveLength(0)
  })
})

describe('Printway push', () => {
  it('creates and pays in one click, marks the order exported and refuses a second send', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.exported).toBe(true)
    const pwId = remoteOrders.get(o.number)!.pwOrderId
    expect(body.push).toMatchObject({ status: 'CREATED', externalOrderId: o.number, supplierOrderCode: pwId, remoteStatus: 'paid', error: null })
    expect(callsTo('/order/create-new-order')).toHaveLength(1)
    expect(JSON.parse(callsTo('/order/paid')[0].body)).toEqual({ order_id: pwId })
    expect(remoteOrders.get(o.number)!.status).toBe('Paid')
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })).exportedToSupplierId).toBe(SUP)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('EXPORTED')

    const again = await push(o.id, p.payloadHash)
    expect(again.status).toBe(409)
    expect(callsTo('/order/create-new-order')).toHaveLength(1)
    expect(callsTo('/order/paid')).toHaveLength(1)
  })

  it('keeps the order when the payment is refused, and says it is unpaid', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => call.path.endsWith('/order/paid') ? { status: 400, json: { message: 'Insufficient balance' } } : defaultHandler(call)
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.exported).toBe(true)
    expect(body.push).toMatchObject({ status: 'CREATED', remoteStatus: 'unpaid' })
    expect(body.push.error).toContain('Insufficient balance')
    expect(body.push.error).toContain('chưa trả tiền')
    expect(callsTo('/order/paid')).toHaveLength(1)
  })

  it('never pays twice when the payment gets no answer', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => call.path.endsWith('/order/paid') ? 'network-error' : defaultHandler(call)
    const body = await (await push(o.id, p.payloadHash)).json()
    expect(body.push).toMatchObject({ status: 'CREATED', remoteStatus: 'payment unknown' })
    expect(body.push.error).toContain('chưa rõ')
    expect(callsTo('/order/paid')).toHaveLength(1)
  })

  it('finds an order that Printway has not finished saving before paying', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    let tries = 0
    handler = call => {
      if (call.path.endsWith('/order/paid')) {
        tries++
        if (tries === 1) return { status: 404, json: { message: 'Order not found' } }
      }
      return defaultHandler(call)
    }
    const body = await (await push(o.id, p.payloadHash)).json()
    expect(body.push).toMatchObject({ status: 'CREATED', remoteStatus: 'paid' })
    expect(tries).toBe(2)
  })

  it('reads the Printway id from the order when the create answer has none', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => {
      if (call.path.endsWith('/order/create-new-order')) {
        defaultHandler(call)
        return ok({ created: true })
      }
      return defaultHandler(call)
    }
    const body = await (await push(o.id, p.payloadHash)).json()
    expect(body.push).toMatchObject({ status: 'CREATED', supplierOrderCode: remoteOrders.get(o.number)!.pwOrderId, remoteStatus: 'paid' })
  })

  it('does not pay blind when no Printway id can be found', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => {
      if (call.path.endsWith('/order/create-new-order')) return ok({ created: true })
      return defaultHandler(call)
    }
    const body = await (await push(o.id, p.payloadHash)).json()
    expect(body.push).toMatchObject({ status: 'CREATED', remoteStatus: 'unpaid' })
    expect(body.push.error).toContain('chưa trả tiền')
    expect(callsTo('/order/paid')).toHaveLength(0)
  })

  it('records a refusal as FAILED, pays nothing and lets the retry reuse the order number', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => call.path.endsWith('/order/create-new-order') ? { status: 422, json: { message: 'shipping_zip is invalid' } } : defaultHandler(call)
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('shipping_zip is invalid')
    expect((await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe('FAILED')
    expect(callsTo('/order/paid')).toHaveLength(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')

    handler = defaultHandler
    const retry = await (await preview(o.id)).json()
    expect(retry.payload.order_id).toBe(o.number)
    expect((await push(o.id, retry.payloadHash)).status).toBe(200)
  })

  it('keeps an unanswered create live; the refresh finds the order but does not pay it', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => {
      if (call.path.endsWith('/order/create-new-order')) {
        remoteOrders.set(o.number, { pwOrderId: 'PWN500', status: 'Unpaid', tracking: null })
        return 'network-error'
      }
      return defaultHandler(call)
    }
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(504)
    expect((await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe('SENDING')
    expect(callsTo('/order/paid')).toHaveLength(0)
    const blocked = await (await preview(o.id)).json()
    expect(blocked.issues.find((i: any) => i.code === 'ACTIVE_PUSH')).toMatchObject({ level: 'error' })

    handler = defaultHandler
    const r = await (await refresh(o.id)).json()
    expect(r.found).toBe(true)
    expect(r.push).toMatchObject({ status: 'CREATED', supplierOrderCode: 'PWN500', remoteStatus: 'Unpaid' })
    expect(r.push.error).toContain('chưa trả tiền')
    expect(callsTo('/order/paid')).toHaveLength(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('EXPORTED')
  })

  it('after the grace time a refresh closes a send Printway never saw', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => call.path.endsWith('/order/create-new-order') ? 'network-error' : defaultHandler(call)
    await push(o.id, p.payloadHash)

    handler = defaultHandler
    const early = await (await refresh(o.id)).json()
    expect(early.push.status).toBe('SENDING')

    await prisma.supplierOrderPush.updateMany({ where: { orderId: o.id }, data: { pushedAt: new Date(Date.now() - 10 * 60_000) } })
    const late = await (await refresh(o.id)).json()
    expect(late).toMatchObject({ found: false, push: { status: 'FAILED' } })
    const retry = await (await preview(o.id)).json()
    expect(retry.payload.order_id).toBe(o.number)
    expect(retry.canPush).toBe(true)
  })

  it('a hash from an older preview is refused', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await prisma.order.update({ where: { id: o.id }, data: { shippingCity: 'York' } })
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PAYLOAD_CHANGED')
    expect(callsTo('/order/create-new-order')).toHaveLength(0)
  })
})

describe('Printway cancel', () => {
  it('cancels by the Printway id, restores the order and re-sends under a fresh number', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await push(o.id, p.payloadHash)
    const pwId = remoteOrders.get(o.number)!.pwOrderId

    const res = await cancel(o.id)
    expect(res.status).toBe(200)
    expect((await res.json()).exportReverted).toBe(true)
    expect(JSON.parse(callsTo('/order/cancel-order-api')[0].body)).toEqual({ pw_order_id: pwId })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })).exportedAt).toBeNull()

    const retry = await (await preview(o.id)).json()
    expect(retry.payload.order_id).toBe(`${o.number}-R2`)
  })

  it('keeps the push live when Printway refuses, as an order already in production', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await push(o.id, p.payloadHash)
    handler = call => call.path.endsWith('/order/cancel-order-api') ? { status: 400, json: { message: 'Order already in production' } } : defaultHandler(call)
    const res = await cancel(o.id)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('already in production')
    expect((await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe('CREATED')
  })
})

describe('Printway tracking', () => {
  it('a refresh writes the tracking on the line, and Auto Fulfill picks it up', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await push(o.id, p.payloadHash)
    remoteOrders.get(o.number)!.tracking = 'YT7001'
    const r = await (await refresh(o.id)).json()
    expect(r.shipments).toBe(1)
    const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } })
    expect(shipment).toMatchObject({ trackingNumber: 'YT7001', carrier: 'YunExpress', supplierId: SUP, lineKey: `${o.number}_1` })
    expect((await pushedShipmentRows(storeId)).get(o.number)).toEqual([{ lineKey: `${o.number}_1`, tracking: 'YT7001' }])
  })

  it('the sync walks the live pushes and leaves a closed order alone', async () => {
    const o = await makeOrder()
    const closed = await makeOrder()
    for (const x of [o, closed]) {
      const p = await (await preview(x.id)).json()
      await push(x.id, p.payloadHash)
    }
    remoteOrders.get(o.number)!.tracking = 'YT7002'
    remoteOrders.get(closed.number)!.tracking = 'YT7003'
    await prisma.order.update({ where: { id: closed.id }, data: { pipelineStatus: 'FULFILLED' } })
    const result = await syncPrintwayTracking()
    expect(result.shipments).toBe(1)
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } })).trackingNumber).toBe('YT7002')
    expect(await prisma.shipment.count({ where: { orderId: closed.id } })).toBe(0)
    await prisma.order.deleteMany({ where: { id: { in: [o.id, closed.id] } } })
  })

  it('the sync does nothing without a token', async () => {
    await clearToken()
    await expect(syncPrintwayTracking()).resolves.toMatchObject({ pushes: 0, skipped: expect.any(String) })
    expect(calls).toHaveLength(0)
  })

  it('the shared sync reports each supplier, and one failing does not stop the others', async () => {
    const results = await syncApiSupplierTracking()
    const printway = results.find(r => r.name === 'Printway')
    expect(printway).toMatchObject({ pushes: expect.any(Number) })
    expect(results.map(r => r.name)).toEqual(expect.arrayContaining(['Bondre', 'Printway']))
  })
})

// The order sync makes every OrderLine anew each time it reads the order: a push's stored OrderLine ids are soon gone.
describe('Printway tracking after the order sync made the lines anew', () => {
  const pushed = async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await push(o.id, p.payloadHash)
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    return { o, line, row: await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } }) }
  }

  it('a push records the Shopify line ids it carries, and its tracking still reaches the line', async () => {
    const { o, line, row } = await pushed()
    expect(JSON.parse(row.prevExportJson!)).toMatchObject({ lineIds: [line.id], shopifyLineIds: [line.shopifyLineId] })
    await resyncOrder(o.id)
    remoteOrders.get(o.number)!.tracking = 'YT7101'
    expect((await (await refresh(o.id)).json()).shipments).toBe(1)
    expect(await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } }))
      .toMatchObject({ lineKey: `${o.number}_1`, shopifyLineId: line.shopifyLineId, trackingNumber: 'YT7101', supplierId: SUP })
  })

  it('a push stored with OrderLine ids only finds its line by the print file it sent', async () => {
    const { o, line, row } = await pushed()
    const { shopifyLineIds: _recorded, ...older } = JSON.parse(row.prevExportJson!)
    await prisma.supplierOrderPush.update({ where: { id: row.id }, data: { prevExportJson: JSON.stringify(older) } })
    await resyncOrder(o.id)
    remoteOrders.get(o.number)!.tracking = 'YT7102'
    await syncPrintwayTracking()
    expect(await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } }))
      .toMatchObject({ lineKey: `${o.number}_1`, shopifyLineId: line.shopifyLineId, trackingNumber: 'YT7102', supplierId: SUP })
  })
})

describe('handoff with Printway', () => {
  it('opens the Printway window once a token is saved', async () => {
    const o = await makeOrder()
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, mode: 'API', apiName: 'Printway', apiKind: 'printway', apiNote: null })
    expect((await listHandoffTabs()).find(t => t.id === SUP)?.channel).toBe('API')
  })

  it('an open Printway line cannot be saved for CSV once a token is saved', async () => {
    const o = await makeOrder()
    await expect(handoffOrderCsv(o.id, null)).rejects.toMatchObject({ code: 'PRINTWAY_API_ONLY' })
  })

  it('stays on the CSV route without a token, so deploying changes nothing', async () => {
    const o = await makeOrder()
    await clearToken()
    expect(await handoffStateFor(o.id)).toMatchObject({ mode: 'CSV', apiName: null })
    expect((await listHandoffTabs()).find(t => t.id === SUP)?.channel).toBe('CSV')
  })

  it('sends only the Printway lines of a mixed order and leaves the other supplier\'s line open', async () => {
    const o = await makeOrder()
    await prisma.supplier.upsert({ where: { code: 'other_pw_test' }, create: { id: 'sup_other_pw', name: 'Lenful', code: 'other_pw_test' }, update: {} })
    await prisma.orderLine.create({
      data: {
        orderId: o.id, shopifyLineId: `pwl-other-${seq}`, productTitle: 'Hoodie', variantTitle: 'L', qty: 1, linePosition: 2,
        unitPrice: 39.95, resolvedSupplierId: 'sup_other_pw', resolvedSupplierSku: 'HD-L', customized: false, sku: 'HD-L',
      },
    })
    expect(await handoffStateFor(o.id)).toMatchObject({ mode: 'API', apiKind: 'printway', csvRemainder: true, apiNote: expect.stringContaining('dòng Printway') })
    const p = await (await preview(o.id)).json()
    expect(p.issues.find((i: any) => i.code === 'MIXED_SUPPLIER')).toMatchObject({ level: 'warning' })
    expect(p.payload.order_items).toHaveLength(1)
    expect((await push(o.id, p.payloadHash)).status).toBe(200)
    const lines = await prisma.orderLine.findMany({ where: { orderId: o.id }, orderBy: { linePosition: 'asc' } })
    expect(lines[0].exportedToSupplierId).toBe(SUP)
    expect(lines[1].exportedAt).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
    await prisma.orderLine.deleteMany({ where: { orderId: o.id, linePosition: 2 } })
    await prisma.supplier.deleteMany({ where: { id: 'sup_other_pw' } })
  })
})

describe('Printway settings', () => {
  const url = 'http://x/api/fulfillment/printway/settings'
  const put = (body: unknown, token = superToken) => req(url, token, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }).then(r => putSettingsRoute(r))

  it('never returns the token', async () => {
    const res = await getSettingsRoute(await req(url, adminToken))
    const text = await res.text()
    expect(text).not.toContain('pw-token-secret')
    expect(JSON.parse(text)).toMatchObject({ hasToken: true })
  })

  it('only a superadmin saves the token', async () => {
    const res = await put({ token: 'other' }, adminToken)
    expect(res.status).toBe(403)
    expect((await getPrintwaySettings()).token).toBe('pw-token-secret')
  })

  it('a blank token keeps the saved one; null removes it', async () => {
    expect((await put({ token: '' })).status).toBe(200)
    expect((await getPrintwaySettings()).token).toBe('pw-token-secret')
    expect((await put({ token: 'new-token' })).status).toBe(200)
    expect((await getPrintwaySettings()).token).toBe('new-token')
    expect((await put({ token: null })).status).toBe(200)
    expect((await getPrintwaySettings()).token).toBeNull()
  })

  it('the test call reads the SKU list', async () => {
    const res = await postSettingsTest(await req(`${url}/test`, adminToken, post({})))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, skuCount: 2 })
  })

  it('the test call says when the token is refused', async () => {
    handler = () => ({ status: 401, json: { message: 'Unauthenticated' } })
    const res = await postSettingsTest(await req(`${url}/test`, adminToken, post({})))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Unauthenticated')
  })

  it('the SKU map lists the tool SKUs with Printway SKUs and a first guess', async () => {
    const res = await getSkuMap(await req('http://x/api/fulfillment/printway/sku-map', adminToken))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.supplierSkus.map((s: any) => s.skuName)).toEqual([API_SKU, 'PW-OTHER'])
    expect(body.products.find((p: any) => p.sku === SKU)).toMatchObject({ apiSku: API_SKU })
    expect(body.products.find((p: any) => p.sku === 'NOAPI')).toMatchObject({ apiSku: null, suggestion: null })
  })
})

const addOpenLine = async (o: { id: string; number: string }, firstLine: { resolvedSupplierSku: string | null; imageUrl: string | null }) => {
  const lineId = `pwl-open-${seq}`
  await prisma.orderLine.create({ data: {
    orderId: o.id, shopifyLineId: lineId, productTitle: 'Second Ornament', qty: 1, linePosition: 2, unitPrice: 24.95,
    resolvedSupplierId: SUP, resolvedSupplierSku: firstLine.resolvedSupplierSku, customized: false, imageUrl: firstLine.imageUrl,
  } })
  await prisma.designTask.create({ data: { orderId: o.id, shopifyLineId: lineId, taskKey: `${o.number}_2`, status: 'NEW' } })
  await prisma.order.update({ where: { id: o.id }, data: { pipelineStatus: 'PENDING_DESIGN', designReady: false } })
  const rel = `design/pwl-open-${seq}/print.png`
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), PNG)
  await prisma.designArtwork.create({ data: {
    orderId: o.id, shopifyLineId: lineId, printArea: 'Print', version: 1, fileName: 'print.png', storagePath: rel, size: PNG.length, mimeType: 'image/png', widthPx: 1181, heightPx: 2362,
  } })
  return lineId
}
const approveOpenLine = async (o: { id: string; number: string }, lineId: string) => {
  await prisma.orderLine.updateMany({ where: { orderId: o.id, shopifyLineId: lineId }, data: { designDriveLink: '/api/design-studio/file/placeholder' } })
  await prisma.designTask.update({ where: { taskKey: `${o.number}_2` }, data: { status: 'DONE' } })
  await prisma.order.update({ where: { id: o.id }, data: { pipelineStatus: 'READY_TO_PRODUCTION', designReady: true } })
}

describe('Printway: lines approved at different times', () => {
  it('sends the approved line, leaves the open one in design, and sends it later under its own number', async () => {
    const o = await makeOrder()
    const first = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    const lineId = await addOpenLine(o, first)

    const p = await (await preview(o.id)).json()
    expect(p.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(p.issues.find((i: any) => i.code === 'DESIGN_OPEN')).toMatchObject({ level: 'warning' })
    expect(p.lines.map((l: any) => l.refId)).toEqual([`${o.number}_1`])
    expect(p.payload.order_id).toBe(o.number)
    expect(p.payload.order_items.length).toBe(1)
    expect((await push(o.id, p.payloadHash)).status).toBe(200)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', exportedAt: null, supplierHandoffAt: null })
    const marked = await prisma.orderLine.findMany({ where: { orderId: o.id }, orderBy: { linePosition: 'asc' } })
    expect(marked[0].exportedToSupplierId).toBe(SUP)
    expect(marked[1].exportedAt).toBeNull()
    expect(await (await preview(o.id)).json()).toMatchObject({ canPush: false, laterSend: false })

    await approveOpenLine(o, lineId)
    const later = await (await preview(o.id)).json()
    expect(later).toMatchObject({ laterSend: true, canPush: true, activePush: { externalOrderId: o.number } })
    expect(later.lines.map((l: any) => l.refId)).toEqual([`${o.number}_2`])
    expect(later.payload.order_id).toBe(`${o.number}-R2`)
    expect((await push(o.id, later.payloadHash)).status).toBe(200)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ pipelineStatus: 'EXPORTED', supplierHandoffMode: 'API' })
    expect((await prisma.supplierOrderPush.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' } })).map(r => [r.externalOrderId, r.status]))
      .toEqual([[o.number, 'CREATED'], [`${o.number}-R2`, 'CREATED']])
    expect((await push(o.id, later.payloadHash)).status).toBe(409)
  })

  it('refuses a later send while the earlier result is unknown', async () => {
    const o = await makeOrder()
    const first = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    const lineId = await addOpenLine(o, first)
    await prisma.supplierOrderPush.create({ data: { orderId: o.id, supplierId: SUP, externalOrderId: o.number, status: 'SENDING', activeKey: `${o.id}::${SUP}`, requestJson: '{}', prevExportJson: JSON.stringify({ lineIds: [first.id] }) } })
    await approveOpenLine(o, lineId)
    const p = await (await preview(o.id)).json()
    expect(p).toMatchObject({ laterSend: false, canPush: false })
    expect(p.issues.map((i: any) => i.code)).toContain('ACTIVE_PUSH')
    expect((await push(o.id, p.payloadHash ?? 'x')).status).toBe(409)
  })
})
