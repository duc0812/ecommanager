import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { signBody } from '@/lib/pgprints'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { PGPRINTS_KEYS } from '@/lib/pgprints-settings'
import { upsertOrderShipments } from '@/lib/repos/shipments'
import { GET as getPreview } from '@/app/api/fulfillment/pgprints/orders/[orderId]/preview/route'
import { POST as postPush } from '@/app/api/fulfillment/pgprints/orders/[orderId]/push/route'
import { POST as postCancel } from '@/app/api/fulfillment/pgprints/orders/[orderId]/cancel/route'
import { POST as postRefresh } from '@/app/api/fulfillment/pgprints/orders/[orderId]/refresh/route'
import { GET as getSettings, PUT as putSettings } from '@/app/api/fulfillment/pgprints/settings/route'
import { POST as postTestConnection } from '@/app/api/fulfillment/pgprints/settings/test/route'
import { GET as getCatalog } from '@/app/api/fulfillment/pgprints/catalog/route'
import { GET as getPublicArtwork } from '@/app/api/public/artwork/[token]/[fileName]/route'
import { POST as postTracking } from '@/app/api/public/pgprints/tracking/route'
import { PATCH as patchSupplierProduct } from '@/app/api/suppliers/products/[id]/route'

const SHOP = 'pgp.myshopify.com'
const PROJECT = 'proj_pgp'
const SUP = 'sup_pgp'
const OTHER_SUP = 'sup_pgp_other'
const SECRET = 'pgp-secret-key-0123456789'
const STORE_ID = 'pgp-store-id-123456'
const APP_URL = 'https://tool.shop-example.com'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgp-storage-'))

let storeId = ''
let adminId = ''
let adminToken = ''
let supportToken = ''
let superToken = ''
let productId = ''
let seq = 0

type Call = { path: string; method: string; headers: Record<string, string>; body: string }
type Reply = { status: number; json: unknown } | 'network-error'
let calls: Call[] = []
let handler: (call: Call) => Reply | Promise<Reply>

function createdReply(call: Call): Reply {
  const body = JSON.parse(call.body)
  return { status: 200, json: { success: true, message: 'Successful', data: {
    id: `int-${body.order_id}`, pgcOrderId: `PG-${body.order_id}`, orderId: body.order_id,
    totalCost: 11.25, shippingFee: 4.5, handleFee: 0.75, childDetails: [{ sku: body.line_items[0].sku }],
  } } }
}

function callsTo(pathPart: string) {
  return calls.filter(c => c.path.includes(pathPart))
}

