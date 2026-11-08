import { setCsvLocked } from '@/lib/csv-lock'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { handoffOrderCsv, handoffStateFor, handoffStates } from '@/lib/supplier-handoff'
import { IMPORT_WAIT, methodFor, syncMerchizeTracking } from '@/lib/repos/merchize-push'
import { MerchizeError, getOrderTracking } from '@/lib/merchize'
import { syncApiSupplierTracking } from '@/lib/repos/supplier-tracking-sync'
import { setStoreSetting } from '@/lib/store-settings'
import { resyncOrder } from './helpers/resync-order'
import { GET as getPreview } from '@/app/api/fulfillment/merchize/orders/[orderId]/preview/route'
import { POST as postPush } from '@/app/api/fulfillment/merchize/orders/[orderId]/push/route'
import { POST as postCancel } from '@/app/api/fulfillment/merchize/orders/[orderId]/cancel/route'
import { POST as postRefresh } from '@/app/api/fulfillment/merchize/orders/[orderId]/refresh/route'
import { POST as postExport } from '@/app/api/fulfillment/export/route'

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

const TEE_L = '5000US000LTBAA03'
// A supplier SKU whose Merchize catalog SKU (apiSku) is another string: tracking finds the line through the apiSku.
const TEE_XL = 'MZ-TEE-BLACK-XL'
const TEE_XL_CATALOG = '5000US000BLKAA05'

