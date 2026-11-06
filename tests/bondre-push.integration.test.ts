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
import { syncBondreTracking } from '@/lib/repos/bondre-push'
import { resyncOrder } from './helpers/resync-order'
import { BONDRE_KEYS, bondreSession, getBondreSettings } from '@/lib/bondre-settings'
import { GET as getPreview } from '@/app/api/fulfillment/bondre/orders/[orderId]/preview/route'
import { POST as postPush } from '@/app/api/fulfillment/bondre/orders/[orderId]/push/route'
import { POST as postCancel } from '@/app/api/fulfillment/bondre/orders/[orderId]/cancel/route'
import { POST as postRefresh } from '@/app/api/fulfillment/bondre/orders/[orderId]/refresh/route'
import { GET as getSettingsRoute, PUT as putSettingsRoute } from '@/app/api/fulfillment/bondre/settings/route'
import { POST as postSettingsTest } from '@/app/api/fulfillment/bondre/settings/test/route'
import { GET as getSkuMap } from '@/app/api/fulfillment/bondre/sku-map/route'

const SHOP = 'bdstore.myshopify.com'
const PROJECT = 'proj_bd'
const SUP = 'sup_bd'
const SKU = '115OZ'
const API_SKU = 'Cauldron Mug / 11.5oz'
const ORIGIN = 'https://bondre.vip'
const APP_URL = 'https://tool.shop-example.com'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-storage-'))

let storeId = ''
let adminToken = ''
let superToken = ''
let seq = 0

type Call = { path: string; query: URLSearchParams; method: string; headers: Record<string, string>; body: string }
type Reply = { status: number; json: unknown } | 'network-error'
type RemoteOrder = { orderId: number; code: string; status: string; tracking: string | null }
let calls: Call[] = []
let handler: (call: Call) => Reply | Promise<Reply>
let remoteOrders: Map<string, RemoteOrder>
let remotePreviews: Map<string, { previewId: number; syncError: string | null }>
let tokensIssued = 0
let nextId = 100

const ok = (data: unknown): Reply => ({ status: 200, json: { code: 200, msg: 'Success', requestId: 'r', data } })

function defaultHandler(call: Call): Reply {
  const p = call.path.replace('/api/open/v1', '')
  if (p === '/auth/token') {
    tokensIssued++
    return ok({ token: `tok-${tokensIssued}`, tokenType: 'Bearer', expireTime: '2030-01-01T00:00:00Z' })
  }
  if (p === '/account') return ok({ businessName: 'TM Team', balance: 5, creditLimit: 0, availableAmount: 5 })
  if (p === '/skus') {
    return ok({ total: 2, rows: [
      { skuName: API_SKU, skuCode: 'CM-115', productName: 'Cauldron Mug' },
      { skuName: 'Rug 36IN', skuCode: 'CFXHDD-36IN', productName: 'Rug' },
    ] })
  }
  if (p === '/orders/quote') return ok({ preview: true, orderId: 0, warnings: [], errors: [] })
  if (p === '/orders' && call.method === 'POST') {
    const body = JSON.parse(call.body)
    const id = nextId++
    remoteOrders.set(body.merchantOrderCode, { orderId: id, code: `PO-${body.merchantOrderCode}`, status: 'Pending Payment', tracking: null })
    return ok({ previewId: id, merchantOrderCode: body.merchantOrderCode, autoSync: true, syncStatus: 'SYNCED', orderCode: `PO-${body.merchantOrderCode}`, orderCodes: [`PO-${body.merchantOrderCode}`], previewOrderCodes: ['PO-X'], syncError: null })
  }
  if (p === '/orders' && call.method === 'GET') {
    const code = call.query.get('merchantOrderCode') ?? ''
    const o = remoteOrders.get(code)
    return ok({ total: o ? 1 : 0, rows: o ? [{ orderId: o.orderId, orderCode: o.code, merchantOrderCode: code, status: o.status }] : [] })
  }
  const detail = p.match(/^\/orders\/(\d+)$/)
  if (detail) {
    const found = Array.from(remoteOrders.entries()).find(([, o]) => o.orderId === Number(detail[1]))
    if (!found) return { status: 404, json: { code: 404, msg: 'Order not found' } }
    const [code, o] = found
    return ok({
      orderId: o.orderId, orderCode: o.code, merchantOrderCode: code, status: o.status, memberOrderIds: [o.orderId],
      packages: [{ packageId: 1, orderId: o.orderId, trackingNo: o.tracking, packageStatus: o.status, orderItems: [{ skuName: API_SKU, quantity: 1 }] }],
    })
  }
  const cancel = p.match(/^\/orders\/(\d+)\/cancel$/)
  if (cancel) {
    for (const [code, o] of Array.from(remoteOrders.entries())) if (o.orderId === Number(cancel[1])) remoteOrders.delete(code)
    return ok({})
  }
  if (p === '/order-previews') {
    const rows = Array.from(remotePreviews.entries()).map(([merchantOrderCode, v]) => ({ merchantOrderCode, status: 'PENDING', ...v }))
    return ok({ total: rows.length, pageNum: 1, pageSize: 100, rows })
  }
  if (p === '/order-previews/delete') {
    const id = JSON.parse(call.body).previewIds[0]
    for (const [code, v] of Array.from(remotePreviews.entries())) if (v.previewId === id) remotePreviews.delete(code)
    return ok({ totalCount: 1, successCount: 1, failureCount: 0, results: [{ previewId: id, success: true, message: 'Deleted' }] })
  }
  return { status: 404, json: { code: 404, msg: `unexpected path in test: ${p}` } }
}

