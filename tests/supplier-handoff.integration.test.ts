import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { canCallApi } from '@/lib/api-access'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { PGPRINTS_KEYS } from '@/lib/pgprints-settings'
import { syncDesignTasks, transitionTask, type Actor } from '@/lib/design-tasks'
import { countPendingHandoff, handoffStateFor, listHandoffCards } from '@/lib/supplier-handoff'
import { GET as getTasks } from '@/app/api/design-studio/tasks/route'
import { GET as getTask } from '@/app/api/design-studio/tasks/[key]/route'
import { GET as getHandoff } from '@/app/api/design-studio/handoff/route'
import { POST as postHandoff, DELETE as deleteHandoff } from '@/app/api/design-studio/orders/[id]/handoff/route'
import { GET as getPreview } from '@/app/api/fulfillment/pgprints/orders/[orderId]/preview/route'
import { POST as postPush } from '@/app/api/fulfillment/pgprints/orders/[orderId]/push/route'
import { POST as postCancel } from '@/app/api/fulfillment/pgprints/orders/[orderId]/cancel/route'
import { POST as postExport } from '@/app/api/fulfillment/export/route'

const SHOP = 'hof.myshopify.com'
const PROJECT = 'proj_hof'
const CSV_SUP = 'sup_hof_csv'
const PG_SUP = 'sup_hof_pg'
const EMAILS = ['admin@hof.test', 'export@hof.test', 'des@hof.test']
const PRINT = JSON.stringify([{ print_area: 'Main', url: 'https://cdn.example/hof.png' }])

let storeId = ''
let templateId = ''
let seq = 0
let ADMIN: Actor
let EXPORTER: Actor
let DES: Actor
let adminToken = ''
let exportToken = ''
let desToken = ''
let createCalls = 0

type MakeOpts = { api?: boolean; supplierSku?: string; lines?: number; approve?: boolean; country?: string }

async function makeOrder(opts: MakeOpts = {}) {
  seq++
  const id = `gid://test/Order/hof-${seq}`
  const number = `#HOF${seq}`
  const supplierId = opts.api ? PG_SUP : CSV_SUP
  const count = opts.lines ?? 1
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 30, expectedPayout: 28, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-05T10:00:00Z'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM', defaultSupplierId: supplierId,
      customerEmail: 'mary@example.com', customerName: 'Mary Watson', shippingName: 'Mary Watson', shippingAddress1: '12 Main St',
      shippingCity: 'Denver', shippingZip: '80202', shippingPhone: '+1 303 555 0100', shippingCountry: opts.country ?? 'US', shippingState: 'Colorado',
      lines: { create: Array.from({ length: count }, (_, i) => ({
        shopifyLineId: `hof-${seq}-${i + 1}`, sku: 'HOF-TUMBLER', productTitle: 'Custom Tumbler', variantTitle: '20oz', qty: 1, linePosition: i + 1, unitPrice: 15,
        resolvedSupplierId: supplierId, resolvedSupplierSku: opts.supplierSku ?? (opts.api ? 'UT2-20OZ' : 'CSV-TUMBLER'), customized: true,
        previewCdnUrl: 'https://cdn.example.com/preview.png',
        customAttributesJson: JSON.stringify([{ key: 'Name', value: `Ann ${i + 1}` }, { key: '_print_files', value: PRINT }]),
      })) },
    },
  })
  for (let i = 1; i <= count; i++) {
    await prisma.designArtwork.create({
      data: { orderId: id, shopifyLineId: `hof-${seq}-${i}`, printArea: 'Main', version: 1, fileName: 'main.png', storagePath: `x/hof-${seq}-${i}.png`, size: 10, mimeType: 'image/png', widthPx: 100, heightPx: 100 },
    })
  }
  await syncDesignTasks(id)
  const keys = Array.from({ length: count }, (_, i) => `HOF${seq}_${i + 1}`)
  await prisma.designTask.updateMany({ where: { orderId: id }, data: { status: 'REVIEW' } })
  if (opts.approve !== false) for (const key of keys) await transitionTask(key, DES, { to: 'DONE' })
  return { id, number, keys }
}