async function req(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

function post(body: unknown) {
  return { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
}

const base = (orderId: string) => `http://x/api/fulfillment/pgprints/orders/${encodeURIComponent(orderId)}`
const preview = async (orderId: string, token = adminToken) => getPreview(await req(`${base(orderId)}/preview`, token), { params: { orderId } })
const push = async (orderId: string, payloadHash: string, token = adminToken) =>
  postPush(await req(`${base(orderId)}/push`, token, post({ confirm: true, payloadHash })), { params: { orderId } })
const cancel = async (orderId: string, token = adminToken) =>
  postCancel(await req(`${base(orderId)}/cancel`, token, post({ confirm: true })), { params: { orderId } })
const refresh = async (orderId: string, token = adminToken) => postRefresh(await req(`${base(orderId)}/refresh`, token, post({})), { params: { orderId } })

async function setSetting(key: string, value: string | null) {
  if (value === null) await prisma.appSetting.deleteMany({ where: { key } })
  else await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

type OrderOpts = {
  approved?: boolean; state?: string | null; stateCode?: string | null; pipelineStatus?: string; note?: string | null
  extraLine?: { supplierId: string | null }; withArtwork?: boolean; supplierSku?: string; phone?: string | null
  country?: string | null; zip?: string | null; artwork?: { mimeType: 'image/png' | 'image/jpeg'; fileName: string }
}

async function makeOrder(opts: OrderOpts = {}) {
  seq++
  const id = `gid://test/Order/pgp-${seq}`
  const number = `#PGP${1000 + seq}`
  const lineId = `pgl-${seq}`
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 30, expectedPayout: 28, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-01T10:00:00Z'),
      pipelineStatus: opts.pipelineStatus ?? 'READY_TO_PRODUCTION', orderType: 'CUSTOM', designReady: opts.approved !== false,
      customerEmail: 'mary@example.com', customerName: 'Mary Jane Watson',
      shippingName: 'Mary Jane Watson', shippingAddress1: '12 Main St', shippingAddress2: 'Apt 4', shippingCity: 'Denver',
      shippingZip: opts.zip === undefined ? '80202' : opts.zip, shippingPhone: opts.phone === undefined ? '+1 303 555 0100' : opts.phone,
      shippingCountry: opts.country === undefined ? 'US' : opts.country,
      shippingState: opts.state === undefined ? 'Colorado' : opts.state, shippingStateCode: opts.stateCode ?? null,
      lines: { create: [
        {
          shopifyLineId: lineId, sku: 'TUMBLER-A', productTitle: 'Custom Tumbler', variantTitle: '20oz', qty: 2, linePosition: 1, unitPrice: 15,
          resolvedSupplierId: SUP, resolvedSupplierSku: opts.supplierSku ?? 'UT2-20OZ', customized: true,
          previewCdnUrl: 'https://cdn.example.com/preview.png', designNote: opts.note === undefined ? 'In đậm tên' : opts.note,
          designDriveLink: opts.approved === false ? null : '/api/design-studio/file/placeholder',
        },
        ...(opts.extraLine ? [{
          shopifyLineId: `${lineId}-b`, sku: 'OTHER-B', productTitle: 'Other product', qty: 1, linePosition: 2, unitPrice: 9,
          resolvedSupplierId: opts.extraLine.supplierId, resolvedSupplierSku: 'OTHER-SKU', customized: false,
          designDriveLink: 'https://drive.google.com/x',
        }] : []),
      ] },
    },
  })
  let artworkId: string | null = null
  if (opts.withArtwork !== false) {
    const art = opts.artwork ?? { mimeType: 'image/png', fileName: 'main.png' }
    const rel = `design/pgp-${seq}/${art.fileName}`
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
    fs.writeFileSync(path.join(tmp, rel), art.mimeType === 'image/jpeg' ? JPEG : PNG)
    artworkId = (await prisma.designArtwork.create({
      data: {
        orderId: id, shopifyLineId: lineId, printArea: 'Main', version: 1, fileName: art.fileName, storagePath: rel,
        size: PNG.length, mimeType: art.mimeType, widthPx: 3270, heightPx: 1860,
      },
    })).id
  }
  return { id, number: number.replace('#', ''), lineId, artworkId }
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp

  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'PGP', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'pgprints' }, create: { id: SUP, name: 'Pgprints', code: 'pgprints' }, update: {} })
  await prisma.supplier.upsert({ where: { code: 'pgp_other' }, create: { id: OTHER_SUP, name: 'Other Factory', code: 'pgp_other' }, update: {} })
  const template = await prisma.printTemplate.create({
    data: { supplierId: SUP, supplierSku: 'UT2-20OZ', name: 'Tumbler 20oz', widthPx: 3270, heightPx: 1860, areas: JSON.stringify([{ name: 'Main', x: 0, y: 0, w: 3270, h: 1860 }]) },
  })
  productId = (await prisma.supplierProduct.create({
    data: { supplierId: SUP, sku: 'UT2-20OZ', baseSku: 'UT2', baseCost: 8, printTemplateId: template.id, apiSku: 'UT2-One_size' },
  })).id
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'NO-API-SKU', baseCost: 5, printTemplateId: template.id } })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'STU-20OZ', baseSku: 'STU', baseCost: 8, printTemplateId: template.id, apiSku: 'STU-One_size', apiShipClass: 'Standard', apiFileFormat: 'JPEG' } })

  adminId = (await prisma.appUser.upsert({ where: { email: 'admin@pgp.test' }, create: { name: 'Admin', email: 'admin@pgp.test', role: 'ADMIN', permissions: JSON.stringify(DEFAULT_ROLE_PERMISSIONS.ADMIN) }, update: {} })).id
  const supportId = (await prisma.appUser.upsert({ where: { email: 'support@pgp.test' }, create: { name: 'Support', email: 'support@pgp.test', role: 'SUPPORT', permissions: JSON.stringify(['fulfillment_orders']) }, update: {} })).id
  const superId = (await prisma.appUser.upsert({ where: { email: 'super@pgp.test' }, create: { name: 'Super', email: 'super@pgp.test', role: 'SUPERADMIN' }, update: {} })).id
  adminToken = await signToken({ userId: adminId, email: 'admin@pgp.test', name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
  supportToken = await signToken({ userId: supportId, email: 'support@pgp.test', name: 'Support', role: 'SUPPORT', permissions: [], tv: 0 })
  superToken = await signToken({ userId: superId, email: 'super@pgp.test', name: 'Super', role: 'SUPERADMIN', permissions: [], tv: 0 })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: { in: [SUP, OTHER_SUP] } } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP, OTHER_SUP] } } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['admin@pgp.test', 'support@pgp.test', 'super@pgp.test'] } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(PGPRINTS_KEYS) } } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
  delete process.env.NEXT_PUBLIC_APP_URL
})

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = APP_URL
  await setSetting(PGPRINTS_KEYS.storeId, STORE_ID)
  await setSetting(PGPRINTS_KEYS.secretKey, SECRET)
  await setSetting(PGPRINTS_KEYS.defaultShipClass, 'US Economy')
  await setSetting(PGPRINTS_KEYS.pushEnabled, 'true')
  calls = []
  handler = call => {
    if (call.path === '/api/v1/users/balance') return { status: 200, json: { success: true, data: { availableAmount: 100, pendingAmount: 5, paidAmount: 20, upcomingAmount: 0 } } }
    if (call.path === '/app/v1/orders/create') return createdReply(call)
    if (call.path === '/api/v1/order/cancel') return { status: 200, json: { success: true } }
    return { status: 404, json: { success: false, message: 'unexpected path in test' } }
  }
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://app.pgprints.io') throw new Error(`test blocked a call to ${url.origin}`)
    const call: Call = { path: url.pathname, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') }
    calls.push(call)
    const reply = await handler(call)
    if (reply === 'network-error') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('preview payload', () => {
  it('builds the exact create body for a one-line order', async () => {
    const o = await makeOrder()
    const res = await preview(o.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    const token = (await prisma.designArtwork.findUniqueOrThrow({ where: { id: o.artworkId! } })).publicToken
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(body.payload).toEqual({
      order_id: o.number,
      email: 'mary@example.com',
      shipping_address: {
        first_name: 'Mary Jane', last_name: 'Watson', name: 'Mary Jane Watson', email: 'mary@example.com', phone: '+1 303 555 0100',
        address1: '12 Main St', address2: 'Apt 4', company: '', city: 'Denver', zip: '80202',
        province: 'Colorado', province_code: 'CO', country: 'United States', country_code: 'US',
      },
      customer: { first_name: 'Mary Jane', last_name: 'Watson' },
      line_items: [{
        name: 'Custom Tumbler - 20oz', refId: `${o.number}_1`, quantity: 2, sku: 'UT2-One_size', shipClass: 'US Economy',
        fileUrls: [`${APP_URL}/api/public/artwork/${token}/main.png`],
        mockupImages: ['https://cdn.example.com/preview.png'],
      }],
      response_type: 'normal',
    })
    expect(body.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    expect(body.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(body.canPush).toBe(true)
    expect(body.canAct).toBe(true)
    expect(body.pushEnabled).toBe(true)
    expect(body.balance).toEqual({ availableAmount: 100, pendingAmount: 5, paidAmount: 20, upcomingAmount: 0 })
    expect(body.lines[0]).toMatchObject({ apiSku: 'UT2-One_size', shipClass: 'US Economy', shipClassSource: 'default', templateName: 'Tumbler 20oz' })
    expect(body.lines[0].files[0]).toMatchObject({ area: 'Main', widthPx: 3270, heightPx: 1860, expectedWidthPx: 3270, expectedHeightPx: 1860, sizeOk: true })
    expect(callsTo('/orders/create')).toHaveLength(0)
  })

  it('prefers the stored state code and the SKU ship class', async () => {
    await prisma.supplierProduct.update({ where: { id: productId }, data: { apiShipClass: 'US Express' } })
    const o = await makeOrder({ state: 'Some Unknown Name', stateCode: 'TX' })
    const body = await (await preview(o.id)).json()
    await prisma.supplierProduct.update({ where: { id: productId }, data: { apiShipClass: null } })
    expect(body.payload.shipping_address.province_code).toBe('TX')
    expect(body.payload.line_items[0].shipClass).toBe('US Express')
    expect(body.lines[0].shipClassSource).toBe('product')
  })

  it('a balance failure is a warning, not a block', async () => {
    handler = () => ({ status: 500, json: { success: false, message: 'down' } })
    const o = await makeOrder()
    const body = await (await preview(o.id)).json()
    expect(body.balance).toBeNull()
    expect(body.issues).toContainEqual(expect.objectContaining({ level: 'warning', code: 'BALANCE' }))
    expect(body.canPush).toBe(true)
  })

  it('flags a missing phone as a warning and a missing US state code as an error', async () => {
    const o = await makeOrder({ phone: null, state: null })
    const body = await (await preview(o.id)).json()
    expect(body.issues).toContainEqual(expect.objectContaining({ level: 'warning', code: 'ADDRESS_PHONE' }))
    expect(body.issues).toContainEqual(expect.objectContaining({ level: 'error', code: 'ADDRESS_STATE' }))
    expect(body.canPush).toBe(false)
  })

  it('blocks a SKU without an API SKU with a clear message', async () => {
    const o = await makeOrder({ supplierSku: 'NO-API-SKU' })
    const body = await (await preview(o.id)).json()
    const issue = body.issues.find((i: any) => i.code === 'NO_API_SKU')
    expect(issue.level).toBe('error')
    expect(issue.message).toContain('NO-API-SKU')
    expect(body.canPush).toBe(false)
  })

  it('blocks mixed-supplier orders', async () => {
    const o = await makeOrder({ extraLine: { supplierId: OTHER_SUP } })
    const body = await (await preview(o.id)).json()
    const issue = body.issues.find((i: any) => i.code === 'MIXED_SUPPLIER')
    expect(issue.level).toBe('error')
    expect(issue.message).toContain('Other Factory')
    const res = await push(o.id, body.payloadHash)
    expect(res.status).toBe(422)
    expect(callsTo('/orders/create')).toHaveLength(0)
  })

  it('blocks unapproved lines and lines without artwork, and issues no public token for them', async () => {
    const unapproved = await makeOrder({ approved: false })
    const a = await (await preview(unapproved.id)).json()
    expect(a.issues).toContainEqual(expect.objectContaining({ level: 'error', code: 'NOT_APPROVED' }))
    expect((await prisma.designArtwork.findUniqueOrThrow({ where: { id: unapproved.artworkId! } })).publicToken).toBeNull()

    const noArt = await makeOrder({ withArtwork: false })
    const b = await (await preview(noArt.id)).json()
    expect(b.issues).toContainEqual(expect.objectContaining({ level: 'error', code: 'NO_ARTWORK' }))
  })

  it('blocks cancelled orders', async () => {
    const o = await makeOrder({ pipelineStatus: 'CANCELLED' })
    const body = await (await preview(o.id)).json()
    expect(body.issues).toContainEqual(expect.objectContaining({ level: 'error', code: 'ORDER_CLOSED' }))
  })

  it('needs a session and the fulfillment permission', async () => {
    const o = await makeOrder()
    expect((await preview(o.id, null as any)).status).toBe(401)
    const res = await preview(o.id, supportToken)
    expect(res.status).toBe(200)
    expect((await res.json()).canAct).toBe(false)
  })
})

describe('file format per API SKU (SupplierProduct.apiFileFormat)', () => {
  const fileIssues = (pre: any) => pre.issues.filter((i: any) => i.code === 'FILE_TYPE')

  it('a JPEG file on a SKU without a declared format still warns that PGprints wants PNG', async () => {
    const o = await makeOrder({ artwork: { mimeType: 'image/jpeg', fileName: 'main.jpg' } })
    const pre = await (await preview(o.id)).json()
    expect(fileIssues(pre)).toEqual([expect.objectContaining({ level: 'warning', message: expect.stringContaining('PNG') })])
    expect(pre.canPush).toBe(true)
  })

  it('a JPEG file on a JPEG SKU passes without a file-type issue, and is sent with its .jpg name', async () => {
    const o = await makeOrder({ supplierSku: 'STU-20OZ', artwork: { mimeType: 'image/jpeg', fileName: 'main.jpg' } })
    const pre = await (await preview(o.id)).json()
    expect(fileIssues(pre)).toEqual([])
    expect(pre.canPush).toBe(true)
    expect(pre.payload.line_items[0].sku).toBe('STU-One_size')
    expect(pre.payload.line_items[0].fileUrls[0]).toMatch(/\/main\.jpg$/)
  })

  it('a PNG file on a JPEG SKU warns that this SKU wants JPEG, and a PSD is blocked whatever the SKU', async () => {
    const o = await makeOrder({ supplierSku: 'STU-20OZ' })
    const pre = await (await preview(o.id)).json()
    expect(fileIssues(pre)).toEqual([expect.objectContaining({ level: 'warning', message: expect.stringContaining('JPEG') })])
    expect(pre.canPush).toBe(true)
    await prisma.designArtwork.update({ where: { id: o.artworkId! }, data: { mimeType: 'image/vnd.adobe.photoshop', fileName: 'main.psd' } })
    const blocked = await (await preview(o.id)).json()
    expect(fileIssues(blocked)).toEqual([expect.objectContaining({ level: 'error' })])
    expect(blocked.canPush).toBe(false)
  })

  it('PATCH on a supplier product saves the format in upper case, clears it on blank and refuses anything but PNG/JPEG', async () => {
    const patch = (body: unknown) => patchSupplierProduct(
      new NextRequest(`http://x/api/suppliers/products/${productId}`, { method: 'PATCH', body: JSON.stringify(body) }),
      { params: { id: productId } },
    )
    expect((await patch({ apiFileFormat: 'jpeg' })).status).toBe(200)
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { id: productId } })).apiFileFormat).toBe('JPEG')
    expect((await patch({ apiFileFormat: 'gif' })).status).toBe(400)
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { id: productId } })).apiFileFormat).toBe('JPEG')
    expect((await patch({ apiFileFormat: '' })).status).toBe(200)
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { id: productId } })).apiFileFormat).toBeNull()
  })
})