const callsTo = (suffix: string, method?: string) => calls.filter(c => c.path.endsWith(suffix) && (!method || c.method === method))

async function req(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const base = (orderId: string) => `http://x/api/fulfillment/bondre/orders/${encodeURIComponent(orderId)}`
const preview = async (orderId: string) => getPreview(await req(`${base(orderId)}/preview`, adminToken), { params: { orderId } })
const push = async (orderId: string, payloadHash: string) =>
  postPush(await req(`${base(orderId)}/push`, adminToken, post({ confirm: true, payloadHash })), { params: { orderId } })
const cancel = async (orderId: string) => postCancel(await req(`${base(orderId)}/cancel`, adminToken, post({ confirm: true })), { params: { orderId } })
const refresh = async (orderId: string) => postRefresh(await req(`${base(orderId)}/refresh`, adminToken, post({})), { params: { orderId } })

async function makeOrder(opts: { approved?: boolean; supplierSku?: string; note?: string } = {}) {
  seq++
  const id = `gid://test/Order/bd-${seq}`
  const number = `#BD${1000 + seq}`
  const lineId = `bdl-${seq}`
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 29.45, expectedPayout: 28.3, totalFees: 1.15, refundedAmount: 0, placedAt: new Date('2026-10-15T19:28:06Z'),
      pipelineStatus: 'READY_TO_PRODUCTION', orderType: 'NON_CUSTOM', designReady: opts.approved !== false,
      customerEmail: 'sal@example.com', customerName: 'Sal Paint',
      shippingName: 'Sal Paint', shippingAddress1: '12 Main St', shippingAddress2: 'Apt 4', shippingCity: 'Denver',
      shippingZip: '80202', shippingPhone: '+1 303 555 0100', shippingCountry: 'US', shippingState: 'Colorado',
      lines: { create: [{
        shopifyLineId: lineId, productTitle: 'Secret Family Cauldron', variantTitle: '11.5oz', qty: 2, linePosition: 1, unitPrice: 24.95,
        resolvedSupplierId: SUP, resolvedSupplierSku: opts.supplierSku ?? SKU, customized: false,
        imageUrl: 'https://cdn.shopify.com/s/files/mug.jpg', designNote: opts.note ?? null,
        designDriveLink: opts.approved === false ? null : '/api/design-studio/file/placeholder',
      }] },
      designTasks: { create: [{ shopifyLineId: lineId, taskKey: `BD${1000 + seq}_1`, status: opts.approved === false ? 'NEW' : 'DONE' }] },
    },
  })
  const rel = `design/bd-${seq}/print.png`
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), PNG)
  await prisma.designArtwork.create({
    data: {
      orderId: id, shopifyLineId: lineId, printArea: 'Print', version: 1, fileName: 'print.png', storagePath: rel,
      size: PNG.length, mimeType: 'image/png', widthPx: 1570, heightPx: 650,
    },
  })
  return { id, number: number.replace('#', '') }
}