function req(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

const json = (method: string, body?: unknown) => ({ method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) })
const handoffUrl = (id: string) => `http://x/api/design-studio/orders/${encodeURIComponent(id)}/handoff`
const saveCsv = (id: string, token: string | null, body: unknown = { mode: 'CSV' }) => postHandoff(req(handoffUrl(id), token, json('POST', body)), { params: { id } })
const undo = (id: string, token: string | null) => deleteHandoff(req(handoffUrl(id), token, json('DELETE')), { params: { id } })
const pgBase = (id: string) => `http://x/api/fulfillment/pgprints/orders/${encodeURIComponent(id)}`
const preview = async (id: string, token: string) => (await getPreview(req(`${pgBase(id)}/preview`, token), { params: { orderId: id } })).json()
const push = (id: string, payloadHash: string, token: string | null) =>
  postPush(req(`${pgBase(id)}/push`, token, json('POST', { confirm: true, payloadHash })), { params: { orderId: id } })
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })

async function exportCsv(body: Record<string, unknown>) {
  return postExport(new NextRequest('http://x/api/fulfillment/export', json('POST', { templateId, dateFrom: '2026-10-01', dateTo: '2026-10-31', ...body })))
}

async function setSetting(key: string, value: string | null) {
  if (value === null) await prisma.appSetting.deleteMany({ where: { key } })
  else await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'HOF', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'hof_csv' }, create: { id: CSV_SUP, name: 'CSV Factory', code: 'hof_csv' }, update: {} })
  await prisma.supplier.upsert({ where: { code: 'pgprints' }, create: { id: PG_SUP, name: 'Pgprints', code: 'pgprints' }, update: {} })
  await prisma.supplierProduct.create({ data: { supplierId: PG_SUP, sku: 'UT2-20OZ', baseCost: 8, apiSku: 'UT2-One_size' } })
  await prisma.supplierProduct.create({ data: { supplierId: PG_SUP, sku: 'NO-API', baseCost: 8 } })
  await prisma.supplierProduct.create({ data: { supplierId: CSV_SUP, sku: 'CSV-TUMBLER', baseCost: 6 } })
  templateId = (await prisma.csvTemplate.create({
    data: { supplierId: CSV_SUP, name: 'HOF template', rowMode: 'PER_ORDER', columns: JSON.stringify([{ header: 'Order', source: 'order.shopifyOrderNumber' }]) },
  })).id
  const user = async (email: string, name: string, role: string, permissions: string[]) =>
    (await prisma.appUser.upsert({ where: { email }, create: { name, email, role, permissions: JSON.stringify(permissions) }, update: {} })).id
  const adminPerms = DEFAULT_ROLE_PERMISSIONS.ADMIN
  const exportPerms = ['design_tasks', 'fulfillment_export'] as const
  const adminId = await user('admin@hof.test', 'Admin', 'ADMIN', adminPerms)
  const exportId = await user('export@hof.test', 'Exporter', 'SUPPORT', [...exportPerms])
  const desId = await user('des@hof.test', 'Des', 'SUPPORT', ['design_tasks'])
  ADMIN = { id: adminId, name: 'Admin', role: 'ADMIN', permissions: adminPerms }
  EXPORTER = { id: exportId, name: 'Exporter', role: 'SUPPORT', permissions: [...exportPerms] }
  DES = { id: desId, name: 'Des', role: 'SUPPORT', permissions: ['design_tasks'] }
  adminToken = await signToken({ userId: adminId, email: 'admin@hof.test', name: 'Admin', role: 'ADMIN', permissions: adminPerms, tv: 0 })
  exportToken = await signToken({ userId: exportId, email: 'export@hof.test', name: 'Exporter', role: 'SUPPORT', permissions: [...exportPerms], tv: 0 })
  desToken = await signToken({ userId: desId, email: 'des@hof.test', name: 'Des', role: 'SUPPORT', permissions: ['design_tasks'], tv: 0 })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.csvTemplate.deleteMany({ where: { supplierId: CSV_SUP } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: { in: [CSV_SUP, PG_SUP] } } })
  await prisma.supplier.deleteMany({ where: { id: { in: [CSV_SUP, PG_SUP] } } })
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: [...Object.values(PGPRINTS_KEYS), 'design.settings'] } } })
  delete process.env.NEXT_PUBLIC_APP_URL
})

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://tool.shop-example.com'
  await setSetting(PGPRINTS_KEYS.storeId, 'hof-store-id-123456')
  await setSetting(PGPRINTS_KEYS.secretKey, 'hof-secret-key-0123456789')
  await setSetting(PGPRINTS_KEYS.defaultShipClass, 'US Economy')
  await setSetting(PGPRINTS_KEYS.pushEnabled, 'true')
  createCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://app.pgprints.io') throw new Error(`test blocked a call to ${url.origin}`)
    let data: unknown = {}
    if (url.pathname === '/api/v1/users/balance') data = { availableAmount: 100, pendingAmount: 0, paidAmount: 0, upcomingAmount: 0 }
    if (url.pathname === '/app/v1/orders/create') {
      createCalls++
      const body = JSON.parse(String(init?.body ?? '{}'))
      data = { id: `int-${body.order_id}`, pgcOrderId: `PG-${body.order_id}`, orderId: body.order_id, totalCost: 11, shippingFee: 4, handleFee: 1 }
    }
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('"Chuyển xưởng" queue and chip counts', () => {
  it('an order enters the queue only once every line is approved', async () => {
    const before = await countPendingHandoff()
    const o = await makeOrder({ lines: 2, approve: false })
    expect(await countPendingHandoff()).toBe(before)
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: false, blocked: 'Còn 2 dòng chưa duyệt design', handedOff: null })

    await transitionTask(o.keys[0], DES, { to: 'DONE' })
    expect(await countPendingHandoff()).toBe(before)
    expect((await handoffStateFor(o.id))!.blocked).toBe('Còn 1 dòng chưa duyệt design')
    expect((await saveCsv(o.id, exportToken)).status).toBe(409)

    await transitionTask(o.keys[1], DES, { to: 'DONE' })
    expect(await countPendingHandoff()).toBe(before + 1)
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, blocked: null, mode: 'CSV', apiName: null })
    const saved = await order(o.id)
    expect(saved).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', designReady: true, supplierHandoffAt: null, exportedAt: null })
  })

  it('the Design Tasks page gets the "Chuyển xưởng N" count next to the tasks behind "Duyệt mẫu N"', async () => {
    const waiting = await makeOrder({ approve: false })
    await makeOrder()
    const body = await (await getTasks(req('http://x/api/design-studio/tasks', desToken))).json()
    expect(body.handoffCount).toBe(await countPendingHandoff())
    expect(body.handoffCount).toBeGreaterThanOrEqual(1)
    const reviewKeys = body.tasks.filter((t: any) => t.status === 'REVIEW').map((t: any) => t.taskKey)
    expect(reviewKeys).toContain(waiting.keys[0])
    expect(reviewKeys.length).toBe(await prisma.designTask.count({ where: { status: 'REVIEW' } }))
    const grid = await (await getHandoff(req('http://x/api/design-studio/handoff', desToken))).json()
    expect(grid.pendingCount).toBe(body.handoffCount)
    expect(grid.pending.length).toBe(body.handoffCount)
  })

  it('one card per order with supplier, lines, print files, customer values and the destination', async () => {
    const o = await makeOrder({ lines: 2 })
    const res = await getHandoff(req('http://x/api/design-studio/handoff?q=HOF', desToken))
    expect(res.status).toBe(200)
    const body = await res.json()
    const mine = body.pending.filter((c: any) => c.order.id === o.id)
    expect(mine).toHaveLength(1)
    const c = mine[0]
    expect(c.order).toMatchObject({ orderNumber: o.number, countryCode: 'US', countryName: 'United States', shipTo: 'Denver, Colorado', storeName: 'HOF' })
    expect(c.suppliers).toEqual([{ id: CSV_SUP, name: 'CSV Factory', code: 'hof_csv' }])
    expect(c.lines.map((l: any) => l.taskKey)).toEqual(o.keys)
    expect(c.lines[0].slots).toEqual([])
    expect(c.lines[0].driveFolderUrl).toBeNull()
    expect(c.lines[0].line.artworks[0]).toMatchObject({ printArea: 'Main', fileName: 'main.png', mimeType: 'image/png' })
    expect(c.lines[1].line.personalization).toEqual([{ key: 'Name', value: 'Ann 2' }])
    expect(c.state).toMatchObject({ pending: true, mode: 'CSV', handedOff: null, push: null })
    expect(body.me).toMatchObject({ canHandoff: false, canApprove: true })
    expect((await getHandoff(req('http://x/api/design-studio/handoff', null))).status).toBe(401)
    const none = await (await getHandoff(req('http://x/api/design-studio/handoff?q=khong-co-don-nay', desToken))).json()
    expect(none.pending).toEqual([])
  })

  it('the task detail carries the order handoff state for the header button', async () => {
    const o = await makeOrder()
    const detail = await (await getTask(req(`http://x/api/design-studio/tasks/${o.keys[0]}`, exportToken), { params: { key: o.keys[0] } })).json()
    expect(detail.handoff).toMatchObject({ pending: true, mode: 'CSV' })
    expect(detail.me).toMatchObject({ canHandoff: true })
  })
})