// One package of Merchize's tracking answer (GET /order/external/orders/tracking), as seen live on 2026-11-08.
const item = (sku: string, quantity = 1) => ({ ffm_mapped_catalog_sku: sku, size: 'L', color: 'Light Blue', variant_title: 'Light Blue / L', quantity, fulfilled_quantity: quantity })
const pkg = (number: string, skus: string[], extra: Record<string, unknown> = {}) => ({
  status: 'fulfilled', shipment_status: 'in_transit', tracking_company: 'USPS', tracking_number: number,
  tracking_url: `https://t.example/${number}`, has_tracking: true,
  items: skus.map(sku => item(sku)),
  created: '2026-11-01T10:00:00Z', updated: '2026-11-02T10:00:00Z',
  ...extra,
})

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
      }, {
        _id: 'v2', sku: TEE_XL_CATALOG,
        attributes: [
          { name: 'color', type: 'color', value_text: 'Black', value_code: 'black' },
          { name: 'size', type: 'size', value_text: 'XL', value_code: 'xl' },
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
  // Order detail carries status and cost only: Merchize sends no tracking there, whatever the status.
  if (call.path.endsWith('/order/external/orders/order-detail')) {
    const n = call.query.get('external_number') ?? ''
    if (!remoteOrders.has(n)) return { status: 200, json: { success: false, message: 'Order does not exist' } }
    return { status: 200, json: { success: true, data: { _id: `mz-${n}`, code: `RX-${n}`, order_status: 'in_production', fulfillment_cost: 10.65 } } }
  }
  if (call.path.endsWith('/order/external/orders/tracking')) {
    const n = call.query.get('external_number') ?? ''
    if (!remoteOrders.has(n)) return { status: 404, json: { success: false, message: 'Order not found' } }
    return { status: 200, json: { success: true, data: [pkg('9400111', [TEE_L])] } }
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
  await setCsvLocked(false)
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
  await prisma.supplierProduct.create({
    data: { supplierId: SUP, sku: TEE_XL, apiSku: TEE_XL_CATALOG, baseSku: '5000US', baseCost: 5.25, printTemplateId: template.id },
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
      identifier: 'MZ',
      shipping_info: {
        full_name: 'Sal Paint', address_1: '12 Main St', address_2: '', city: 'Denver', state: 'CO',
        postcode: '80202', country: 'US', email: 'sal@example.com', phone: '+1 303 555 0100',
      },
      items: [{
        name: `${o.number}_1`, sku: '5000US000LTBAA03', merchize_sku: '5000US000LTBAA03',
        product_id: 'cat-5000us', quantity: 1, price: 0, currency: 'USD', printing_method: 'DTF',
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
    expect(JSON.parse(callsTo('/order/external/orders/push')[0].body)).toEqual({ order: { external_number: o.number, identifier: 'MZ' } })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.pipelineStatus).toBe('EXPORTED')
    expect(order.supplierHandoffMode).toBe('API')

    const again = await push(o.id, p.payloadHash)
    expect(again.status).toBe(409)
    expect(callsTo('/order/external/orders')).toHaveLength(1)
  })

  it('waits for Merchize to import the order before pushing it into production', async () => {
    const o = await makeOrder()
    let lookups = 0
    handler = call => {
      if (call.path.endsWith('/order/external/orders/order-detail')) {
        lookups++
        if (lookups < 3) return { status: 200, json: { success: false, message: 'Order does not exist' } }
      }
      if (call.path.endsWith('/order/external/orders/push') && lookups < 3) return { status: 200, json: { success: false, message: 'Order not found' } }
      return defaultHandler(call)
    }
    IMPORT_WAIT.delayMs = 5
    const p = await (await preview(o.id)).json()
    const out = await (await push(o.id, p.payloadHash)).json()
    expect(out.push).toMatchObject({ status: 'CREATED', supplierOrderCode: `RX-${o.number}`, remoteStatus: 'pushed', error: null })
    expect(lookups).toBe(3)
    expect(callsTo('/order/external/orders/push')).toHaveLength(1)
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

  it('sends no product title or shop domain, and an older push is still found under what it was sent as', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    expect(JSON.stringify(p.payload)).not.toContain('SPIRIT ANIMALS')
    expect(JSON.stringify(p.payload)).not.toContain('mzstore')
    expect(p.payload.items[0].price).toBe(0)
    await push(o.id, p.payloadHash)
    const row = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    await prisma.supplierOrderPush.update({ where: { id: row.id }, data: { requestJson: JSON.stringify({ ...JSON.parse(row.requestJson!), identifier: 'mzstore' }) } })
    expect((await cancel(o.id)).status).toBe(200)
    expect(JSON.parse(callsTo('/order/external/orders/cancel').at(-1)!.body).order.identifier).toBe('mzstore')
  })

  it('a hash from an older preview is refused', async () => {
    const o = await makeOrder()
    const res = await push(o.id, 'f'.repeat(64))
    expect(res.status).toBe(409)
    expect(callsTo('/order/external/orders')).toHaveLength(0)
  })
})

describe('printing method', () => {
  it('keeps the store default unless the blank does not offer it', () => {
    expect(methodFor({ methods: ['DTF', 'DTG'] }, 'DTF')).toBe('DTF')
    expect(methodFor({ methods: ['DTG'] }, 'DTF')).toBe('DTG')
    expect(methodFor({ methods: [] }, 'DTF')).toBeNull()
    expect(methodFor(undefined, 'DTG')).toBe('DTG')
  })
})

describe('Merchize tracking answer', () => {
  const creds = { baseUrl: API, token: 'mz-test-token' }
  const answer = (json: unknown, status = 200) => {
    handler = call => call.path.endsWith('/order/external/orders/tracking') ? { status, json } : defaultHandler(call)
  }

  it('returns the packages that carry a tracking number, each with the catalog SKUs it holds', async () => {
    answer({ success: true, data: [
      pkg('9200190384072911375377', [TEE_L], { shipment_status: 'delivered' }),
      pkg('', [TEE_XL_CATALOG], { status: 'unfulfilled', shipment_status: null, tracking_company: null, tracking_url: null }),
      pkg('LABEL-ONLY-1', [TEE_XL_CATALOG], { status: 'unfulfilled', has_tracking: false, shipment_status: null }),
    ] })

    expect(await getOrderTracking(creds, 'MZ7001', 'MZ')).toEqual([{
      number: '9200190384072911375377', company: 'USPS', url: 'https://t.example/9200190384072911375377', shipmentStatus: 'delivered',
      items: [{ catalogSku: TEE_L, size: 'L', color: 'Light Blue', quantity: 1 }],
    }])
    const asked = callsTo('/order/external/orders/tracking')
    expect(asked).toHaveLength(1)
    expect(Object.fromEntries(asked[0].query)).toEqual({ external_number: 'MZ7001', identifier: 'MZ' })
    expect(asked[0].headers.Authorization).toBe('Bearer mz-test-token')
  })

  it('is empty while nothing shipped', async () => {
    answer({ success: true, data: [] })
    expect(await getOrderTracking(creds, 'MZ7002', 'MZ')).toEqual([])
  })

  it('throws on a success answer without the package list, never reading it as nothing shipped', async () => {
    for (const json of [{ success: true }, { success: true, data: null }, { success: true, data: { packages: [] } }]) {
      answer(json)
      const e = await getOrderTracking(creds, 'MZ7005', 'MZ').catch(x => x)
      expect(e).toBeInstanceOf(MerchizeError)
      expect(e.message).toContain('không đúng dạng')
    }
  })

  it('is null when Merchize holds no order under that number', async () => {
    answer({ success: false, message: 'Order not found' }, 404)
    expect(await getOrderTracking(creds, 'MZ7003', 'MZ')).toBeNull()
    answer({ success: false, message: 'Order does not exist' })
    expect(await getOrderTracking(creds, 'MZ7003', 'MZ')).toBeNull()
  })

  it('throws any other refusal', async () => {
    answer({ success: false, message: 'Identifier is invalid' })
    const e = await getOrderTracking(creds, 'MZ7004', 'MZ').catch(x => x)
    expect(e).toBeInstanceOf(MerchizeError)
    expect(e.message).toBe('Identifier is invalid')
  })
})

describe('handoff state', () => {
  it('sends only the Merchize lines of a mixed order and leaves the other supplier\'s line open', async () => {
    const o = await makeOrder()
    await prisma.supplier.upsert({ where: { code: 'mango_mz_test' }, create: { id: 'sup_mango_mz', name: 'Mangoshao', code: 'mango_mz_test' }, update: {} })
    await prisma.orderLine.create({
      data: {
        orderId: o.id, shopifyLineId: `mzl-other-${seq}`, productTitle: 'Jeep Girl Hoodie', variantTitle: 'Pullover Hoodie / L', qty: 1, linePosition: 2,
        unitPrice: 39.95, resolvedSupplierId: 'sup_mango_mz', resolvedSupplierSku: 'GAF-L', customized: false, sku: 'TN2805261455-PULLOVER-HOODIE-L',
      },
    })
    const p = await (await preview(o.id)).json()
    expect(p.issues.find((i: any) => i.code === 'MIXED_SUPPLIER')).toMatchObject({ level: 'warning' })
    expect(p.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(p.payload.items).toHaveLength(1)
    const res = await push(o.id, p.payloadHash)
    expect(res.status).toBe(200)
    const lines = await prisma.orderLine.findMany({ where: { orderId: o.id }, orderBy: { linePosition: 'asc' } })
    expect(lines[0].exportedToSupplierId).toBe(SUP)
    expect(lines[1].exportedAt).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
    await prisma.orderLine.deleteMany({ where: { orderId: o.id, linePosition: 2 } })
    await prisma.supplier.deleteMany({ where: { id: 'sup_mango_mz' } })
  })

  it('offers the Merchize API window for an all-Merchize order', async () => {
    const o = await makeOrder()
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: o.id },
      include: {
        lines: { select: { id: true, shopifyLineId: true, sku: true, productTitle: true, shopifyProductType: true, resolvedSupplierId: true, resolvedSupplierSku: true, designDriveLink: true, exportedAt: true, exportedToSupplierId: true } },
        designTasks: { select: { shopifyLineId: true, status: true, updatedAt: true } },
        supplierPushes: { where: { status: { in: ['SENDING', 'CREATED'] } }, select: { supplierId: true, status: true, exportMarked: true, prevExportJson: true } },
      },
    })
    const state = (await handoffStates([order])).get(o.id)!
    expect(state).toMatchObject({ pending: true, mode: 'API', apiName: 'Merchize', apiKind: 'merchize', apiNote: null })
  })

  it('keeps the API window without credentials: Merchize has no CSV to fall back on', async () => {
    const o = await makeOrder()
    delete process.env.MERCHIZE_API_TOKEN
    const state = await handoffStateFor(o.id)
    expect(state).toMatchObject({ mode: 'API', apiKind: 'merchize', apiNote: expect.stringContaining('chưa gửi được') })
    await expect(handoffOrderCsv(o.id, null)).rejects.toMatchObject({ code: 'MERCHIZE_API_ONLY' })
  })
})

describe('no CSV for Merchize', () => {
  const addOtherLine = async (orderId: string) => {
    await prisma.supplier.upsert({ where: { code: 'mango_mz_test' }, create: { id: 'sup_mango_mz', name: 'Mangoshao', code: 'mango_mz_test' }, update: {} })
    await prisma.orderLine.create({
      data: {
        orderId, shopifyLineId: `mzl-other-${seq}`, productTitle: 'Jeep Girl Hoodie', variantTitle: 'Pullover Hoodie / L', qty: 1, linePosition: 2,
        unitPrice: 39.95, resolvedSupplierId: 'sup_mango_mz', resolvedSupplierSku: 'GAF-L', customized: false, sku: 'TN2805261455-PULLOVER-HOODIE-L',
      },
    })
  }
  const removeOtherLine = async (orderId: string) => {
    await prisma.orderLine.deleteMany({ where: { orderId, linePosition: 2 } })
    await prisma.supplier.deleteMany({ where: { id: 'sup_mango_mz' } })
  }

  it('the export route refuses a Merchize template, preview or not, and marks nothing', async () => {
    const o = await makeOrder()
    const tmpl = await prisma.csvTemplate.create({
      data: { supplierId: SUP, name: 'Merchize CSV', rowMode: 'PER_LINE', columns: JSON.stringify([{ header: 'Order', source: 'order.shopifyOrderNumber' }]) },
    })
    for (const extra of [{ preview: true }, { markExported: true }]) {
      const res = await postExport(await req('http://x/api/fulfillment/export', adminToken, post({ templateId: tmpl.id, ...extra })))
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('MERCHIZE_API_ONLY')
    }
    const lines = await prisma.orderLine.findMany({ where: { orderId: o.id } })
    expect(lines.every(l => l.exportedAt == null)).toBe(true)
    await prisma.csvTemplate.delete({ where: { id: tmpl.id } })
  })

  it('a mixed order goes to the Merchize window first, then only the other line can wait for CSV', async () => {
    const o = await makeOrder()
    await addOtherLine(o.id)
    expect(await handoffStateFor(o.id)).toMatchObject({ mode: 'API', apiKind: 'merchize', merchizeOpen: true, csvRemainder: true, apiNote: expect.stringContaining('Đơn nhiều xưởng') })
    await expect(handoffOrderCsv(o.id, null)).rejects.toMatchObject({ code: 'MERCHIZE_API_ONLY' })

    const p = await (await preview(o.id)).json()
    expect((await push(o.id, p.payloadHash)).status).toBe(200)
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, mode: 'CSV', merchizeOpen: false, csvRemainder: true, push: { externalOrderId: expect.any(String) } })

    const saved = await handoffOrderCsv(o.id, null)
    expect(saved).toMatchObject({ handedOff: { mode: 'CSV' }, push: { externalOrderId: expect.any(String) } })
    await removeOtherLine(o.id)
  })

  it('an all-Merchize order that was pushed cannot be saved for CSV', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    expect((await push(o.id, p.payloadHash)).status).toBe(200)
    await expect(handoffOrderCsv(o.id, null)).rejects.toMatchObject({ status: 409 })
  })
})