const saveCreds = () => Promise.all([
  prisma.appSetting.upsert({ where: { key: BONDRE_KEYS.email }, create: { key: BONDRE_KEYS.email, value: 'fulfil@example.com' }, update: { value: 'fulfil@example.com' } }),
  prisma.appSetting.upsert({ where: { key: BONDRE_KEYS.password }, create: { key: BONDRE_KEYS.password, value: 'pw-secret' }, update: { value: 'pw-secret' } }),
])
const clearCreds = () => prisma.appSetting.deleteMany({ where: { key: { in: Object.values(BONDRE_KEYS) } } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await setCsvLocked(false)
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'BD', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'bondre' }, create: { id: SUP, name: 'Bondre', code: 'bondre' }, update: {} })
  const template = await prisma.printTemplate.create({
    data: { supplierId: SUP, supplierSku: SKU, name: 'Bondre cốc vạc', widthPx: 1570, heightPx: 650, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 1570, h: 650 }]) },
  })
  await prisma.supplierProduct.create({
    data: { supplierId: SUP, sku: SKU, apiSku: API_SKU, productName: 'Cauldron Mug', variant1Name: 'Size', variant1Value: '11.5oz', baseCost: 13.8, printTemplateId: template.id },
  })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'NOAPI', productName: 'Tree Topper', variant1Name: 'Size', variant1Value: '6 in', baseCost: 10 } })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'FASTSKU', apiSku: 'Fast Mug', apiShipClass: 'Fast', baseCost: 10 } })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'BADSHIP', apiSku: 'Bad Mug', apiShipClass: 'Overnight', baseCost: 10 } })
  const adminId = (await prisma.appUser.upsert({ where: { email: 'admin@bd.test' }, create: { name: 'Admin', email: 'admin@bd.test', role: 'ADMIN', permissions: JSON.stringify([]), passwordHash: 'x' }, update: {} })).id
  adminToken = await signToken({ userId: adminId, email: 'admin@bd.test', name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
  const superId = (await prisma.appUser.upsert({ where: { email: 'super@bd.test' }, create: { name: 'Super', email: 'super@bd.test', role: 'SUPERADMIN', permissions: JSON.stringify([]), passwordHash: 'x' }, update: {} })).id
  superToken = await signToken({ userId: superId, email: 'super@bd.test', name: 'Super', role: 'SUPERADMIN', permissions: [], tv: 0 })
})

afterAll(async () => {
  await clearCreds()
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['admin@bd.test', 'super@bd.test'] } } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
  delete process.env.NEXT_PUBLIC_APP_URL
})

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = APP_URL
  await clearCreds()
  await saveCreds()
  calls = []
  remoteOrders = new Map()
  remotePreviews = new Map()
  tokensIssued = 0
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