describe('CSV handoff — supplier without an API', () => {
  it('sets the three fields and nothing else; the order stays in the CSV export queue', async () => {
    const o = await makeOrder()
    const before = await countPendingHandoff()
    const res = await saveCsv(o.id, exportToken)
    expect(res.status).toBe(200)
    expect((await res.json()).handoff).toMatchObject({ pending: false, canUndo: true, handedOff: { mode: 'CSV', byName: 'Exporter' } })

    const saved = await order(o.id)
    expect(saved.supplierHandoffMode).toBe('CSV')
    expect(saved.supplierHandoffById).toBe(EXPORTER.id)
    expect(saved.supplierHandoffAt).toBeInstanceOf(Date)
    expect(saved).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', designReady: true, exportedAt: null, exportedToSupplierId: null })
    expect(await countPendingHandoff()).toBe(before - 1)

    const cards = await listHandoffCards()
    expect(cards.pending.some(c => c.order.id === o.id)).toBe(false)
    expect(cards.saved.find(c => c.order.id === o.id)?.state.handedOff).toMatchObject({ mode: 'CSV', byName: 'Exporter' })

    const exported = await (await exportCsv({ preview: true, pipelineStatus: 'READY_TO_PRODUCTION' })).json()
    expect(exported.csv).toContain(o.number)
    const events = await prisma.designTaskEvent.findMany({ where: { task: { orderId: o.id }, type: 'HANDOFF' } })
    expect(events).toEqual([expect.objectContaining({ message: 'Chuyển supplier — lưu chờ xuất CSV', actorId: EXPORTER.id })])
  })

  it('the export preview badges handed-off orders and "Chỉ đơn design đã chuyển" narrows to them', async () => {
    const handed = await makeOrder()
    const waiting = await makeOrder()
    await saveCsv(handed.id, exportToken)

    const all = await (await exportCsv({ preview: true, pipelineStatus: 'READY_TO_PRODUCTION' })).json()
    expect(all.orders.find((o: any) => o.shopifyOrderNumber === handed.number)).toMatchObject({ designHandedOff: true, handoffMode: 'CSV', pipelineStatus: 'READY_TO_PRODUCTION' })
    expect(all.orders.find((o: any) => o.shopifyOrderNumber === waiting.number)).toMatchObject({ designHandedOff: false, handoffMode: null })
    expect(all.orderCount).toBe(all.orders.length)
    expect(all.handoffCount).toBe(all.orders.filter((o: any) => o.designHandedOff).length)
    expect(all.csv).toContain(handed.number)
    expect(all.csv).toContain(waiting.number)

    const only = await (await exportCsv({ preview: true, pipelineStatus: 'READY_TO_PRODUCTION', handoffOnly: true })).json()
    expect(only.orders.every((o: any) => o.designHandedOff)).toBe(true)
    expect(only.csv).toContain(handed.number)
    expect(only.csv).not.toContain(waiting.number)
    expect(only.handoffCount).toBe(only.orderCount)

    const download = await exportCsv({ markExported: true, pipelineStatus: 'READY_TO_PRODUCTION', handoffOnly: true })
    expect(await download.text()).toContain(handed.number)
    expect((await order(handed.id)).pipelineStatus).toBe('EXPORTED')
    expect((await order(waiting.id)).pipelineStatus).toBe('READY_TO_PRODUCTION')
  })

  it('a second handoff is refused', async () => {
    const o = await makeOrder()
    expect((await saveCsv(o.id, adminToken)).status).toBe(200)
    const again = await saveCsv(o.id, adminToken)
    expect(again.status).toBe(409)
    expect((await again.json()).code).toBe('ALREADY_HANDED_OFF')
  })

  it('"Hoàn tác" clears the fields and puts the order back in the queue', async () => {
    const o = await makeOrder()
    await saveCsv(o.id, exportToken)
    const before = await countPendingHandoff()
    const res = await undo(o.id, exportToken)
    expect(res.status).toBe(200)
    expect((await res.json()).handoff).toMatchObject({ pending: true, handedOff: null })
    expect(await order(o.id)).toMatchObject({ supplierHandoffAt: null, supplierHandoffMode: null, supplierHandoffById: null, pipelineStatus: 'READY_TO_PRODUCTION' })
    expect(await countPendingHandoff()).toBe(before + 1)
    const again = await undo(o.id, exportToken)
    expect(again.status).toBe(409)
    expect((await again.json()).code).toBe('NOT_HANDED_OFF')
  })

  it('the CSV export itself is unchanged, and undo is refused once the order is exported', async () => {
    const o = await makeOrder()
    await saveCsv(o.id, exportToken)
    const res = await exportCsv({ markExported: true, pipelineStatus: 'READY_TO_PRODUCTION' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(o.number)
    const after = await order(o.id)
    expect(after).toMatchObject({ pipelineStatus: 'EXPORTED', exportedToSupplierId: CSV_SUP, supplierHandoffMode: 'CSV', supplierHandoffById: EXPORTER.id })
    const refused = await undo(o.id, adminToken)
    expect(refused.status).toBe(409)
    expect((await refused.json()).code).toBe('EXPORTED')
    expect((await order(o.id)).supplierHandoffMode).toBe('CSV')
  })

  it('an export without a handoff still works: handoff is not a gate', async () => {
    const o = await makeOrder()
    const res = await exportCsv({ markExported: true, pipelineStatus: 'READY_TO_PRODUCTION' })
    expect(await res.text()).toContain(o.number)
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'EXPORTED', supplierHandoffAt: null, supplierHandoffMode: null })
    const late = await saveCsv(o.id, adminToken)
    expect(late.status).toBe(409)
    expect((await late.json()).error).toBe('Đơn đã Exported')
  })

  it('reopening a line throws the saved handoff away: the new design has to be handed over again', async () => {
    const o = await makeOrder()
    await saveCsv(o.id, exportToken)
    await transitionTask(o.keys[0], DES, { to: 'DOING' })
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', designReady: false, supplierHandoffAt: null, supplierHandoffMode: null, supplierHandoffById: null })
    await transitionTask(o.keys[0], DES, { to: 'REVIEW' })
    await transitionTask(o.keys[0], DES, { to: 'DONE' })
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, handedOff: null })
  })

  it('is refused while a PGprints push is live for the order', async () => {
    const o = await makeOrder({ api: true })
    await prisma.supplierOrderPush.create({ data: {
      orderId: o.id, supplierId: PG_SUP, externalOrderId: `${o.number.slice(1)}-seed`, activeKey: `${o.id}::${PG_SUP}`, status: 'SENDING', requestJson: '{}',
    } })
    const res = await saveCsv(o.id, adminToken)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('ACTIVE_PUSH')
    expect((await order(o.id)).supplierHandoffAt).toBeNull()
  })
})