const addOpenLine = async (o: { id: string; number: string }, firstLine: { resolvedSupplierSku: string | null; imageUrl: string | null }) => {
  const lineId = `mzl-open-${seq}`
  await prisma.orderLine.create({ data: {
    orderId: o.id, shopifyLineId: lineId, productTitle: 'Second Tee', qty: 1, linePosition: 2, unitPrice: 24.95,
    resolvedSupplierId: SUP, resolvedSupplierSku: firstLine.resolvedSupplierSku, customized: false, imageUrl: firstLine.imageUrl,
  } })
  await prisma.designTask.create({ data: { orderId: o.id, shopifyLineId: lineId, taskKey: `${o.number}_2`, status: 'NEW' } })
  await prisma.order.update({ where: { id: o.id }, data: { pipelineStatus: 'PENDING_DESIGN', designReady: false } })
  const rel = `design/mzl-open-${seq}/print.png`
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), PNG)
  await prisma.designArtwork.create({ data: {
    orderId: o.id, shopifyLineId: lineId, printArea: 'Front', version: 1, fileName: 'print.png', storagePath: rel, size: PNG.length, mimeType: 'image/png', widthPx: 4200, heightPx: 4800,
  } })
  return lineId
}
const approveOpenLine = async (o: { id: string; number: string }, lineId: string) => {
  await prisma.orderLine.updateMany({ where: { orderId: o.id, shopifyLineId: lineId }, data: { designDriveLink: '/api/design-studio/file/placeholder' } })
  await prisma.designTask.update({ where: { taskKey: `${o.number}_2` }, data: { status: 'DONE' } })
  await prisma.order.update({ where: { id: o.id }, data: { pipelineStatus: 'READY_TO_PRODUCTION', designReady: true } })
}