describe('Bondre preview', () => {
  it('builds an auto-synced order from the mapped SKU and the approved file', async () => {
    const o = await makeOrder()
    const res = await preview(o.id)
    expect(res.status).toBe(200)
    const p = await res.json()
    expect(p.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(p.canPush).toBe(true)
    expect(p.payload).toMatchObject({
      merchantOrderCode: o.number, orderType: 'Official Order', autoSync: true,
      packages: [{
        recipientName: 'Sal Paint', phoneNumber: '+1 303 555 0100', streetAddress: '12 Main St, Apt 4', city: 'Denver', stateCode: 'CO',
        postcode: '80202', countryCode: 'US', expressShippingType: 1,
        items: [{ skuName: API_SKU, quantity: 2, mockup1: 'https://cdn.shopify.com/s/files/mug.jpg' }],
      }],
    })
    expect(p.payload.packages[0].items[0].design1).toMatch(new RegExp(`^${APP_URL}/api/public/artwork/`))
  })

  it('sends no product title, shop domain or shopper email', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    const sent = JSON.stringify(p.payload)
    expect(sent).not.toContain('Secret Family')
    expect(sent).not.toContain(SHOP)
    expect(sent).not.toContain('sal@example.com')
  })

  it('keeps the internal CS note out of what Bondre receives, and says so', async () => {
    const o = await makeOrder({ note: 'Customer is angry, refund next' })
    const p = await (await preview(o.id)).json()
    expect(JSON.stringify(p.payload)).not.toContain('Customer is angry')
    expect(p.issues.find((i: any) => i.code === 'DESIGN_NOTE')).toMatchObject({ level: 'warning' })
  })

  it('checks the order with a quote, which creates nothing on Bondre', async () => {
    const o = await makeOrder()
    await preview(o.id)
    expect(callsTo('/orders/quote')).toHaveLength(1)
    expect(callsTo('/orders', 'POST')).toHaveLength(0)
  })

  it('blocks what Bondre refuses in the quote, and shows its warnings', async () => {
    const o = await makeOrder()
    handler = call => call.path.endsWith('/orders/quote')
      ? { status: 404, json: { code: 404, msg: `SKU Name was not found: ${API_SKU}` } }
      : defaultHandler(call)
    const refused = await (await preview(o.id)).json()
    expect(refused.canPush).toBe(false)
    expect(refused.issues.find((i: any) => i.code === 'BONDRE_REFUSED')).toMatchObject({ level: 'error', message: expect.stringContaining('SKU Name was not found') })

    handler = call => call.path.endsWith('/orders/quote') ? ok({ preview: true, warnings: ['Remote postcode surcharge'], errors: [] }) : defaultHandler(call)
    const warned = await (await preview(o.id)).json()
    expect(warned.canPush).toBe(true)
    expect(warned.issues.find((i: any) => i.code === 'BONDRE_WARNING')).toMatchObject({ level: 'warning', message: 'Remote postcode surcharge' })
  })

  it('still lets a person send when the quote gets no answer', async () => {
    const o = await makeOrder()
    handler = call => call.path.endsWith('/orders/quote') ? 'network-error' : defaultHandler(call)
    const p = await (await preview(o.id)).json()
    expect(p.canPush).toBe(true)
    expect(p.issues.find((i: any) => i.code === 'QUOTE_UNAVAILABLE')).toMatchObject({ level: 'warning' })
  })

  it('blocks a SKU not matched to Bondre, an unapproved design and a line already sent', async () => {
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

  it('reads the ship method per SKU and refuses one Bondre does not have', async () => {
    const fast = await makeOrder({ supplierSku: 'FASTSKU' })
    expect((await (await preview(fast.id)).json()).payload.packages[0].expressShippingType).toBe(2)

    const bad = await makeOrder({ supplierSku: 'BADSHIP' })
    const p = await (await preview(bad.id)).json()
    expect(p.issues.find((i: any) => i.code === 'SHIP_METHOD')).toMatchObject({ level: 'error' })
  })

  it('needs the account to be saved', async () => {
    const o = await makeOrder()
    await clearCreds()
    const p = await (await preview(o.id)).json()
    expect(p.hasCredentials).toBe(false)
    expect(p.canPush).toBe(false)
    expect(p.issues.find((i: any) => i.code === 'NO_CREDENTIALS')).toMatchObject({ level: 'error' })
    expect(calls).toHaveLength(0)
  })
})

describe('Bondre push', () => {
  it('makes a real order in one call, marks the order exported and refuses a second send', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.exported).toBe(true)
    expect(body.push).toMatchObject({ status: 'CREATED', externalOrderId: o.number, supplierOrderCode: `PO-${o.number}` })
    const sent = callsTo('/orders', 'POST')
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0].body).autoSync).toBe(true)
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    expect(line.exportedToSupplierId).toBe(SUP)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('EXPORTED')

    const again = await push(o.id, p.payloadHash)
    expect(again.status).toBe(409)
    expect(callsTo('/orders', 'POST')).toHaveLength(1)
  })

  it('keeps Bondre cost out of the cost fields, since Bondre prices in RMB', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    const body = await (await push(o.id, p.payloadHash)).json()
    expect(body.push.totalCost).toBeNull()
    expect(body.push.shippingFee).toBeNull()
  })

  it('renews an expired token without sending the order twice', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    let expired = true
    handler = call => {
      if (expired && call.path.endsWith('/orders') && call.method === 'POST') {
        expired = false
        return { status: 401, json: { code: 401, msg: 'Token has expired' } }
      }
      return defaultHandler(call)
    }
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(200)
    expect(tokensIssued).toBe(2)
    expect(callsTo('/orders', 'POST')).toHaveLength(2)
    expect(Array.from(remoteOrders.keys())).toEqual([o.number])
  })

  it('records a refusal with no preview as FAILED and lets the retry reuse the order number', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => call.path.endsWith('/orders') && call.method === 'POST'
      ? { status: 404, json: { code: 404, msg: 'SKU Name was not found: X' } }
      : defaultHandler(call)
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('SKU Name was not found')
    expect((await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe('FAILED')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')

    handler = defaultHandler
    const retry = await (await preview(o.id)).json()
    expect(retry.payload.merchantOrderCode).toBe(o.number)
    expect((await push(o.id, retry.payloadHash)).status).toBe(200)
  })

  it('clears the preview of a failed sync and re-sends under a fresh number, since the old one stays taken', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => {
      if (call.path.endsWith('/orders') && call.method === 'POST') {
        const code = JSON.parse(call.body).merchantOrderCode
        remotePreviews.set(code, { previewId: 777, syncError: 'Out of stock' })
        return { status: 422, json: { code: 588, msg: 'Sync failed', data: { previewId: 777, syncStatus: 'FAILED', orderCode: 'PO-R', orderCodes: [], syncError: 'Out of stock' } } }
      }
      return defaultHandler(call)
    }
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Out of stock')
    const rows = await prisma.supplierOrderPush.findMany({ where: { orderId: o.id } })
    expect(rows[0]).toMatchObject({ status: 'FAILED', supplierInternalId: '777' })
    expect(JSON.parse(callsTo('/order-previews/delete')[0].body)).toEqual({ previewIds: [777] })
    expect(remotePreviews.size).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')

    handler = defaultHandler
    const retry = await (await preview(o.id)).json()
    expect(retry.payload.merchantOrderCode).toBe(`${o.number}-R2`)
    expect((await push(o.id, retry.payloadHash)).status).toBe(200)
  })

  it('keeps an unanswered create live until a refresh finds the order', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => {
      if (call.path.endsWith('/orders') && call.method === 'POST') {
        remoteOrders.set(o.number, { orderId: 500, code: `PO-${o.number}`, status: 'Pending Payment', tracking: null })
        return 'network-error'
      }
      return defaultHandler(call)
    }
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(504)
    expect((await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe('SENDING')
    const blocked = await (await preview(o.id)).json()
    expect(blocked.issues.find((i: any) => i.code === 'ACTIVE_PUSH')).toMatchObject({ level: 'error' })

    handler = defaultHandler
    const r = await (await refresh(o.id)).json()
    expect(r.found).toBe(true)
    expect(r.push).toMatchObject({ status: 'CREATED', supplierOrderCode: `PO-${o.number}`, remoteStatus: 'Pending Payment' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('EXPORTED')
  })

  it('treats a 500 that says UNKNOWN as not known, never as a refusal', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => call.path.endsWith('/orders') && call.method === 'POST'
      ? { status: 500, json: { code: 500, msg: 'Error', data: { previewId: 88, syncStatus: 'UNKNOWN' } } }
      : defaultHandler(call)
    expect((await push(o.id, p.payloadHash)).status).toBe(504)
    const row = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    expect(row.status).toBe('SENDING')
    expect(callsTo('/order-previews/delete')).toHaveLength(0)
  })

  it('after the grace time a refresh closes a send that only left a preview', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    handler = call => {
      if (call.path.endsWith('/orders') && call.method === 'POST') {
        remotePreviews.set(o.number, { previewId: 321, syncError: 'Stock check failed' })
        return 'network-error'
      }
      return defaultHandler(call)
    }
    await push(o.id, p.payloadHash)
    await prisma.supplierOrderPush.updateMany({ where: { orderId: o.id }, data: { pushedAt: new Date(Date.now() - 10 * 60_000) } })

    handler = defaultHandler
    const r = await (await refresh(o.id)).json()
    expect(r.found).toBe(false)
    expect(r.push).toMatchObject({ status: 'FAILED', error: expect.stringContaining('Stock check failed') })
    expect(remotePreviews.size).toBe(0)
    const retry = await (await preview(o.id)).json()
    expect(retry.payload.merchantOrderCode).toBe(`${o.number}-R2`)
  })

  it('a hash from an older preview is refused', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await prisma.order.update({ where: { id: o.id }, data: { shippingCity: 'Boulder' } })
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PAYLOAD_CHANGED')
    expect(callsTo('/orders', 'POST')).toHaveLength(0)
  })
})

