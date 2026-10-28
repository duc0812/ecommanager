import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { handoffStates } from '@/lib/supplier-handoff'
import { GET as getPreview } from '@/app/api/fulfillment/merchize/orders/[orderId]/preview/route'
import { POST as postPush } from '@/app/api/fulfillment/merchize/orders/[orderId]/push/route'
import { POST as postCancel } from '@/app/api/fulfillment/merchize/orders/[orderId]/cancel/route'
import { POST as postRefresh } from '@/app/api/fulfillment/merchize/orders/[orderId]/refresh/route'

const SHOP = 'mzstore.myshopify.com'
const PROJECT = 'proj_mz'
const SUP = 'sup_mz'
const API = 'https://bo-group-1-2.merchize.com/abc123/bo-api'
const APP_URL = 'https://tool.shop-example.com'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-storage-'))

let storeId = ''
let adminToken = ''
let seq = 0

type Call = { path: string; query: URLSearchParams; method: string; headers: Record<string, string>; body: string }
type Reply = { status: number; json: unknown } | 'network-error'
let calls: Call[] = []
let handler: (call: Call) => Reply | Promise<Reply>
let remoteOrders: Set<string>

const CATALOG = {
  success: true,
  data: {
    total: 1, products: [{
      _id: 'cat-5000us', sku: '5000US', title: 'Classic Unisex T-Shirt Gildan 5000 (Made In US)', printing_methods: ['DTF', 'DTG'],
      fulfillment_location: { name: 'US', code: 'US' }, mockup_and_templates_link: null, production_time: { min: 1, max: 3 },
      variants: [{
        _id: 'v1', sku: '5000US000LTBAA03',
        attributes: [
          { name: 'color', type: 'color', value_text: 'Light Blue', value_code: 'lightblue' },
          { name: 'size', type: 'size', value_text: 'L', value_code: 'l' },
        ],
        shipping_prices: [], tiers: [{ name: 'dtf_tier1', price: 5.25 }],
      }],
    }],
  },
}

function defaultHandler(call: Call): Reply {
  if (call.path.endsWith('/product/catalog')) return { status: 200, json: CATALOG }
  if (call.path.endsWith('/order/external/orders') && call.method === 'POST') {
    const body = JSON.parse(call.body)
    remoteOrders.add(body.order_id)
    return { status: 200, json: { success: true, data: { _id: `mz-${body.order_id}`, status: 'created', data: body } } }
  }
  if (call.path.endsWith('/order/external/orders/push')) return { status: 200, json: { success: true, data: true } }
  if (call.path.endsWith('/order/external/orders/cancel')) {
    remoteOrders.delete(JSON.parse(call.body).order.external_number)
    return { status: 200, json: { success: true, data: true } }
  }
  if (call.path.endsWith('/order/external/orders/order-detail')) {
    const n = call.query.get('external_number') ?? ''
    if (!remoteOrders.has(n)) return { status: 200, json: { success: false, message: 'Order does not exist' } }
    return { status: 200, json: { success: true, data: {
      _id: `mz-${n}`, code: `RX-${n}`, order_status: 'in_production', fulfillment_cost: 10.65,
      fulfillments: [{ tracking_number: '9400111', tracking_company: 'USPS', tracking_url: 'https://t.example/9400111' }],
    } } }
  }
  return { status: 404, json: { success: false, message: 'unexpected path in test' } }
}

const callsTo = (suffix: string) => calls.filter(c => c.path.endsWith(suffix))