describe('destination guard (SupplierProduct.apiShipCountries)', () => {
  const setCountries = (value: string | null) => prisma.supplierProduct.update({ where: { id: productId }, data: { apiShipCountries: value } })
  afterEach(async () => { await setCountries(null) })

  it('an empty list ships anywhere', async () => {
    const o = await makeOrder({ country: 'Canada', state: 'Ontario', zip: 'M5V 2T6' })
    const body = await (await preview(o.id)).json()
    expect(body.issues.filter((i: any) => i.code === 'SHIP_COUNTRY')).toEqual([])
    expect(body.lines[0].shipCountries).toEqual([])
    expect(body.canPush).toBe(true)
  })

  it('blocks the preview and the push when the order ships outside the SKU list', async () => {
    await setCountries('US')
    const o = await makeOrder({ country: 'Canada', state: 'Ontario', zip: 'M5V 2T6' })
    const body = await (await preview(o.id)).json()
    const issue = body.issues.find((i: any) => i.code === 'SHIP_COUNTRY')
    expect(issue).toMatchObject({ level: 'error', refId: `${o.number}_1` })
    expect(issue.message).toContain('SKU UT2-One_size chỉ giao tới: US — đơn này giao CA')
    expect(body.lines[0].shipCountries).toEqual(['US'])
    expect(body.canPush).toBe(false)
    const res = await push(o.id, body.payloadHash)
    expect(res.status).toBe(422)
    expect((await res.json()).issues).toContainEqual(expect.objectContaining({ code: 'SHIP_COUNTRY' }))
    expect(callsTo('/orders/create')).toHaveLength(0)
    expect(await prisma.supplierOrderPush.count({ where: { orderId: o.id } })).toBe(0)
  })

  it('lets an order through when its country is on the list, whatever the spelling', async () => {
    await setCountries('us, ca')
    const us = await (await preview((await makeOrder({ country: 'United States' })).id)).json()
    expect(us.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(us.lines[0].shipCountries).toEqual(['US', 'CA'])
    const ca = await (await preview((await makeOrder({ country: 'CA', state: 'Ontario', zip: 'M5V 2T6' })).id)).json()
    expect(ca.issues.filter((i: any) => i.code === 'SHIP_COUNTRY')).toEqual([])
  })

  it('an order whose country cannot be read is blocked too', async () => {
    await setCountries('US')
    const o = await makeOrder({ country: 'Atlantis' })
    const body = await (await preview(o.id)).json()
    expect(body.issues.find((i: any) => i.code === 'SHIP_COUNTRY').message).toContain('đơn này giao Atlantis')
    expect(body.canPush).toBe(false)
  })

  it('PATCH on a supplier product normalises the list and refuses a bad code', async () => {
    const patch = (value: unknown) => patchSupplierProduct(
      new NextRequest(`http://x/api/suppliers/products/${productId}`, { method: 'PATCH', body: JSON.stringify({ apiShipCountries: value }) }),
      { params: { id: productId } },
    )
    expect((await patch(' us; ca ,US ')).status).toBe(200)
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { id: productId } }))).toMatchObject({ apiShipCountries: 'US,CA', apiSku: 'UT2-One_size', baseCost: 8 })
    const bad = await patch('USA')
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toContain('USA')
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { id: productId } })).apiShipCountries).toBe('US,CA')
    expect((await patch('')).status).toBe(200)
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { id: productId } })).apiShipCountries).toBeNull()
  })
})