describe('Bondre cancel', () => {
  it('cancels by the formal order id, restores the order and re-sends under a fresh number', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await push(o.id, p.payloadHash)
    const orderId = remoteOrders.get(o.number)!.orderId

    const res = await cancel(o.id)
    expect(res.status).toBe(200)
    expect((await res.json()).exportReverted).toBe(true)
    const sent = callsTo(`/orders/${orderId}/cancel`)
    expect(sent).toHaveLength(1)
    expect(sent[0].headers['Idempotency-Key']).toBeTruthy()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })).exportedAt).toBeNull()

    const retry = await (await preview(o.id)).json()
    expect(retry.payload.merchantOrderCode).toBe(`${o.number}-R2`)
  })

  it('a push Bondre has no formal order for cannot be cancelled blind', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await push(o.id, p.payloadHash)
    remoteOrders.clear()
    const res = await cancel(o.id)
    expect(res.status).toBe(404)
    expect((await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe('CREATED')
  })
})

describe('Bondre tracking', () => {
  it('a refresh writes the tracking on the line, and Auto Fulfill picks it up', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await push(o.id, p.payloadHash)
    remoteOrders.get(o.number)!.tracking = 'YT9001'
    const r = await (await refresh(o.id)).json()
    expect(r.shipments).toBe(1)
    const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } })
    expect(shipment).toMatchObject({ trackingNumber: 'YT9001', supplierId: SUP, lineKey: `${o.number}_1` })
    const rows = await pushedShipmentRows(storeId)
    expect(rows.get(o.number)).toEqual([{ lineKey: `${o.number}_1`, tracking: 'YT9001' }])
  })

  it('the sync walks the live pushes and leaves a closed order alone', async () => {
    const o = await makeOrder()
    const closed = await makeOrder()
    for (const x of [o, closed]) {
      const p = await (await preview(x.id)).json()
      await push(x.id, p.payloadHash)
    }
    remoteOrders.get(o.number)!.tracking = 'YT9002'
    remoteOrders.get(closed.number)!.tracking = 'YT9003'
    await prisma.order.update({ where: { id: closed.id }, data: { pipelineStatus: 'FULFILLED' } })
    const before = calls.length
    const result = await syncBondreTracking()
    expect(result.shipments).toBe(1)
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } })).trackingNumber).toBe('YT9002')
    expect(await prisma.shipment.count({ where: { orderId: closed.id } })).toBe(0)
    expect(calls.slice(before).some(c => c.query.get('merchantOrderCode') === closed.number)).toBe(false)
    await prisma.order.deleteMany({ where: { id: { in: [o.id, closed.id] } } })
  })

  it('the sync does nothing without an account', async () => {
    await clearCreds()
    await expect(syncBondreTracking()).resolves.toMatchObject({ pushes: 0, skipped: expect.any(String) })
    expect(calls).toHaveLength(0)
  })
})