describe('Merchize: lines approved at different times', () => {
  it('sends the approved line, leaves the open one in design, and sends it later under its own number', async () => {
    const o = await makeOrder()
    const first = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    const lineId = await addOpenLine(o, first)

    const p = await (await preview(o.id)).json()
    expect(p.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(p.issues.find((i: any) => i.code === 'DESIGN_OPEN')).toMatchObject({ level: 'warning' })
    expect(p.lines.map((l: any) => l.refId)).toEqual([`${o.number}_1`])
    expect(p.payload.order_id).toBe(o.number)
    expect(p.payload.items.length).toBe(1)
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

describe('tracking of a send beside another', () => {
  it('lands only on the lines that push carried', async () => {
    const o = await makeOrder()
    const first = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    await addOpenLine(o, first)
    const p = await (await preview(o.id)).json()
    await push(o.id, p.payloadHash)
    const r = await (await refresh(o.id)).json()
    expect(r.shipments).toBe(1)
    expect(await prisma.shipment.findMany({ where: { orderId: o.id }, select: { lineKey: true } })).toEqual([{ lineKey: `${o.number}_1` }])
  })
})

const pushedOrder = async () => {
  const o = await makeOrder()
  const p = await (await preview(o.id)).json()
  expect((await push(o.id, p.payloadHash)).status).toBe(200)
  const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
  return { o, line, row: await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } }) }
}

// The order sync makes every OrderLine anew each time it reads the order: a push's stored OrderLine ids are soon gone.
describe('Merchize tracking after the order sync made the lines anew', () => {
  it('a push records the Shopify line ids it carries, and its tracking still reaches the line', async () => {
    const { o, line, row } = await pushedOrder()
    expect(JSON.parse(row.prevExportJson!)).toMatchObject({ lineIds: [line.id], shopifyLineIds: [line.shopifyLineId] })
    await resyncOrder(o.id)
    expect((await (await refresh(o.id)).json()).shipments).toBe(1)
    expect(await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } }))
      .toMatchObject({ lineKey: `${o.number}_1`, shopifyLineId: line.shopifyLineId, trackingNumber: '9400111', supplierId: SUP })
  })

  it('a push stored with OrderLine ids only finds its line by the print file it sent', async () => {
    const { o, line, row } = await pushedOrder()
    const { shopifyLineIds: _recorded, ...older } = JSON.parse(row.prevExportJson!)
    await prisma.supplierOrderPush.update({ where: { id: row.id }, data: { prevExportJson: JSON.stringify(older) } })
    await resyncOrder(o.id)
    await syncMerchizeTracking()
    expect(await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } }))
      .toMatchObject({ lineKey: `${o.number}_1`, shopifyLineId: line.shopifyLineId, trackingNumber: '9400111', supplierId: SUP })
  })
})