describe('localhost / non-https guard', () => {
  it.each(['http://localhost:3002', 'https://localhost:3002', 'http://tool.shop-example.com', 'https://192.168.1.10', ''])(
    'refuses to build a push when NEXT_PUBLIC_APP_URL is %j', async (value) => {
      if (value) process.env.NEXT_PUBLIC_APP_URL = value
      else delete process.env.NEXT_PUBLIC_APP_URL
      const o = await makeOrder()
      const body = await (await preview(o.id)).json()
      expect(body.payload).toBeNull()
      expect(body.payloadHash).toBeNull()
      expect(body.canPush).toBe(false)
      expect(body.issues).toContainEqual(expect.objectContaining({ level: 'error', code: 'PUBLIC_URL' }))
      expect((await prisma.designArtwork.findUniqueOrThrow({ where: { id: o.artworkId! } })).publicToken).toBeNull()

      const res = await push(o.id, 'whatever')
      expect(res.status).toBe(422)
      expect((await res.json()).code).toBe('NOT_ELIGIBLE')
      expect(callsTo('/orders/create')).toHaveLength(0)
      expect(await prisma.supplierOrderPush.count({ where: { orderId: o.id } })).toBe(0)
    })
})

describe('POST push', () => {
  it('is refused while pgprints.pushEnabled is off', async () => {
    await setSetting(PGPRINTS_KEYS.pushEnabled, 'false')
    const o = await makeOrder()
    const body = await (await preview(o.id)).json()
    expect(body.pushEnabled).toBe(false)
    expect(body.canPush).toBe(false)
    const res = await push(o.id, body.payloadHash)
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('PUSH_DISABLED')
    expect(callsTo('/orders/create')).toHaveLength(0)
    expect(await prisma.supplierOrderPush.count({ where: { orderId: o.id } })).toBe(0)
  })

  it('is refused without admin or the CSV Export permission, and needs confirm + payloadHash', async () => {
    const o = await makeOrder()
    const body = await (await preview(o.id)).json()
    expect((await push(o.id, body.payloadHash, supportToken)).status).toBe(403)
    expect((await push(o.id, body.payloadHash, null as any)).status).toBe(401)
    const noConfirm = await postPush(await req(`${base(o.id)}/push`, adminToken, post({ payloadHash: body.payloadHash })), { params: { orderId: o.id } })
    expect(noConfirm.status).toBe(400)
    const noHash = await postPush(await req(`${base(o.id)}/push`, adminToken, post({ confirm: true })), { params: { orderId: o.id } })
    expect(noHash.status).toBe(400)
    expect(callsTo('/orders/create')).toHaveLength(0)
  })

  it('409 when the payload changed after the preview', async () => {
    const o = await makeOrder()
    const body = await (await preview(o.id)).json()
    await prisma.order.update({ where: { id: o.id }, data: { shippingAddress1: '99 Other Rd' } })
    const res = await push(o.id, body.payloadHash)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PAYLOAD_CHANGED')
    expect(callsTo('/orders/create')).toHaveLength(0)
    expect(await prisma.supplierOrderPush.count({ where: { orderId: o.id } })).toBe(0)
  })

  it('sends the reviewed body once, stores ids and costs, and marks the order exported', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    const res = await push(o.id, pre.payloadHash)
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.exported).toBe(true)
    expect(out.push).toMatchObject({
      status: 'CREATED', externalOrderId: o.number, supplierOrderCode: `PG-${o.number}`, totalCost: 11.25, shippingFee: 4.5, handleFee: 0.75, pushedByName: 'Admin',
    })

    const sent = callsTo('/orders/create')
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('POST')
    expect(JSON.parse(sent[0].body)).toEqual(pre.payload)
    expect(sent[0].headers['X-PGPrints-Store-Id']).toBe(STORE_ID)
    expect(sent[0].headers['X-PGPrints-Hmac-Sha256']).toBe(signBody(SECRET, sent[0].body))

    const row = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    expect(row).toMatchObject({ status: 'CREATED', supplierId: SUP, supplierInternalId: `int-${o.number}`, pushedById: adminId, exportMarked: true })
    expect(row.requestJson).toBe(sent[0].body)
    expect(row.requestJson).not.toContain(SECRET)
    expect(row.responseJson).toContain(`PG-${o.number}`)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.pipelineStatus).toBe('EXPORTED')
    expect(order.exportedToSupplierId).toBe(SUP)
    expect(order.exportedAt?.getTime()).toBe(row.pushedAt.getTime())

    const after = await (await preview(o.id)).json()
    expect(after.activePush).toMatchObject({ status: 'CREATED', supplierOrderCode: `PG-${o.number}` })
    expect(after.canPush).toBe(false)
    const again = await push(o.id, after.payloadHash)
    expect(again.status).toBe(409)
    expect((await again.json()).code).toBe('DUPLICATE')
    expect(callsTo('/orders/create')).toHaveLength(1)
  })

  it('two concurrent pushes create exactly one PGprints order', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    handler = async call => {
      if (call.path !== '/app/v1/orders/create') return { status: 200, json: { success: true, data: {} } }
      await new Promise(resolve => setTimeout(resolve, 80))
      return createdReply(call)
    }
    const [a, b] = await Promise.all([push(o.id, pre.payloadHash), push(o.id, pre.payloadHash)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(callsTo('/orders/create')).toHaveLength(1)
    expect(await prisma.supplierOrderPush.count({ where: { orderId: o.id } })).toBe(1)
  })

  it('stores FAILED with their message and exports nothing; a retry reuses the same order_id', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    handler = call => call.path === '/app/v1/orders/create'
      ? { status: 400, json: { success: false, message: 'Sku UT2-One_size is out of stock' } }
      : { status: 200, json: { success: true, data: {} } }
    const res = await push(o.id, pre.payloadHash)
    expect(res.status).toBe(502)
    const out = await res.json()
    expect(out.code).toBe('CREATE_FAILED')
    expect(out.error).toContain('out of stock')
    expect(callsTo('/orders/create')).toHaveLength(1)

    const failed = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    expect(failed).toMatchObject({ status: 'FAILED', activeKey: null, error: 'Sku UT2-One_size is out of stock', supplierOrderCode: null, exportMarked: false })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect(order.exportedAt).toBeNull()
    expect(order.exportedToSupplierId).toBeNull()

    handler = call => createdReply(call)
    const retry = await push(o.id, pre.payloadHash)
    expect(retry.status).toBe(200)
    const rows = await prisma.supplierOrderPush.findMany({ where: { orderId: o.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: failed.id, status: 'CREATED', externalOrderId: o.number, error: null })
  })

  it('keeps the push live when PGprints never answered, so a blind re-send is blocked', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    handler = call => (call.path === '/app/v1/orders/create' ? 'network-error' : { status: 200, json: { success: true, data: {} } })
    const res = await push(o.id, pre.payloadHash)
    expect(res.status).toBe(504)
    expect((await res.json()).code).toBe('UNKNOWN_RESULT')
    const row = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    expect(row.status).toBe('SENDING')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect((await push(o.id, pre.payloadHash)).status).toBe(409)
    expect(callsTo('/orders/create')).toHaveLength(1)

    handler = call => call.path === '/api/v1/orders/search'
      ? { status: 200, json: { success: true, data: [{ id: 'int-x', pgcOrderId: 'PG-FOUND', orderId: o.number, itemStatuses: ['cooling-off'], totalCost: 9 }] } }
      : { status: 404, json: {} }
    const synced = await refresh(o.id)
    expect(synced.status).toBe(200)
    expect((await synced.json()).push).toMatchObject({ status: 'CREATED', supplierOrderCode: 'PG-FOUND', remoteStatus: 'cooling-off', totalCost: 9 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('EXPORTED')
  })
})