// The order sync makes every OrderLine anew each time it reads the order (#LIT6041, #LIT6087: both stored ids gone by 11-05).
describe('Bondre tracking after the order sync made the lines anew', () => {
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
    remoteOrders.get(o.number)!.tracking = 'YT9101'
    expect((await (await refresh(o.id)).json()).shipments).toBe(1)
    expect(await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } }))
      .toMatchObject({ lineKey: `${o.number}_1`, shopifyLineId: line.shopifyLineId, trackingNumber: 'YT9101', supplierId: SUP })
  })

  it('a push stored with OrderLine ids only finds its line by the print file it sent', async () => {
    const { o, line, row } = await pushed()
    const { shopifyLineIds: _recorded, ...older } = JSON.parse(row.prevExportJson!)
    await prisma.supplierOrderPush.update({ where: { id: row.id }, data: { prevExportJson: JSON.stringify(older) } })
    await resyncOrder(o.id)
    remoteOrders.get(o.number)!.tracking = 'YT9102'
    await syncBondreTracking()
    expect(await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } }))
      .toMatchObject({ lineKey: `${o.number}_1`, shopifyLineId: line.shopifyLineId, trackingNumber: 'YT9102', supplierId: SUP })
  })
})

describe('handoff with Bondre', () => {
  it('opens the Bondre window once an account is saved', async () => {
    const o = await makeOrder()
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, mode: 'API', apiName: 'Bondre', apiKind: 'bondre', apiNote: null })
    const tabs = await listHandoffTabs()
    expect(tabs.find(t => t.id === SUP)?.channel).toBe('API')
  })

  it('an open Bondre line cannot be saved for CSV once an account is saved', async () => {
    const o = await makeOrder()
    await expect(handoffOrderCsv(o.id, null)).rejects.toMatchObject({ code: 'BONDRE_API_ONLY' })
  })

  it('stays on the CSV route without an account, so deploying changes nothing', async () => {
    const o = await makeOrder()
    await clearCreds()
    expect(await handoffStateFor(o.id)).toMatchObject({ mode: 'CSV', apiName: null })
    const tabs = await listHandoffTabs()
    expect(tabs.find(t => t.id === SUP)?.channel).toBe('CSV')
  })

  it('sends only the Bondre lines of a mixed order and leaves the other supplier\'s line open', async () => {
    const o = await makeOrder()
    await prisma.supplier.upsert({ where: { code: 'other_bd_test' }, create: { id: 'sup_other_bd', name: 'Printway', code: 'other_bd_test' }, update: {} })
    await prisma.orderLine.create({
      data: {
        orderId: o.id, shopifyLineId: `bdl-other-${seq}`, productTitle: 'Hoodie', variantTitle: 'L', qty: 1, linePosition: 2,
        unitPrice: 39.95, resolvedSupplierId: 'sup_other_bd', resolvedSupplierSku: 'HD-L', customized: false, sku: 'HD-L',
      },
    })
    expect(await handoffStateFor(o.id)).toMatchObject({ mode: 'API', apiKind: 'bondre', csvRemainder: true, apiNote: expect.stringContaining('dòng Bondre') })
    const p = await (await preview(o.id)).json()
    expect(p.issues.find((i: any) => i.code === 'MIXED_SUPPLIER')).toMatchObject({ level: 'warning' })
    expect(p.payload.packages[0].items).toHaveLength(1)
    expect((await push(o.id, p.payloadHash)).status).toBe(200)
    const lines = await prisma.orderLine.findMany({ where: { orderId: o.id }, orderBy: { linePosition: 'asc' } })
    expect(lines[0].exportedToSupplierId).toBe(SUP)
    expect(lines[1].exportedAt).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect(await handoffStateFor(o.id)).toMatchObject({ mode: 'CSV', apiKind: 'bondre', csvRemainder: true })
    await prisma.orderLine.deleteMany({ where: { orderId: o.id, linePosition: 2 } })
    await prisma.supplier.deleteMany({ where: { id: 'sup_other_bd' } })
  })
})