async function req(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const base = (orderId: string) => `http://x/api/fulfillment/merchize/orders/${encodeURIComponent(orderId)}`
const preview = async (orderId: string) => getPreview(await req(`${base(orderId)}/preview`, adminToken), { params: { orderId } })
const push = async (orderId: string, payloadHash: string) =>
  postPush(await req(`${base(orderId)}/push`, adminToken, post({ confirm: true, payloadHash })), { params: { orderId } })
const cancel = async (orderId: string) => postCancel(await req(`${base(orderId)}/cancel`, adminToken, post({ confirm: true })), { params: { orderId } })
const refresh = async (orderId: string) => postRefresh(await req(`${base(orderId)}/refresh`, adminToken, post({})), { params: { orderId } })

async function makeOrder(opts: { approved?: boolean; area?: string; supplierSku?: string } = {}) {
  seq++
  const id = `gid://test/Order/mz-${seq}`
  const number = `#MZ${1000 + seq}`
  const lineId = `mzl-${seq}`
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 29.45, expectedPayout: 28.3, totalFees: 1.15, refundedAmount: 0, placedAt: new Date('2026-10-15T19:28:06Z'),
      pipelineStatus: 'READY_TO_PRODUCTION', orderType: 'NON_CUSTOM', designReady: opts.approved !== false,
      customerEmail: 'sal@example.com', customerName: 'Sal Paint',
      shippingName: 'Sal Paint', shippingAddress1: '12 Main St', shippingAddress2: '', shippingCity: 'Denver',
      shippingZip: '80202', shippingPhone: '+1 303 555 0100', shippingCountry: 'US', shippingState: 'Colorado',
      lines: { create: [{
        shopifyLineId: lineId, productTitle: 'MY EX HAS 3 SPIRIT ANIMALS', variantTitle: 'Tshirt / L / Light Blue', qty: 1, linePosition: 1, unitPrice: 24.95,
        resolvedSupplierId: SUP, resolvedSupplierSku: opts.supplierSku ?? '5000US000LTBAA03', customized: false,
        imageUrl: 'https://cdn.shopify.com/s/files/tee.jpg',
        designDriveLink: opts.approved === false ? null : '/api/design-studio/file/placeholder',
      }] },
      designTasks: { create: [{ shopifyLineId: lineId, taskKey: `MZ${1000 + seq}_1`, status: opts.approved === false ? 'NEW' : 'DONE' }] },
    },
  })
  const rel = `design/mz-${seq}/front.png`
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), PNG)
  await prisma.designArtwork.create({
    data: {
      orderId: id, shopifyLineId: lineId, printArea: opts.area ?? 'Front', version: 1, fileName: 'front.png', storagePath: rel,
      size: PNG.length, mimeType: 'image/png', widthPx: 4200, heightPx: 4800,
    },
  })
  return { id, number: number.replace('#', '') }
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'MZ', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'merchize' }, create: { id: SUP, name: 'merchize', code: 'merchize' }, update: {} })
  const template = await prisma.printTemplate.create({
    data: { supplierId: SUP, supplierSku: '5000US', name: 'Merchize Gildan 5000US', widthPx: 4200, heightPx: 4800, areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 4200, h: 4800 }]) },
  })
  await prisma.supplierProduct.create({
    data: {
      supplierId: SUP, sku: '5000US000LTBAA03', apiSku: '5000US000LTBAA03', baseSku: '5000US', productName: 'Classic Unisex T-Shirt Gildan 5000',
      variant1Name: 'Size', variant1Value: 'L', variant2Name: 'Color', variant2Value: 'Light Blue', baseCost: 5.25, printTemplateId: template.id,
    },
  })
  await prisma.supplierProduct.create({
    data: { supplierId: SUP, sku: '5000US000GONE03', baseSku: '5000US', baseCost: 5.25, printTemplateId: template.id },
  })
  const adminId = (await prisma.appUser.upsert({ where: { email: 'admin@mz.test' }, create: { name: 'Admin', email: 'admin@mz.test', role: 'ADMIN', permissions: JSON.stringify(DEFAULT_ROLE_PERMISSIONS.ADMIN) }, update: {} })).id
  adminToken = await signToken({ userId: adminId, email: 'admin@mz.test', name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: 'admin@mz.test' } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.MERCHIZE_API_URL
  delete process.env.MERCHIZE_API_TOKEN
})

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP_URL
  process.env.MERCHIZE_API_URL = API
  process.env.MERCHIZE_API_TOKEN = 'mz-test-token'
  calls = []
  remoteOrders = new Set()
  handler = defaultHandler
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin !== new URL(API).origin) throw new Error(`test blocked a call to ${url.origin}`)
    const call: Call = { path: url.pathname, query: url.searchParams, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') }
    calls.push(call)
    const reply = await handler(call)
    if (reply === 'network-error') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('Merchize preview', () => {
  it('builds the external-order body from the catalogue variant and the approved front file', async () => {
    const o = await makeOrder()
    const res = await preview(o.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    const art = await prisma.designArtwork.findFirstOrThrow({ where: { orderId: o.id } })
    expect(body.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(body.payload).toEqual({
      order_id: o.number,
      identifier: 'mzstore',
      shipping_info: {
        full_name: 'Sal Paint', address_1: '12 Main St', address_2: '', city: 'Denver', state: 'CO',
        postcode: '80202', country: 'US', email: 'sal@example.com', phone: '+1 303 555 0100',
      },
      items: [{
        name: 'MY EX HAS 3 SPIRIT ANIMALS - Tshirt / L / Light Blue', sku: '5000US000LTBAA03', merchize_sku: '5000US000LTBAA03',
        product_id: 'cat-5000us', quantity: 1, price: 24.95, currency: 'USD', printing_method: 'DTF',
        image: 'https://cdn.shopify.com/s/files/tee.jpg',
        design_front: `${APP_URL}/api/public/artwork/${art.publicToken}/front.png`,
        attributes: [{ name: 'color', option: 'lightblue' }, { name: 'size', option: 'l' }],
      }],
    })
    expect(body.canPush).toBe(true)
    expect(body.lines[0].files[0]).toMatchObject({ area: 'Front', sizeOk: true, expectedWidthPx: 4200 })
    expect(callsTo('/order/external/orders')).toHaveLength(0)
    expect(callsTo('/product/catalog')[0].headers.Authorization).toBe('Bearer mz-test-token')
  })

  it('blocks an unapproved design, an unknown print side and a SKU Merchize dropped', async () => {
    const unapproved = await (await preview((await makeOrder({ approved: false })).id)).json()
    expect(unapproved.issues.map((i: any) => i.code)).toContain('NOT_APPROVED')
    expect(unapproved.canPush).toBe(false)

    const side = await (await preview((await makeOrder({ area: 'Pocket' })).id)).json()
    expect(side.issues.map((i: any) => i.code)).toContain('UNKNOWN_SIDE')

    const gone = await (await preview((await makeOrder({ supplierSku: '5000US000GONE03' })).id)).json()
    expect(gone.issues.map((i: any) => i.code)).toContain('NOT_IN_CATALOG')
  })

  it('blocks a line already exported to Merchize by CSV, so the API never makes a second order', async () => {
    const o = await makeOrder()
    await prisma.orderLine.updateMany({ where: { orderId: o.id }, data: { exportedAt: new Date('2026-10-28T01:30:51Z'), exportedToSupplierId: SUP } })
    await prisma.order.update({ where: { id: o.id }, data: { pipelineStatus: 'EXPORTED' } })
    const body = await (await preview(o.id)).json()
    expect(body.issues.map((i: any) => i.code)).toContain('ALREADY_EXPORTED')
    expect(body.canPush).toBe(false)
    expect((await push(o.id, body.payloadHash)).status).toBe(422)
    expect(callsTo('/order/external/orders')).toHaveLength(0)
  })

  it('needs the server credentials', async () => {
    delete process.env.MERCHIZE_API_TOKEN
    const body = await (await preview((await makeOrder()).id)).json()
    expect(body.issues.map((i: any) => i.code)).toContain('NO_CREDENTIALS')
    expect(body.canPush).toBe(false)
  })
})

describe('Merchize push', () => {
  it('creates, starts production, marks the order exported and refuses a second send', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.push).toMatchObject({ status: 'CREATED', externalOrderId: o.number, remoteStatus: 'pushed', error: null })
    expect(out.exported).toBe(true)
    expect(callsTo('/order/external/orders')[0].body).toBe(JSON.stringify(p.payload))
    expect(JSON.parse(callsTo('/order/external/orders/push')[0].body)).toEqual({ order: { external_number: o.number, identifier: 'mzstore' } })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.pipelineStatus).toBe('EXPORTED')
    expect(order.supplierHandoffMode).toBe('API')

    const again = await push(o.id, p.payloadHash)
    expect(again.status).toBe(409)
    expect(callsTo('/order/external/orders')).toHaveLength(1)
  })

  it('records a refusal as FAILED and lets the retry reuse the order id', async () => {
    const o = await makeOrder()
    handler = call => call.path.endsWith('/order/external/orders') && call.method === 'POST'
      ? { status: 200, json: { success: false, message: 'Invalid shipping info' } }
      : defaultHandler(call)
    const p = await (await preview(o.id)).json()
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Invalid shipping info')
    const rows = await prisma.supplierOrderPush.findMany({ where: { orderId: o.id } })
    expect(rows.map(r => r.status)).toEqual(['FAILED'])

    handler = defaultHandler
    const p2 = await (await preview(o.id)).json()
    expect((await push(o.id, p2.payloadHash)).status).toBe(200)
    const after = await prisma.supplierOrderPush.findMany({ where: { orderId: o.id } })
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe('CREATED')
  })

  it('keeps an unanswered create live until a refresh finds the order', async () => {
    const o = await makeOrder()
    handler = call => {
      if (call.path.endsWith('/order/external/orders') && call.method === 'POST') {
        remoteOrders.add(JSON.parse(call.body).order_id)
        return 'network-error'
      }
      return defaultHandler(call)
    }
    const p = await (await preview(o.id)).json()
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(504)
    const row = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    expect(row.status).toBe('SENDING')
    expect((await push(o.id, p.payloadHash)).status).toBe(409)

    handler = defaultHandler
    const r = await (await refresh(o.id)).json()
    expect(r.found).toBe(true)
    expect(r.push).toMatchObject({ status: 'CREATED', supplierOrderCode: `RX-${o.number}`, remoteStatus: 'in_production', totalCost: 10.65 })
    expect(r.shipments).toBe(1)
    const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } })
    expect(shipment).toMatchObject({ trackingNumber: '9400111', carrier: 'USPS', supplierId: SUP })
  })

  it('cancels, restores the order and re-sends under a fresh order id', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await push(o.id, p.payloadHash)
    const c = await (await cancel(o.id)).json()
    expect(c.push.status).toBe('CANCELLED')
    expect(c.exportReverted).toBe(true)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.pipelineStatus).toBe('READY_TO_PRODUCTION')

    const p2 = await (await preview(o.id)).json()
    expect(p2.payload.order_id).toBe(`${o.number}-R2`)
    expect((await push(o.id, p2.payloadHash)).status).toBe(200)
  })

  it('a hash from an older preview is refused', async () => {
    const o = await makeOrder()
    const res = await push(o.id, 'f'.repeat(64))
    expect(res.status).toBe(409)
    expect(callsTo('/order/external/orders')).toHaveLength(0)
  })
})

describe('handoff state', () => {
  it('offers the Merchize API window for an all-Merchize order', async () => {
    const o = await makeOrder()
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: o.id },
      include: {
        lines: { select: { sku: true, productTitle: true, shopifyProductType: true, resolvedSupplierId: true, resolvedSupplierSku: true } },
        designTasks: { select: { status: true } },
      },
    })
    const state = (await handoffStates([order])).get(o.id)!
    expect(state).toMatchObject({ pending: true, mode: 'API', apiName: 'Merchize', apiKind: 'merchize', apiNote: null })
  })
})