// Merchize's tracking answer lists one package per parcel, each naming the catalog SKUs (ffm_mapped_catalog_sku) it holds.
describe('a Merchize order shipped in several parcels', () => {
  let parcels = new Map<string, unknown[]>()
  beforeEach(() => {
    parcels = new Map()
    handler = call => {
      const n = call.query.get('external_number') ?? ''
      if (call.path.endsWith('/order/external/orders/tracking') && parcels.has(n) && remoteOrders.has(n)) {
        return { status: 200, json: { success: true, data: parcels.get(n) } }
      }
      return defaultHandler(call)
    }
  })
  afterEach(() => { vi.restoreAllMocks() })

  const twoLineOrder = async (secondSku = TEE_L) => {
    const o = await makeOrder()
    const first = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    await approveOpenLine(o, await addOpenLine(o, { ...first, resolvedSupplierSku: secondSku }))
    const p = await (await preview(o.id)).json()
    expect(p.lines.map((l: any) => l.refId)).toEqual([`${o.number}_1`, `${o.number}_2`])
    expect((await push(o.id, p.payloadHash)).status).toBe(200)
    return o
  }
  const tracked = (orderId: string) => prisma.shipment.findMany({
    where: { orderId, trackingNumber: { not: null } }, orderBy: { lineKey: 'asc' }, select: { lineKey: true, trackingNumber: true, carrier: true },
  })
  const warningsFor = (spy: { mock: { calls: unknown[][] } }, number: string) => spy.mock.calls.map(c => c.join(' ')).filter(m => m.includes(number))

  it('two lines of one SKU back as two parcels with different trackings: no tracking is written, the order is flagged once, the pull is recorded', async () => {
    const o = await twoLineOrder()
    parcels.set(o.number, [pkg('MZP1', [TEE_L]), pkg('MZP2', [TEE_L])])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await (await refresh(o.id)).json()).shipments).toBe(0)

    expect(await tracked(o.id)).toEqual([])
    const warned = warningsFor(warn, o.number)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('2 mã tracking')
    expect(warned[0]).toContain(`dòng ${o.number}_1, ${o.number}_2 `)
    expect(warned[0]).toContain('cần đối chiếu tay')
    expect((await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })).lastSyncedAt).not.toBeNull()
  })

  it('the nightly pull holds it the same way, one warning per push', async () => {
    const o = await twoLineOrder()
    parcels.set(o.number, [pkg('MZP3', [TEE_L]), pkg('MZP4', [TEE_L])])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await syncMerchizeTracking()

    expect(await tracked(o.id)).toEqual([])
    expect(warningsFor(warn, o.number)).toHaveLength(1)
  })

  it('two lines of different SKUs in two parcels: each line gets the parcel that holds its catalog SKU', async () => {
    const o = await twoLineOrder(TEE_XL)
    parcels.set(o.number, [pkg('MZP9', [TEE_XL_CATALOG], { tracking_company: 'UPS' }), pkg('MZP10', [TEE_L])])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await (await refresh(o.id)).json()).shipments).toBe(2)

    expect(await tracked(o.id)).toEqual([
      { lineKey: `${o.number}_1`, trackingNumber: 'MZP10', carrier: 'USPS' },
      { lineKey: `${o.number}_2`, trackingNumber: 'MZP9', carrier: 'UPS' },
    ])
    expect(warningsFor(warn, o.number)).toEqual([])
    expect(callsTo('/order/external/orders/tracking').at(-1)!.query.get('identifier')).toBe('MZ')
  })

  it('a line two parcels hold gets no tracking and is flagged; the line only one parcel holds still gets it', async () => {
    const o = await twoLineOrder(TEE_XL)
    parcels.set(o.number, [pkg('MZP11', [TEE_L, TEE_XL_CATALOG]), pkg('MZP12', [TEE_L])])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await (await refresh(o.id)).json()).shipments).toBe(1)

    expect(await tracked(o.id)).toEqual([{ lineKey: `${o.number}_2`, trackingNumber: 'MZP11', carrier: 'USPS' }])
    const warned = warningsFor(warn, o.number)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain(`dòng ${o.number}_1 `)
    expect(warned[0]).not.toContain(`${o.number}_2`)
  })

  it('a line no parcel names gets no tracking and is flagged', async () => {
    const o = await twoLineOrder(TEE_XL)
    parcels.set(o.number, [pkg('MZP13', [TEE_L]), pkg('MZP14', [])])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await (await refresh(o.id)).json()).shipments).toBe(1)

    expect(await tracked(o.id)).toEqual([{ lineKey: `${o.number}_1`, trackingNumber: 'MZP13', carrier: 'USPS' }])
    const warned = warningsFor(warn, o.number)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain(`dòng ${o.number}_2 `)
  })

  it('two lines and one tracking (one parcel, or two packages of one number) holding both: both lines get it', async () => {
    const one = await twoLineOrder(TEE_XL)
    const same = await twoLineOrder()
    parcels.set(one.number, [pkg('MZP5', [TEE_L, TEE_XL_CATALOG])])
    parcels.set(same.number, [pkg('MZP6', [TEE_L]), pkg('MZP6', [TEE_L])])

    expect((await (await refresh(one.id)).json()).shipments).toBe(2)
    expect((await (await refresh(same.id)).json()).shipments).toBe(2)

    expect((await tracked(one.id)).map(t => [t.lineKey, t.trackingNumber])).toEqual([[`${one.number}_1`, 'MZP5'], [`${one.number}_2`, 'MZP5']])
    expect((await tracked(same.id)).map(t => [t.lineKey, t.trackingNumber])).toEqual([[`${same.number}_1`, 'MZP6'], [`${same.number}_2`, 'MZP6']])
  })

  // Merchize leaves out a parcel with no tracking yet: the line still waiting must not take the shipped line's tracking.
  it('two lines and the one tracked parcel holds only the first: the first gets it, the second gets none and is flagged', async () => {
    const o = await twoLineOrder(TEE_XL)
    parcels.set(o.number, [pkg('MZP15', [TEE_L]), pkg('', [TEE_XL_CATALOG], { status: 'unfulfilled', has_tracking: false })])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await (await refresh(o.id)).json()).shipments).toBe(1)

    expect(await tracked(o.id)).toEqual([{ lineKey: `${o.number}_1`, trackingNumber: 'MZP15', carrier: 'USPS' }])
    const warned = warningsFor(warn, o.number)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('1 mã tracking')
    expect(warned[0]).toContain(`dòng ${o.number}_2 `)
    expect(warned[0]).not.toContain(`${o.number}_1`)
    expect(warned[0]).not.toContain('khác nhau')
  })

  it('two lines of one SKU take a parcel only when it holds both units', async () => {
    const short = await twoLineOrder()
    const whole = await twoLineOrder()
    parcels.set(short.number, [pkg('MZP16', [TEE_L])])
    parcels.set(whole.number, [pkg('MZP17', [], { items: [item(TEE_L, 2)] })])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await (await refresh(short.id)).json()).shipments).toBe(0)
    expect((await (await refresh(whole.id)).json()).shipments).toBe(2)

    expect(await tracked(short.id)).toEqual([])
    expect(warningsFor(warn, short.number)).toHaveLength(1)
    expect(warningsFor(warn, short.number)[0]).toContain(`dòng ${short.number}_1, ${short.number}_2 `)
    expect((await tracked(whole.id)).map(t => [t.lineKey, t.trackingNumber])).toEqual([[`${whole.number}_1`, 'MZP17'], [`${whole.number}_2`, 'MZP17']])
    expect(warningsFor(warn, whole.number)).toEqual([])
  })

  it('one line back as two parcels of different numbers that both hold it: no tracking is written, the order is flagged', async () => {
    const o = await makeOrder()
    const p = await (await preview(o.id)).json()
    await push(o.id, p.payloadHash)
    parcels.set(o.number, [pkg('MZP7', [TEE_L]), pkg('MZP8', [TEE_L])])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await (await refresh(o.id)).json()).shipments).toBe(0)

    expect(await tracked(o.id)).toEqual([])
    expect(warningsFor(warn, o.number)).toHaveLength(1)
  })
})