describe('Bondre settings', () => {
  const url = 'http://x/api/fulfillment/bondre/settings'
  const put = (body: unknown, token = superToken) => req(url, token, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }).then(r => putSettingsRoute(r))

  it('keeps the first token until it expires, and logs in only when it has to', async () => {
    const session = bondreSession(await getBondreSettings())
    expect(await session.token()).toBe('tok-1')
    const again = bondreSession(await getBondreSettings())
    expect(await again.token()).toBe('tok-1')
    expect(tokensIssued).toBe(1)
    expect(await again.renew()).toBe('tok-2')
    expect(tokensIssued).toBe(2)
  })

  it('never returns the password or the token', async () => {
    const session = bondreSession(await getBondreSettings())
    await session.token()
    const res = await getSettingsRoute(await req(url, adminToken))
    const text = await res.text()
    expect(text).not.toContain('pw-secret')
    expect(text).not.toContain('tok-1')
    expect(JSON.parse(text)).toMatchObject({ email: 'fulfil@example.com', hasPassword: true })
  })

  it('only a superadmin saves the account', async () => {
    const res = await put({ email: 'x@example.com' }, adminToken)
    expect(res.status).toBe(403)
    expect((await getBondreSettings()).email).toBe('fulfil@example.com')
  })

  it('a blank password keeps the saved one; a new one drops the old token', async () => {
    const session = bondreSession(await getBondreSettings())
    await session.token()
    expect((await put({ email: 'new@example.com', password: '' })).status).toBe(200)
    expect(await getBondreSettings()).toMatchObject({ email: 'new@example.com', password: 'pw-secret', token: null })

    await bondreSession(await getBondreSettings()).token()
    expect((await put({ password: 'pw-new' })).status).toBe(200)
    expect(await getBondreSettings()).toMatchObject({ password: 'pw-new', token: null })
  })

  it('null removes the account, and the tab goes back to the CSV route', async () => {
    expect((await put({ email: null, password: null })).status).toBe(200)
    expect(await getBondreSettings()).toMatchObject({ email: null, password: null, token: null })
    expect((await listHandoffTabs()).find(t => t.id === SUP)?.channel ?? 'CSV').toBe('CSV')
  })

  it('the test call reads the Bondre account', async () => {
    const res = await postSettingsTest(await req(`${url}/test`, adminToken, post({})))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, account: { businessName: 'TM Team', availableAmount: 5 } })
  })

  it('the test call says when the account is refused', async () => {
    handler = call => call.path.endsWith('/auth/token') ? { status: 401, json: { code: 401, msg: 'Wrong password' } } : defaultHandler(call)
    const res = await postSettingsTest(await req(`${url}/test`, adminToken, post({})))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Wrong password')
  })

  it('the SKU map lists the tool SKUs with Bondre SKUs and a first guess', async () => {
    const res = await getSkuMap(await req('http://x/api/fulfillment/bondre/sku-map', adminToken))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.supplierSkus.map((s: any) => s.skuName)).toEqual([API_SKU, 'Rug 36IN'])
    expect(body.products.find((p: any) => p.sku === SKU)).toMatchObject({ apiSku: API_SKU, suggestion: API_SKU })
    expect(body.products.find((p: any) => p.sku === 'NOAPI')).toMatchObject({ apiSku: null, suggestion: null })
  })
})