describe('handoff permission', () => {
  it('admin or a fulfillment_export holder may hand off and undo; a designer may not', async () => {
    const o = await makeOrder()
    expect((await saveCsv(o.id, null)).status).toBe(401)
    const denied = await saveCsv(o.id, desToken)
    expect(denied.status).toBe(403)
    expect((await order(o.id)).supplierHandoffAt).toBeNull()
    expect((await saveCsv(o.id, exportToken, { mode: 'API' })).status).toBe(400)
    expect((await saveCsv(o.id, exportToken, {})).status).toBe(400)
    expect((await saveCsv(o.id, adminToken)).status).toBe(200)
    expect((await order(o.id)).supplierHandoffById).toBe(ADMIN.id)
    expect((await undo(o.id, null)).status).toBe(401)
    expect((await undo(o.id, desToken)).status).toBe(403)
    expect((await order(o.id)).supplierHandoffMode).toBe('CSV')
    expect((await undo(o.id, exportToken)).status).toBe(200)
    expect((await saveCsv('gid://test/Order/hof-missing', adminToken)).status).toBe(404)
  })

  it('the middleware rules match the routes', () => {
    const path = '/api/design-studio/orders/gid%3A%2F%2Ftest%2FOrder%2F1/handoff'
    expect(canCallApi('SUPPORT', ['design_tasks'], path, 'POST')).toBe('forbidden')
    expect(canCallApi('SUPPORT', ['design_tasks'], path, 'DELETE')).toBe('forbidden')
    expect(canCallApi('SUPPORT', ['design_tasks', 'fulfillment_export'], path, 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], path, 'DELETE')).toBe('ok')
    expect(canCallApi('ADMIN', [], path, 'POST')).toBe('ok')
    expect(canCallApi(null, [], path, 'POST')).toBe('unauthenticated')
    expect(canCallApi('SUPPORT', ['design_tasks'], '/api/design-studio/handoff', 'GET')).toBe('ok')

    const pg = '/api/fulfillment/pgprints/orders/gid%3A%2F%2Ftest%2FOrder%2F1'
    expect(canCallApi('SUPPORT', ['fulfillment_export'], `${pg}/push`, 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_orders'], `${pg}/push`, 'POST')).toBe('forbidden')
    expect(canCallApi('SUPPORT', ['design_tasks'], `${pg}/push`, 'POST')).toBe('forbidden')
    expect(canCallApi('ADMIN', [], `${pg}/push`, 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], `${pg}/cancel`, 'POST')).toBe('forbidden')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], `${pg}/refresh`, 'POST')).toBe('forbidden')
    expect(canCallApi('ADMIN', [], `${pg}/cancel`, 'POST')).toBe('ok')
    expect(canCallApi('ADMIN', [], `${pg}/preview`, 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], `${pg}/preview`, 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', ['design_tasks'], `${pg}/preview`, 'GET')).toBe('forbidden')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], '/api/fulfillment/pgprints/settings', 'PUT')).toBe('forbidden')
  })
})