describe('POST cancel', () => {
  it('cancels at PGprints, marks the push CANCELLED and reverts the export marking it set', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    expect((await push(o.id, pre.payloadHash)).status).toBe(200)

    expect((await cancel(o.id, supportToken)).status).toBe(403)
    const res = await cancel(o.id)
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.exportReverted).toBe(true)
    expect(out.push.status).toBe('CANCELLED')

    const sent = callsTo('/order/cancel')
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('PUT')
    expect(JSON.parse(sent[0].body)).toEqual({ orderId: `PG-${o.number}` })
    expect(sent[0].headers['X-PGPrints-Hmac-Sha256']).toBe(signBody(SECRET, sent[0].body))

    const row = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    expect(row).toMatchObject({ status: 'CANCELLED', activeKey: null })
    expect(row.cancelledAt).not.toBeNull()
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect(order.exportedAt).toBeNull()
    expect(order.exportedToSupplierId).toBeNull()

    expect((await cancel(o.id)).status).toBe(404)
    const next = await (await preview(o.id)).json()
    expect(next.payload.order_id).toBe(`${o.number}-R2`)
    expect(next.canPush).toBe(true)
  })

  it('leaves an export marking it did not set, and keeps the push when PGprints refuses', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    expect((await push(o.id, pre.payloadHash)).status).toBe(200)

    handler = () => ({ status: 400, json: { success: false, message: 'Order already in production' } })
    const refused = await cancel(o.id)
    expect(refused.status).toBe(502)
    expect((await refused.json()).error).toContain('already in production')
    expect((await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe('CREATED')

    const later = new Date('2026-10-05T00:00:00Z')
    await prisma.order.update({ where: { id: o.id }, data: { exportedAt: later } })
    handler = () => ({ status: 200, json: { success: true } })
    const out = await (await cancel(o.id)).json()
    expect(out.exportReverted).toBe(false)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.pipelineStatus).toBe('EXPORTED')
    expect(order.exportedAt?.getTime()).toBe(later.getTime())
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id, resolvedSupplierId: SUP } })
    expect(line.exportedToSupplierId).toBe(SUP)
  })
})