const addOpenLine = async (o: { id: string; number: string }, firstLine: { resolvedSupplierSku: string | null; imageUrl: string | null }) => {
  const lineId = `bdl-open-${seq}`
  await prisma.orderLine.create({ data: {
    orderId: o.id, shopifyLineId: lineId, productTitle: 'Second Mug', qty: 1, linePosition: 2, unitPrice: 24.95,
    resolvedSupplierId: SUP, resolvedSupplierSku: firstLine.resolvedSupplierSku, customized: false, imageUrl: firstLine.imageUrl,
  } })
  await prisma.designTask.create({ data: { orderId: o.id, shopifyLineId: lineId, taskKey: `${o.number}_2`, status: 'NEW' } })
  await prisma.order.update({ where: { id: o.id }, data: { pipelineStatus: 'PENDING_DESIGN', designReady: false } })
  const rel = `design/bdl-open-${seq}/print.png`
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), PNG)
  await prisma.designArtwork.create({ data: {
    orderId: o.id, shopifyLineId: lineId, printArea: 'Print', version: 1, fileName: 'print.png', storagePath: rel, size: PNG.length, mimeType: 'image/png', widthPx: 1570, heightPx: 650,
  } })
  return lineId
}
const approveOpenLine = async (o: { id: string; number: string }, lineId: string) => {
  await prisma.orderLine.updateMany({ where: { orderId: o.id, shopifyLineId: lineId }, data: { designDriveLink: '/api/design-studio/file/placeholder' } })
  await prisma.designTask.update({ where: { taskKey: `${o.number}_2` }, data: { status: 'DONE' } })
  await prisma.order.update({ where: { id: o.id }, data: { pipelineStatus: 'READY_TO_PRODUCTION', designReady: true } })
}

describe('Bondre: lines approved at different times', () => {
  it('sends the approved line, leaves the open one in design, and sends it later under its own number', async () => {
    const o = await makeOrder()
    const first = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    const lineId = await addOpenLine(o, first)

    const p = await (await preview(o.id)).json()
    expect(p.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(p.issues.find((i: any) => i.code === 'DESIGN_OPEN')).toMatchObject({ level: 'warning' })
    expect(p.lines.map((l: any) => l.refId)).toEqual([`${o.number}_1`])
    expect(p.payload.merchantOrderCode).toBe(o.number)
    expect(p.payload.packages[0].items.length).toBe(1)
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
    expect(later.payload.merchantOrderCode).toBe(`${o.number}-R2`)
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