describe('API handoff — supplier linked to PGprints', () => {
  it('the card offers the API only when the supplier is PGprints, credentials exist and every line has an API SKU', async () => {
    const ready = await makeOrder({ api: true })
    expect(await handoffStateFor(ready.id)).toMatchObject({ pending: true, mode: 'API', apiName: 'PGprints', apiNote: null })

    const noSku = await makeOrder({ api: true, supplierSku: 'NO-API' })
    const fallback = (await handoffStateFor(noSku.id))!
    expect(fallback).toMatchObject({ pending: true, mode: 'CSV', apiName: null })
    expect(fallback.apiNote).toContain('NO-API')

    await setSetting(PGPRINTS_KEYS.secretKey, null)
    const noCreds = (await handoffStateFor(ready.id))!
    expect(noCreds.mode).toBe('CSV')
    expect(noCreds.apiNote).toContain('Store ID')

    const csv = await makeOrder()
    expect(await handoffStateFor(csv.id)).toMatchObject({ mode: 'CSV', apiNote: null })
  })

  it('a successful push by an export holder marks the order exported and the handoff as API, in one go', async () => {
    const o = await makeOrder({ api: true })
    const before = await countPendingHandoff()
    const pre = await preview(o.id, exportToken)
    expect(pre).toMatchObject({ canPush: true, canSend: true, canAct: false })
    const res = await push(o.id, pre.payloadHash, exportToken)
    expect(res.status).toBe(200)
    expect((await res.json()).exported).toBe(true)
    expect(createCalls).toBe(1)

    const row = await prisma.supplierOrderPush.findFirstOrThrow({ where: { orderId: o.id } })
    const after = await order(o.id)
    expect(after).toMatchObject({ pipelineStatus: 'EXPORTED', exportedToSupplierId: PG_SUP, supplierHandoffMode: 'API', supplierHandoffById: EXPORTER.id })
    expect(after.supplierHandoffAt?.getTime()).toBe(row.pushedAt.getTime())
    expect(after.exportedAt?.getTime()).toBe(row.pushedAt.getTime())
    expect(row).toMatchObject({ status: 'CREATED', exportMarked: true, pushedById: EXPORTER.id })
    expect(JSON.parse(row.prevExportJson!)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', supplierHandoffAt: null })
    expect(await countPendingHandoff()).toBe(before - 1)
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: false, canUndo: false, handedOff: { mode: 'API', byName: 'Exporter' }, push: { status: 'CREATED', supplierOrderCode: `PG-${o.number.slice(1)}` } })

    const refused = await undo(o.id, adminToken)
    expect(refused.status).toBe(409)
    expect((await refused.json()).code).toBe('NOT_CSV')
  })

  it('a designer without the export permission cannot push; pushEnabled still gates everyone', async () => {
    const o = await makeOrder({ api: true })
    const pre = await preview(o.id, exportToken)
    expect((await push(o.id, pre.payloadHash, desToken)).status).toBe(403)
    expect((await push(o.id, pre.payloadHash, null)).status).toBe(401)
    await setSetting(PGPRINTS_KEYS.pushEnabled, 'false')
    const off = await push(o.id, pre.payloadHash, exportToken)
    expect(off.status).toBe(403)
    expect((await off.json()).code).toBe('PUSH_DISABLED')
    expect(createCalls).toBe(0)
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', supplierHandoffAt: null })
  })

  it('cancelling the push puts the order back in the queue; cancel stays admin-only', async () => {
    const o = await makeOrder({ api: true })
    const pre = await preview(o.id, adminToken)
    expect((await push(o.id, pre.payloadHash, adminToken)).status).toBe(200)
    const cancel = (token: string) => postCancel(req(`${pgBase(o.id)}/cancel`, token, json('POST', { confirm: true })), { params: { orderId: o.id } })
    expect((await cancel(exportToken)).status).toBe(403)
    const res = await cancel(adminToken)
    expect(res.status).toBe(200)
    expect((await res.json()).exportReverted).toBe(true)
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', exportedAt: null, supplierHandoffAt: null, supplierHandoffMode: null, supplierHandoffById: null })
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, handedOff: null, push: null })
  })

  it('a factory rejection after the push brings the re-approved order back to the queue, still showing the live push', async () => {
    const o = await makeOrder({ api: true })
    const pre = await preview(o.id, adminToken)
    expect((await push(o.id, pre.payloadHash, adminToken)).status).toBe(200)
    await prisma.order.update({ where: { id: o.id }, data: { pipelineStatus: 'DESIGN_REJECTED' } })
    expect((await syncDesignTasks(o.id)).reopened).toBe(1)
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: false, handedOff: { mode: 'API' } })
    await transitionTask(o.keys[0], DES, { to: 'REVIEW' })
    const r = await transitionTask(o.keys[0], DES, { to: 'DONE' })
    expect(r.order).toMatchObject({ designReady: true, pipelineStatus: 'READY_TO_PRODUCTION' })
    expect(await order(o.id)).toMatchObject({ supplierHandoffAt: null, supplierHandoffMode: null })
    // The redone design goes out again: the line marks of the earlier send are gone.
    expect(await prisma.orderLine.count({ where: { orderId: o.id, exportedAt: { not: null } } })).toBe(0)
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, handedOff: null, push: { status: 'CREATED' } })
    expect(createCalls).toBe(1)
  })

  it('a push over an order already saved for CSV restores that CSV handoff when cancelled', async () => {
    const o = await makeOrder({ api: true })
    await saveCsv(o.id, exportToken)
    const savedAt = (await order(o.id)).supplierHandoffAt!
    const pre = await preview(o.id, adminToken)
    expect((await push(o.id, pre.payloadHash, adminToken)).status).toBe(200)
    expect(await order(o.id)).toMatchObject({ supplierHandoffMode: 'API', supplierHandoffById: ADMIN.id })
    await postCancel(req(`${pgBase(o.id)}/cancel`, adminToken, json('POST', { confirm: true })), { params: { orderId: o.id } })
    const back = await order(o.id)
    expect(back).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', supplierHandoffMode: 'CSV', supplierHandoffById: EXPORTER.id })
    expect(back.supplierHandoffAt?.getTime()).toBe(savedAt.getTime())
  })
})