describe('GET /api/public/artwork/[token]/[fileName]', () => {
  const fetchArt = async (token: string, fileName: string) =>
    getPublicArtwork(new NextRequest(`http://x/api/public/artwork/${token}/${fileName}`), { params: { token, fileName } })

  it('streams an approved artwork without a session', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    const url = new URL(pre.payload.line_items[0].fileUrls[0])
    const [, , , , token, fileName] = url.pathname.split('/')
    const res = await fetchArt(token, fileName)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=0')
    expect(res.headers.get('Content-Length')).toBe(String(PNG.length))
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('404 for a bad token, a wrong extension, a removed artwork and an unapproved line', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    const token = new URL(pre.payload.line_items[0].fileUrls[0]).pathname.split('/')[4]

    expect((await fetchArt('f'.repeat(64), 'main.png')).status).toBe(404)
    expect((await fetchArt('not-a-token', 'main.png')).status).toBe(404)
    expect((await fetchArt(token.toUpperCase(), 'main.png')).status).toBe(404)
    expect((await fetchArt(token, 'main.pdf')).status).toBe(404)
    expect((await fetchArt(token, 'main.png')).status).toBe(200)

    await prisma.orderLine.updateMany({ where: { orderId: o.id }, data: { designDriveLink: null } })
    expect((await fetchArt(token, 'main.png')).status).toBe(404)
    await prisma.orderLine.updateMany({ where: { orderId: o.id }, data: { designDriveLink: '/api/design-studio/file/x' } })
    expect((await fetchArt(token, 'main.png')).status).toBe(200)

    await prisma.designTask.create({ data: { orderId: o.id, shopifyLineId: o.lineId, taskKey: `${o.number}_1`, status: 'REJECTED' } })
    expect((await fetchArt(token, 'main.png')).status).toBe(404)
    await prisma.designTask.updateMany({ where: { orderId: o.id }, data: { status: 'DONE' } })
    expect((await fetchArt(token, 'main.png')).status).toBe(200)

    await prisma.designArtwork.update({ where: { id: o.artworkId! }, data: { removedAt: new Date() } })
    expect((await fetchArt(token, 'main.png')).status).toBe(404)
  })
})

describe('several print files and uploaded mockups', () => {
  const fetchArt = async (token: string, fileName: string) =>
    getPublicArtwork(new NextRequest(`http://x/api/public/artwork/${token}/${fileName}`), { params: { token, fileName } })
  let n = 0

  async function addFile(o: { id: string; lineId: string }, kind: 'PRINT' | 'MOCKUP', printArea: string, fileName: string, extra: Record<string, unknown> = {}) {
    const rel = `design/pgp-extra/${++n}-${fileName}`
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
    fs.writeFileSync(path.join(tmp, rel), PNG)
    return prisma.designArtwork.create({
      data: { orderId: o.id, shopifyLineId: o.lineId, kind, printArea, version: 1, fileName, storagePath: rel, size: PNG.length, mimeType: 'image/png', ...extra },
    })
  }
  const publicUrl = async (id: string, fileName: string) =>
    `${APP_URL}/api/public/artwork/${(await prisma.designArtwork.findUniqueOrThrow({ where: { id } })).publicToken}/${fileName}`

  it('fileUrls: the template areas in template order, then the other parts by name; mockupImages: the uploaded mockups, newest first, instead of the preview', async () => {
    const o = await makeOrder()
    const sleeve = await addFile(o, 'PRINT', 'Sleeve', 'sleeve.png')
    await addFile(o, 'PRINT', 'collar', 'collar-old.png')
    const collar = await addFile(o, 'PRINT', 'collar', 'collar.png', { version: 2 })
    await addFile(o, 'PRINT', 'Gone', 'gone.png', { removedAt: new Date() })
    const look1 = await addFile(o, 'MOCKUP', 'Look 1', 'look1.png', { createdAt: new Date('2026-10-01T00:00:00Z') })
    const look2 = await addFile(o, 'MOCKUP', 'Look 2', 'look2.png', { createdAt: new Date('2026-10-02T00:00:00Z') })
    await addFile(o, 'MOCKUP', 'Main', 'not-a-print-file.png', { removedAt: new Date() })

    const body = await (await preview(o.id)).json()
    const item = body.payload.line_items[0]
    expect(item.fileUrls).toEqual([
      await publicUrl(o.artworkId!, 'main.png'), await publicUrl(collar.id, 'collar.png'), await publicUrl(sleeve.id, 'sleeve.png'),
    ])
    expect(item.mockupImages).toEqual([await publicUrl(look2.id, 'look2.png'), await publicUrl(look1.id, 'look1.png')])
    expect(body.lines[0].files.map((f: any) => f.area)).toEqual(['Main', 'collar', 'Sleeve'])
    expect(body.lines[0].mockupUrl).toBe(`/api/design-studio/file/${look2.id}`)
    expect(body.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(body.issues.filter((i: any) => i.code === 'EXTRA_FILE')).toHaveLength(2)
    expect(body.canPush).toBe(true)

    const [, , , , token, fileName] = new URL(item.mockupImages[0]).pathname.split('/')
    const res = await fetchArt(token, fileName)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
    await prisma.orderLine.updateMany({ where: { orderId: o.id }, data: { designDriveLink: null } })
    expect((await fetchArt(token, fileName)).status).toBe(404)
  })

  it('a line without a template sends every print file by name; with no print file at all it is blocked', async () => {
    await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'SOCK-NOTPL', baseCost: 4, apiSku: 'SOCK-One_size' } })
    const o = await makeOrder({ supplierSku: 'SOCK-NOTPL' })
    const right = await addFile(o, 'PRINT', 'right', 'right.png')
    const left = await addFile(o, 'PRINT', 'Left', 'left.png')
    const body = await (await preview(o.id)).json()
    expect(body.lines[0].templateName).toBeNull()
    expect(body.payload.line_items[0].fileUrls).toEqual([
      await publicUrl(left.id, 'left.png'), await publicUrl(o.artworkId!, 'main.png'), await publicUrl(right.id, 'right.png'),
    ])
    expect(body.payload.line_items[0].mockupImages).toEqual(['https://cdn.example.com/preview.png'])
    expect(body.issues.filter((i: any) => i.level === 'error')).toEqual([])
    expect(body.issues).toContainEqual(expect.objectContaining({ level: 'warning', code: 'NO_TEMPLATE' }))

    const empty = await makeOrder({ supplierSku: 'SOCK-NOTPL', withArtwork: false })
    await addFile(empty, 'MOCKUP', 'Look', 'look.png')
    const blocked = await (await preview(empty.id)).json()
    expect(blocked.issues).toContainEqual(expect.objectContaining({ level: 'error', code: 'NO_ARTWORK' }))
    expect(blocked.canPush).toBe(false)
  })
})

