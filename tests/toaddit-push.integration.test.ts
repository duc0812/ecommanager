import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { postToadditRos } from '@/lib/toaddit-transport'
import { buildToadditPush, cancelToadditPush, pushToadditOrder, refreshToadditPush, syncToadditCatalog, syncToadditTracking } from '@/lib/repos/toaddit-push'
import { getToadditSettings, saveToadditSettings } from '@/lib/toaddit-settings'
import { callToaddit, listToadditProducts, toadditAccount } from '@/lib/toaddit'
import { toadditVariantId } from '@/lib/toaddit-shared'
import { handoffStateFor } from '@/lib/supplier-handoff'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GET as settingsGet, PUT as settingsPut } from '@/app/api/fulfillment/toaddit/settings/route'
import { POST as pushRoute } from '@/app/api/fulfillment/toaddit/orders/[orderId]/push/route'
vi.mock('@/lib/toaddit-transport', () => ({ postToadditRos: vi.fn() }))
const PROJECT = 'project-toaddit-fixture', SUP = 'supplier-toaddit-fixture', KEY = 'ros-fixture-key'
const VARIANT = toadditVariantId('FZH56', 'ONESIZE'), OTHER = toadditVariantId('FZH9-L', 'ONESIZE')
let storeId = '', adminToken = '', superToken = '', seq = 0, creates = 0
let remote: any[] = [], catalog: any[] = [], calls: Array<{ path: string; body: any; key: string }> = []
let mode: 'ok' | 'timeout' | 'denied' | 'business-error' | 'bad-id' | 'wrong-readback' = 'ok'
let cancelRefused = false, wrongCancelId = false
const response = (data: any, page?: any) => ({ status: 200, text: JSON.stringify({ code: 0, success: 1, data, ...(page ? { page } : {}) }) })
async function makeOrder(opts: { foreign?: boolean; approved?: boolean; qty?: number; mockup?: boolean } = {}) {
  const id = `toaddit-order-${++seq}`
  await prisma.order.create({ data: {
    id, storeId, projectId: PROJECT, shopifyOrderNumber: `#TDTEST${1000 + seq}`, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 30, expectedPayout: 28, totalFees: 2, refundedAmount: 0, placedAt: new Date(), pipelineStatus: 'READY_TO_PRODUCTION', designReady: opts.approved !== false,
    customerName: 'Jo Doe', shippingName: 'Jo Doe', shippingPhone: '+13035550100', shippingAddress1: '12 Main St', shippingAddress2: 'Apt 4', shippingCity: 'Denver', shippingState: 'Colorado', shippingZip: '80202', shippingCountry: 'US',
    lines: { create: [{ shopifyLineId: `${id}-line`, sku: 'SELLER-DESIGN-1', productTitle: 'Toaddit Bag', qty: opts.qty ?? 1, unitPrice: 30, linePosition: 1, resolvedSupplierId: SUP, resolvedSupplierSku: 'TD-BASE',
      imageUrl: 'https://cdn.shopify.com/listing-sample-name.png', designDriveLink: '/api/design-studio/file/placeholder' },
      ...(opts.foreign ? [{ shopifyLineId: `${id}-other`, productTitle: 'Other supplier', qty: 1, unitPrice: 10, linePosition: 2, resolvedSupplierId: 'supplier-td-other', resolvedSupplierSku: 'OTHER', imageUrl: null, designDriveLink: null }] : [])] },
    designTasks: { create: { shopifyLineId: `${id}-line`, taskKey: `TDTEST${1000 + seq}_1`, status: opts.approved === false ? 'REVIEW' : 'DONE' } },
  } })
  await prisma.designArtwork.create({ data: { orderId: id, shopifyLineId: `${id}-line`, printArea: 'Print', version: 1, fileName: 'print.png', storagePath: `fixture/${id}.png`, mimeType: 'image/png', size: 100, widthPx: 1000, heightPx: 1000 } })
  if (opts.mockup !== false) await prisma.designArtwork.create({ data: { orderId: id, shopifyLineId: `${id}-line`, kind: 'MOCKUP', printArea: 'Preview', version: 1, fileName: 'correct-custom.png', storagePath: `fixture/${id}-mockup.png`, mimeType: 'image/png', size: 100, widthPx: 800, heightPx: 800 } })
  return id
}
const preview = async (id: string, selection = {}) => (await buildToadditPush(id, selection))!.preview
const send = async (id: string, variantIds = {}) => pushToadditOrder(id, { payloadHash: (await preview(id, variantIds)).payloadHash!, userId: null, confirmArtwork: true, variantIds })
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
  await prisma.printTemplate.create({ data: { id: 'ros-print-template', supplierId: SUP, name: 'Official sheet', widthPx: 1000, heightPx: 1000, dpi: 100, areas: '[{"name":"Print","x":0,"y":0,"w":1000,"h":1000}]' } })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'TD-BASE', apiSku: VARIANT, baseCost: 11, requiresDesign: true, printTemplateId: 'ros-print-template' } })
  for (const role of ['ADMIN', 'SUPERADMIN'] as const) {
    const user = await prisma.appUser.create({ data: { email: `${role}@toaddit.fixture`, name: role, role, passwordHash: 'x', permissions: '[]' } })
    const token = await signToken({ userId: user.id, email: user.email, name: role, role, permissions: [], tv: 0 })
    if (role === 'ADMIN') adminToken = token; else superToken = token
  }
})
beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
  await saveToadditSettings({ apiKey: KEY, shippingMethod: '1' })
  await prisma.supplierProduct.update({ where: { supplierId_sku: { supplierId: SUP, sku: 'TD-BASE' } }, data: { apiSku: VARIANT, apiShipClass: null } })
  creates = 0; calls = []; remote = []; mode = 'ok'; cancelRefused = false; wrongCancelId = false
  catalog = [{ productName: 'Hobo', status: 1, productCodeList: [{ productCode: 'FZH56', colorName: 'White' }], sizeList: [{ sizeName: 'ONESIZE', price: 11 }] },
    { productName: 'Large tote', status: 1, productCodeList: [{ productCode: 'FZH9-L', colorName: 'White' }], sizeList: [{ sizeName: 'ONESIZE', price: 11.5 }] }]
  vi.mocked(postToadditRos).mockImplementation(async (key, path, raw) => {
    const body = JSON.parse(raw); calls.push({ path, body, key })
    if (path === '/api/v1/prototype/prototypeList') return response(catalog, { total: catalog.length, pageIndex: 1, pageSize: 200 })
    if (path === '/api/v1/order/orderList') {
      const hits = remote.filter(o => o.orderCode === body.orderCode)
      return response(mode === 'wrong-readback' && hits.length ? hits.map(o => ({ ...o, id: '99999' })) : hits, { total: hits.length, pageIndex: 1, pageSize: 200 })
    }
    if (path === '/api/v1/order/createOrder') {
      creates++
      if (mode === 'denied') return { status: 200, text: JSON.stringify({ code: 1001000, success: 0, message: 'Invalid API key' }) }
      const id = String(600 + creates)
      remote.push({ id, orderCode: body.orderCode, status: 14, itemList: body.items.map((i: any, n: number) => ({ id: 100 + n, sku: i.sku, productCode: i.productCode, size: i.size, quantity: i.quantity })), expressWaybillCode: null, logisticTrackingUrl: null })
      if (mode === 'timeout') throw new Error('lost response')
      if (mode === 'business-error') return { status: 200, text: JSON.stringify({ code: 98765, success: 0, message: 'Unspecified business error' }) }
      return response(mode === 'bad-id' ? { orderId: id } : id)
    }
    if (path === '/api/v1/order/cancel') {
      if (cancelRefused) return { status: 200, text: JSON.stringify({ code: 1002000, success: 0, message: 'Cannot cancel' }) }
      expect(typeof body.id).toBe('number')
      const order = remote.find(o => o.id === String(body.id)); order.status = 80
      return response(wrongCancelId ? '99999' : order.id)
    }
    throw new Error(`Unexpected ROS path: ${path}`)
  })
})
afterEach(() => vi.mocked(postToadditRos).mockReset())
afterAll(async () => {
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplierCostHistory.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP, 'supplier-td-other'] } } })
  await prisma.appUser.deleteMany({ where: { email: { endsWith: '@toaddit.fixture' } } })
  await prisma.shopifyStore.delete({ where: { id: storeId } }); await prisma.project.delete({ where: { id: PROJECT } })
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'toaddit.' } } })
  delete process.env.NEXT_PUBLIC_APP_URL
})
describe('Toaddit ROS API integration', () => {
  it('keeps ROS key server-only and does not use legacy credentials', async () => {
    await set('toaddit.appKey', 'old-app-key'); await set('toaddit.appSecret', 'old-app-secret')
    await listToadditProducts(await toadditAccount())
    expect(calls.every(c => c.key === KEY)).toBe(true)
    const view = await (await settingsGet(request('settings', superToken))).json()
    expect(view).toEqual({ protocol: 'ros-v1', hasApiKey: true, hasCredentials: true, shippingMethod: '1' })
    expect(JSON.stringify(view)).not.toContain(KEY)
    await saveToadditSettings({ apiKey: null })
    await expect(toadditAccount()).rejects.toThrow('API key')
    expect(await prisma.appSetting.findUnique({ where: { key: 'toaddit.appSecret' } })).toBeTruthy()
  })
  it('builds actual ROS fields and sends approved file + mockup URLs', async () => {
    const id = await makeOrder({ foreign: true })
    const p = await preview(id, { [`${id}-line`]: OTHER })
    expect(p.canPush).toBe(true)
    expect(p.payload).toMatchObject({ items: [{ sku: 'SELLER-DESIGN-1', productCode: 'FZH9-L', size: 'ONESIZE', quantity: 1, designLink: expect.stringContaining('https://app.example.com/'), urlMockup: expect.stringContaining('https://app.example.com/') }], deliveryShippingType: 1, logistics: { address1: '12 Main St', address2: 'Apt 4', province: 'CO' } })
    for (const old of ['specificProductId', 'externalOrderCode', 'isPayment', 'addr1']) expect(JSON.stringify(p.payload)).not.toContain(old)
    await send(id, { [`${id}-line`]: OTHER })
    expect((await prisma.supplierProduct.findUniqueOrThrow({ where: { supplierId_sku: { supplierId: SUP, sku: 'TD-BASE' } } })).apiSku).toBe(VARIANT)
    const order = await prisma.order.findUniqueOrThrow({ where: { id }, include: { lines: true } })
    expect(order.lines.find(l => l.resolvedSupplierId === SUP)?.exportedAt).toBeTruthy()
    expect(order.lines.find(l => l.resolvedSupplierId !== SUP)?.exportedAt).toBeNull()
    expect(order.pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect((await handoffStateFor(id))?.apiKind).toBe('toaddit')
    await expect(send(id)).rejects.toMatchObject({ code: 'DUPLICATE' })
    expect(creates).toBe(1)
  })
  it('requires confirmation and refuses stale catalog/file choices', async () => {
    const id = await makeOrder(), p = await preview(id)
    await expect(pushToadditOrder(id, { payloadHash: p.payloadHash!, userId: null, confirmArtwork: false })).rejects.toMatchObject({ code: 'ARTWORK_NOT_CONFIRMED' })
    catalog[0].sizeList[0].price = 12
    await expect(pushToadditOrder(id, { payloadHash: p.payloadHash!, userId: null, confirmArtwork: true })).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' })
    expect(creates).toBe(0)
  })
  it('blocks unapproved art, listing-only mockups, old mappings, retired products, missing phone and multi-sheet links', async () => {
    expect((await preview(await makeOrder({ approved: false }))).canPush).toBe(false)
    expect((await preview(await makeOrder({ mockup: false }))).issues.map(i => i.code)).toContain('NO_MOCKUP')
    const id = await makeOrder()
    await prisma.supplierProduct.update({ where: { supplierId_sku: { supplierId: SUP, sku: 'TD-BASE' } }, data: { apiSku: '2500' } })
    expect((await preview(id)).issues.map(i => i.code)).toContain('PRODUCT_UNAVAILABLE')
    await prisma.supplierProduct.update({ where: { supplierId_sku: { supplierId: SUP, sku: 'TD-BASE' } }, data: { apiSku: VARIANT } })
    catalog[0].status = 2
    expect((await preview(id)).canPush).toBe(false); catalog[0].status = 1
    await prisma.order.update({ where: { id }, data: { shippingPhone: null } })
    expect((await preview(id)).issues.map(i => i.code)).toContain('ADDRESS')
    await prisma.designArtwork.create({ data: { orderId: id, shopifyLineId: `${id}-line`, printArea: 'Extra', version: 1, fileName: 'extra.png', storagePath: 'fixture/extra.png', mimeType: 'image/png', size: 10 } })
    expect((await preview(id)).issues.map(i => i.code)).toContain('PRINT_SHEET')
  })
  it('only one concurrent confirm creates an order', async () => {
    const id = await makeOrder(), p = await preview(id)
    const results = await Promise.allSettled([1, 2].map(() => pushToadditOrder(id, { payloadHash: p.payloadHash!, userId: null, confirmArtwork: true })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(creates).toBe(1)
  })
  it.each(['timeout', 'business-error', 'bad-id'] as const)('holds an uncertain create (%s) and reconciles documented orderList fields', async failure => {
    const id = await makeOrder(); mode = failure
    await expect(send(id)).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' })
    expect((await pushRow(id)).status).toBe('SENDING')
    expect((await pushRow(id)).exportMarked).toBe(false)
    await expect(send(id)).rejects.toMatchObject({ code: 'DUPLICATE' })
    const saved = remote; remote = []
    await refreshToadditPush(id); expect((await pushRow(id)).status).toBe('SENDING')
    remote = saved; remote[0].itemList[0].size = 'WRONG'
    await expect(refreshToadditPush(id)).rejects.toMatchObject({ code: 'REMOTE_MISMATCH' })
    remote[0].itemList[0].size = 'ONESIZE'
    expect((await refreshToadditPush(id)).push.status).toBe('CREATED')
    expect(creates).toBe(1)
  })
  it('keeps returned create ID and refuses a different read-back ID', async () => {
    const id = await makeOrder(); mode = 'wrong-readback'
    await expect(send(id)).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' })
    expect((await pushRow(id)).supplierInternalId).toBe('601')
    await expect(refreshToadditPush(id)).rejects.toMatchObject({ code: 'REMOTE_MISMATCH' })
    mode = 'ok'; expect((await refreshToadditPush(id)).push.status).toBe('CREATED')
  })
  it('only retries a definite authentication rejection; supports shipping3 without payment/price overrides', async () => {
    const id = await makeOrder(); mode = 'denied'
    await expect(send(id)).rejects.toMatchObject({ code: 'CREATE_FAILED' })
    expect((await pushRow(id)).status).toBe('FAILED')
    mode = 'ok'; await saveToadditSettings({ shippingMethod: '3' }); await send(id)
    const body = calls.filter(c => c.path.endsWith('/createOrder')).at(-1)!.body
    expect(body.deliveryShippingType).toBe(3)
    expect(body).not.toHaveProperty('isPayment')
    expect(body.items[0]).not.toHaveProperty('totalPrice')
    expect(body.items[0]).not.toHaveProperty('surcharge')
  })
  it('confirms cancellation by scalar ID AND remote status, restores only sent lines and changes resend code', async () => {
    const id = await makeOrder(); await send(id)
    cancelRefused = true; await expect(cancelToadditPush(id)).rejects.toThrow()
    expect((await pushRow(id)).status).toBe('CREATED'); cancelRefused = false
    wrongCancelId = true; await expect(cancelToadditPush(id)).rejects.toThrow()
    expect((await pushRow(id)).status).toBe('CREATED'); wrongCancelId = false
    expect((await cancelToadditPush(id)).push.status).toBe('CANCELLED')
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: id } })).exportedAt).toBeNull()
    expect((await preview(id)).payload).toMatchObject({ orderCode: expect.stringMatching(/-R2$/) })
  })
  it('refuses changed ROS keys and legacy push snapshots before network calls', async () => {
    const id = await makeOrder(); await send(id); calls = []
    await saveToadditSettings({ apiKey: 'different-account' })
    await expect(refreshToadditPush(id)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    expect(calls).toHaveLength(0)
    await saveToadditSettings({ apiKey: KEY })
    const push = await pushRow(id); await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { requestJson: '{"request":{"items":[]}}' } })
    await expect(refreshToadditPush(id)).rejects.toMatchObject({ code: 'LEGACY_PUSH' })
    expect(calls).toHaveLength(0)
  })
  it('reads documented waybill, does not invent carrier, rejects multiple tracking numbers', async () => {
    const id = await makeOrder({ foreign: true }); await send(id)
    remote[0].status = 70; remote[0].expressWaybillCode = 'TRACK1,TRACK2'
    expect((await refreshToadditPush(id)).shipments).toBe(0)
    remote[0].expressWaybillCode = 'ROS123456789'
    expect((await refreshToadditPush(id)).shipments).toBe(1)
    expect(await prisma.shipment.findMany({ where: { orderId: id } })).toMatchObject([{ supplierId: SUP, shopifyLineId: `${id}-line`, trackingNumber: 'ROS123456789', carrier: null }])
    expect((await syncToadditTracking()).shipments).toBe(0)
  })
  it('imports published code/size while preserving existing print template and shipping', async () => {
    await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'FZH56-ONESIZE', baseCost: 10, shippingByRegion: '{"US":{"first":6,"additional":2}}', printTemplateId: 'ros-print-template' } })
    expect(await syncToadditCatalog()).toMatchObject({ imported: 2 })
    expect(await prisma.supplierProduct.findUniqueOrThrow({ where: { supplierId_sku: { supplierId: SUP, sku: 'FZH56-ONESIZE' } } })).toMatchObject({ apiSku: VARIANT, baseCost: 11, shippingByRegion: '{"US":{"first":6,"additional":2}}', printTemplateId: 'ros-print-template' })
    catalog[0].sizeList[0].price = null
    expect(await syncToadditCatalog()).toMatchObject({ imported: 1, skipped: 1 })
  })
  it('protects settings, preserves blank keys, accepts pasted Bearer and rejects stale settings/push requests', async () => {
    expect((await settingsPut(request('settings', adminToken, { apiKey: 'wrong' }))).status).toBe(403)
    expect((await settingsPut(request('settings', superToken, { apiKey: '' }))).status).toBe(200)
    expect(await getToadditSettings()).toMatchObject({ apiKey: KEY })
    expect((await settingsPut(request('settings', superToken, { apiKey: `Bearer ${KEY}`, shippingMethod: '3' }))).status).toBe(200)
    expect(await getToadditSettings()).toEqual({ apiKey: KEY, shippingMethod: '3' })
    for (const body of [{ appKey: 'old' }, { payOnCreate: true }, { environment: 'sandbox' }, { apiKey: 'x\ny' }, { shippingMethod: '4' }]) expect((await settingsPut(request('settings', superToken, body))).status).toBe(400)
    const id = await makeOrder()
    expect((await pushRoute(request(`orders/${id}/push`, adminToken, { confirm: true, confirmTemplates: true, payloadHash: 'a'.repeat(64) }, 'POST'), { params: { orderId: id } })).status).toBe(400)
  })
  it('does not accept HTTP200 with success0 or leak the Bearer value in upstream errors', async () => {
    vi.mocked(postToadditRos).mockResolvedValueOnce({ status: 200, text: JSON.stringify({ code: 123, success: 0, message: `Invalid Bearer ${KEY}` }) })
    await expect(callToaddit(await toadditAccount(), '/prototype/prototypeList', {})).rejects.toThrow('[redacted]')
  })
  it('reads all ROS catalog pages and refuses a mismatched page', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ productName: `Product ${i}`, status: 1, productCodeList: [{ productCode: `C${i}` }], sizeList: [{ sizeName: 'M', price: 5 }] }))
    vi.mocked(postToadditRos).mockImplementation(async (_key, _path, raw) => {
      const body = JSON.parse(raw), index = body.page.pageIndex
      expect(body.page.pageSize).toBe(200)
      return response(index === 1 ? page1 : [{ ...page1[0], productCodeList: [{ productCode: 'LAST' }] }], { total: 201, pageIndex: index })
    })
    const variants = await listToadditProducts(await toadditAccount())
    expect(variants).toHaveLength(201); expect(variants.at(-1)?.productCode).toBe('LAST')
    vi.mocked(postToadditRos).mockResolvedValueOnce(response(page1, { total: 201, pageIndex: 2 }))
    await expect(listToadditProducts(await toadditAccount())).rejects.toThrow('sai trang')
  })
  it('treats server5xx as an uncertain mutation even if its body claims an auth error', async () => {
    vi.mocked(postToadditRos).mockResolvedValueOnce({ status: 503, text: JSON.stringify({ code: 1001000, success: 0 }) })
    await expect(callToaddit(await toadditAccount(), '/order/createOrder', {}, true)).rejects.toMatchObject({ unknownOutcome: true })
  })
  it('requires a fresh confirmation after the print version changes', async () => {
    const id = await makeOrder(), before = await preview(id)
    await prisma.designArtwork.create({ data: { orderId: id, shopifyLineId: `${id}-line`, printArea: 'Print', version: 2, fileName: 'updated.png', storagePath: 'fixture/updated.png', mimeType: 'image/png', size: 100, widthPx: 1000, heightPx: 1000 } })
    await expect(pushToadditOrder(id, { payloadHash: before.payloadHash!, userId: null, confirmArtwork: true })).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' })
    expect(creates).toBe(0)
  })
})