describe('a failing Merchize tracking call', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('keeps the status the refresh wrote: the push lands, the order is found with no shipment, the failure is logged', async () => {
    const o = await makeOrder()
    handler = call => {
      if (call.path.endsWith('/order/external/orders') && call.method === 'POST') {
        remoteOrders.add(JSON.parse(call.body).order_id)
        return 'network-error'
      }
      return defaultHandler(call)
    }
    const p = await (await preview(o.id)).json()
    expect((await push(o.id, p.payloadHash)).status).toBe(504)
    const row = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    expect(row.status).toBe('SENDING')
    handler = call => call.path.endsWith('/order/external/orders/tracking') ? 'network-error' : defaultHandler(call)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await refresh(o.id)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ found: true, shipments: 0, push: { status: 'CREATED', remoteStatus: 'in_production', totalCost: 10.65 } })
    expect(callsTo('/order/external/orders/tracking')).toHaveLength(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('EXPORTED')
    expect(await prisma.shipment.count({ where: { orderId: o.id } })).toBe(0)
    expect(JSON.stringify(errors.mock.calls)).toContain(row.id)
  })

  it('in the nightly pull, counts the order found and logs no key', async () => {
    const { o, row } = await pushedOrder()
    handler = call => call.path.endsWith('/order/external/orders/tracking') && call.query.get('external_number') === o.number
      ? { status: 500, json: { success: false, message: 'upstream broke for token mz-test-token' } }
      : defaultHandler(call)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await syncMerchizeTracking()

    expect(result.found).toBeGreaterThanOrEqual(1)
    expect(await prisma.supplierOrderPush.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ remoteStatus: 'in_production', lastSyncedAt: expect.any(Date) })
    expect(await prisma.shipment.count({ where: { orderId: o.id } })).toBe(0)
    const logged = JSON.stringify(errors.mock.calls)
    expect(logged).toContain(row.id)
    expect(logged).toContain('upstream broke')
    expect(logged).not.toContain('mz-test-token')
  })
})