describe('POST /api/public/pgprints/tracking', () => {
  const hook = (body: unknown, secret: string | null) => postTracking(new NextRequest('http://x/api/public/pgprints/tracking', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Store-Secret': secret } : {}) },
  }))

  it('401 on a missing or wrong secret', async () => {
    expect((await hook({ orderId: 'x' }, null)).status).toBe(401)
    expect((await hook({ orderId: 'x' }, 'wrong')).status).toBe(401)
    expect((await hook({ orderId: 'x' }, SECRET.slice(0, -1))).status).toBe(401)
  })

  it('200 + ignored for an order it does not know', async () => {
    const res = await hook({ orderId: 'NOPE-1', pgcOrderId: 'PG-NOPE', trackingNumber: 'YT1', carrierCode: 'yunexpress' }, SECRET)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, ignored: true, shipments: 0 })
  })

  it('upserts one shipment per matching line and stays idempotent', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    expect((await push(o.id, pre.payloadHash)).status).toBe(200)
    const payload = {
      id: 'evt-1', sku: 'UT2-One_size', storeId: STORE_ID, pgcOrderId: `PG-${o.number}`, orderId: o.number,
      trackingNumber: 'YT0000000000000001', carrierCode: 'yunexpress', trackingedAt: '2026-10-02T17:00:00.000Z',
    }
    const first = await hook(payload, SECRET)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ ok: true, ignored: false, shipments: 1 })
    expect((await hook(payload, SECRET)).status).toBe(200)

    const shipments = await prisma.shipment.findMany({ where: { orderId: o.id } })
    expect(shipments).toHaveLength(1)
    expect(shipments[0]).toMatchObject({
      lineKey: `${o.number}_1`, trackingNumber: 'YT0000000000000001', carrier: 'yunexpress', supplierId: SUP, shopifyLineId: o.lineId, projectId: PROJECT,
    })
    const row = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    expect(row.remoteStatus).toBe('tracking-received')
    expect(row.lastSyncedAt).not.toBeNull()

    expect(await (await hook({ ...payload, sku: 'SOMETHING-ELSE' }, SECRET)).json()).toMatchObject({ ignored: false, shipments: 0 })
    expect(await (await hook({ ...payload, storeId: 'another-store' }, SECRET)).json()).toMatchObject({ ignored: true })

    await upsertOrderShipments(o.id, PROJECT, [{
      lineKey: `${o.number}_1`, shopifyLineId: o.lineId, sku: 'TUMBLER-A', productTitle: 'Custom Tumbler', supplierId: SUP,
      shopifyFulfillmentId: null, trackingNumber: null, carrier: null, trackingUrl: null, status: 'PENDING',
    }])
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } })).trackingNumber).toBe('YT0000000000000001')

    await upsertOrderShipments(o.id, PROJECT, [{
      lineKey: `${o.number}_1`, shopifyLineId: o.lineId, sku: 'TUMBLER-A', productTitle: 'Custom Tumbler', supplierId: SUP,
      shopifyFulfillmentId: 'gid://shopify/Fulfillment/1', trackingNumber: 'USPS123', carrier: 'USPS', trackingUrl: null, status: 'IN_TRANSIT',
    }])
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: o.id } }))).toMatchObject({ trackingNumber: 'USPS123', status: 'IN_TRANSIT' })
  })
})

describe('reconciling a refused create', () => {
  it('a FAILED push whose order_id exists at PGprints becomes CREATED; one PGprints does not know stays FAILED', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    handler = call => call.path === '/app/v1/orders/create'
      ? { status: 500, json: { success: false, message: 'Internal error' } }
      : { status: 200, json: { success: true, data: {} } }
    expect((await push(o.id, pre.payloadHash)).status).toBe(502)

    handler = () => ({ status: 200, json: { success: true, data: [] } })
    const missing = await (await refresh(o.id)).json()
    expect(missing.found).toBe(false)
    expect(missing.push.status).toBe('FAILED')

    handler = () => ({ status: 200, json: { success: true, data: [{ id: 'int-late', pgcOrderId: 'PG-LATE', orderId: o.number, itemStatuses: ['cooling-off'], totalCost: 12 }] } })
    const found = await (await refresh(o.id)).json()
    expect(found.push).toMatchObject({ status: 'CREATED', supplierOrderCode: 'PG-LATE', totalCost: 12, error: null })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.pipelineStatus).toBe('EXPORTED')
    expect((await push(o.id, pre.payloadHash)).status).toBe(409)
    expect(callsTo('/orders/create')).toHaveLength(1)
  })
})

describe('"Cập nhật trạng thái"', () => {
  it('stores the remote status of one push', async () => {
    const o = await makeOrder()
    const pre = await (await preview(o.id)).json()
    expect((await push(o.id, pre.payloadHash)).status).toBe(200)
    handler = call => call.path === '/api/v1/orders/search'
      ? { status: 200, json: { success: true, data: [
          { id: 'other', pgcOrderId: 'PG-OTHER', orderId: 'OTHER', itemStatuses: ['done'] },
          { id: `int-${o.number}`, pgcOrderId: `PG-${o.number}`, orderId: o.number, itemStatuses: ['in-production', 'in-production'] },
        ] } }
      : { status: 404, json: {} }
    expect((await refresh(o.id, supportToken)).status).toBe(403)
    const res = await refresh(o.id)
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.found).toBe(true)
    expect(out.push).toMatchObject({ status: 'CREATED', remoteStatus: 'in-production' })
    expect(out.push.lastSyncedAt).not.toBeNull()
    const search = callsTo('/orders/search')[0]
    expect(JSON.parse(search.body)).toMatchObject({ searchKey: `PG-${o.number}`, page: 1, size: 20 })
  })
})

describe('settings', () => {
  const settingsReq = (token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) => req('http://x/api/fulfillment/pgprints/settings', token, init)
  const put = (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

  it('GET never returns the secret', async () => {
    const res = await getSettings(await settingsReq(adminToken))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(SECRET.slice(0, 6))
    expect(text).not.toContain(SECRET.slice(-4))
    expect(text).not.toContain(STORE_ID)
    const body = JSON.parse(text)
    expect(body).toMatchObject({
      hasStoreId: true, hasSecretKey: true, defaultShipClass: 'US Economy', pushEnabled: true,
      webhookUrl: `${APP_URL}/api/public/pgprints/tracking`, publicUrlError: null,
    })
    expect(body.secretKey).toBeUndefined()
    expect((await getSettings(await settingsReq(null))).status).toBe(401)
  })

  it('PUT is superadmin-only, never echoes the secret, and a blank secret keeps the stored one', async () => {
    expect((await putSettings(await settingsReq(adminToken, put({ storeId: 'hack' })))).status).toBe(403)
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: PGPRINTS_KEYS.storeId } })).value).toBe(STORE_ID)

    const res = await putSettings(await settingsReq(superToken, put({ storeId: 'new-store-id-9999', secretKey: '', defaultShipClass: 'US Express', pushEnabled: false })))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(SECRET)
    expect(JSON.parse(text)).toMatchObject({ hasSecretKey: true, defaultShipClass: 'US Express', pushEnabled: false })
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: PGPRINTS_KEYS.secretKey } })).value).toBe(SECRET)
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: PGPRINTS_KEYS.storeId } })).value).toBe('new-store-id-9999')

    const rotated = await putSettings(await settingsReq(superToken, put({ secretKey: 'rotated-secret-abcdef' })))
    expect(await rotated.text()).not.toContain('rotated-secret-abcdef')
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: PGPRINTS_KEYS.secretKey } })).value).toBe('rotated-secret-abcdef')
  })

  it('cannot enable pushing without credentials', async () => {
    await setSetting(PGPRINTS_KEYS.secretKey, null)
    await setSetting(PGPRINTS_KEYS.pushEnabled, 'false')
    const res = await putSettings(await settingsReq(superToken, put({ pushEnabled: true })))
    expect(res.status).toBe(400)
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: PGPRINTS_KEYS.pushEnabled } })).value).toBe('false')
  })

  it('"Kiểm tra kết nối" returns the balance amounts', async () => {
    const url = 'http://x/api/fulfillment/pgprints/settings/test'
    expect((await postTestConnection(await req(url, supportToken, post({})))).status).toBe(403)
    const res = await postTestConnection(await req(url, adminToken, post({})))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, balance: { availableAmount: 100, pendingAmount: 5, paidAmount: 20, upcomingAmount: 0 } })
    const call = callsTo('/users/balance')[0]
    expect(call.body).toBe('{}')
    expect(call.headers['X-PGPrints-Hmac-Sha256']).toBe(signBody(SECRET, '{}'))

    handler = () => ({ status: 401, json: { success: false, message: 'Permission denied' } })
    const bad = await postTestConnection(await req(url, adminToken, post({})))
    expect(bad.status).toBe(502)
    expect((await bad.json()).error).toContain('Permission denied')
  })
})

describe('SKU mapping', () => {
  it('catalogue lookup returns variants, file slots and ship classes', async () => {
    handler = call => call.path === '/api/v1/productNormals/search'
      ? { status: 200, json: { success: true, data: [{ sku: 'UT2', name: '20oz Stainless Steel Tumbler', files: [{ name: 'Main', note: 'PNG, 300 DPI', sizeWidth: 3270, sizeHeight: 1860 }], shipClasses: ['US Economy'], variants: [{ sku: 'UT2-One_size' }] }] } }
      : { status: 404, json: {} }
    const res = await getCatalog(await req('http://x/api/fulfillment/pgprints/catalog?q=UT2', adminToken))
    expect(res.status).toBe(200)
    expect((await res.json()).products[0]).toMatchObject({ sku: 'UT2', shipClasses: ['US Economy'], variants: [{ sku: 'UT2-One_size' }], files: [{ name: 'Main', sizeWidth: 3270, sizeHeight: 1860 }] })
    expect(JSON.parse(callsTo('/productNormals/search')[0].body)).toEqual({ searchKey: 'UT2', page: 1, size: 20 })
    expect((await getCatalog(await req('http://x/api/fulfillment/pgprints/catalog?q=', adminToken))).status).toBe(400)
    expect((await getCatalog(await req('http://x/api/fulfillment/pgprints/catalog?q=UT2', supportToken))).status).toBe(403)
  })

  it('PATCH on a supplier product saves apiSku and apiShipClass without touching the cost', async () => {
    const res = await patchSupplierProduct(
      new NextRequest(`http://x/api/suppliers/products/${productId}`, { method: 'PATCH', body: JSON.stringify({ apiSku: ' UT2-One_size ', apiShipClass: 'US Economy' }) }),
      { params: { id: productId } },
    )
    expect(res.status).toBe(200)
    const row = await prisma.supplierProduct.findUniqueOrThrow({ where: { id: productId } })
    expect(row).toMatchObject({ apiSku: 'UT2-One_size', apiShipClass: 'US Economy', baseCost: 8, baseSku: 'UT2' })
    await patchSupplierProduct(
      new NextRequest(`http://x/api/suppliers/products/${productId}`, { method: 'PATCH', body: JSON.stringify({ apiShipClass: '' }) }),
      { params: { id: productId } },
    )
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { id: productId } })).apiShipClass).toBeNull()
  })
})