describe('the ids a push stores', () => {
  it('are the OrderLine and Shopify line ids of exactly the lines it carried', async () => {
    const o = await makeOrder()
    const first = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    await addOpenLine(o, first)
    const p = await (await preview(o.id)).json()
    expect((await push(o.id, p.payloadHash)).status).toBe(200)
    const row = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    expect(JSON.parse(row.prevExportJson!)).toMatchObject({ lineIds: [first.id], shopifyLineIds: [first.shopifyLineId] })
  })
})

describe('nightly Merchize tracking pull', () => {
  const OTHER_SHOP = 'mz-other.myshopify.com'
  afterEach(async () => {
    vi.restoreAllMocks()
    const other = await prisma.shopifyStore.findUnique({ where: { shop: OTHER_SHOP } })
    if (!other) return
    await prisma.order.deleteMany({ where: { storeId: other.id } })
    await setStoreSetting(other.id, 'merchize.apiUrl', null)
    await prisma.shopifyStore.delete({ where: { id: other.id } })
  })

  it('writes the tracking of each live push on its line and records the pull; closed and old orders are left alone', async () => {
    const live = await pushedOrder()
    const closed = await pushedOrder()
    const old = await pushedOrder()
    await prisma.order.update({ where: { id: closed.o.id }, data: { pipelineStatus: 'FULFILLED' } })
    await prisma.supplierOrderPush.update({ where: { id: old.row.id }, data: { pushedAt: new Date(Date.now() - 100 * 86_400_000) } })
    calls = []

    const result = await syncMerchizeTracking()

    expect(result.shipments).toBeGreaterThanOrEqual(1)
    expect(await prisma.shipment.findFirstOrThrow({ where: { orderId: live.o.id } }))
      .toMatchObject({ lineKey: `${live.o.number}_1`, trackingNumber: '9400111', carrier: 'USPS', supplierId: SUP })
    const row = await prisma.supplierOrderPush.findUniqueOrThrow({ where: { id: live.row.id } })
    expect(row.lastSyncedAt).not.toBeNull()
    expect(row.remoteStatus).toBe('in_production')
    const asked = callsTo('/order/external/orders/order-detail').map(c => c.query.get('external_number'))
    expect(asked).toContain(live.o.number)
    expect(asked).not.toContain(closed.o.number)
    expect(asked).not.toContain(old.o.number)
    expect(await prisma.shipment.count({ where: { orderId: { in: [closed.o.id, old.o.id] } } })).toBe(0)
  })

  it('one push whose pull fails does not stop the next, and the log carries no key', async () => {
    const failing = await pushedOrder()
    const next = await pushedOrder()
    handler = call => call.path.endsWith('/order-detail') && call.query.get('external_number') === failing.o.number
      ? { status: 500, json: { success: false, message: 'upstream broke for token mz-test-token' } }
      : defaultHandler(call)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    await syncMerchizeTracking()

    expect(await prisma.shipment.findFirstOrThrow({ where: { orderId: next.o.id } })).toMatchObject({ trackingNumber: '9400111' })
    expect(await prisma.shipment.count({ where: { orderId: failing.o.id } })).toBe(0)
    const logged = JSON.stringify(errors.mock.calls)
    expect(logged).toContain(failing.row.id)
    expect(logged).not.toContain('mz-test-token')
  })

  it('a store with no usable Merchize account is skipped and logged, never pulled with another account', async () => {
    const other = await prisma.shopifyStore.create({ data: { shop: OTHER_SHOP } })
    await setStoreSetting(other.id, 'merchize.apiUrl', 'https://bo-group-9-9.merchize.com/other/bo-api')
    await prisma.order.create({ data: {
      id: 'gid://test/Order/mz-other-1', projectId: PROJECT, storeId: other.id, shopifyOrderNumber: '#MZO1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date(), pipelineStatus: 'EXPORTED',
    } })
    await prisma.supplierOrderPush.create({ data: {
      orderId: 'gid://test/Order/mz-other-1', supplierId: SUP, externalOrderId: 'MZO1', status: 'CREATED', requestJson: '{}', exportMarked: true,
    } })
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    calls = []

    const result = await syncMerchizeTracking()

    expect(callsTo('/order/external/orders/order-detail').map(c => c.query.get('external_number'))).not.toContain('MZO1')
    expect(result.skipped).toContain(OTHER_SHOP)
    expect(JSON.stringify(logs.mock.calls)).toContain(OTHER_SHOP)
    expect((await prisma.supplierOrderPush.findUniqueOrThrow({ where: { externalOrderId: 'MZO1' } })).lastSyncedAt).toBeNull()
  })

  it('runs in the shared nightly sync beside Bondre and Printway', async () => {
    const { o } = await pushedOrder()
    const results = await syncApiSupplierTracking()
    expect(results.map(r => r.name)).toEqual(['Bondre', 'Printway', 'Merchize'])
    expect(results.find(r => r.name === 'Merchize')).toMatchObject({ pushes: expect.any(Number) })
    expect(await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } })).toMatchObject({ trackingNumber: '9400111' })
  })
})
