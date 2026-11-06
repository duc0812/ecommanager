import { setCsvLocked } from '@/lib/csv-lock'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { LITZZY_SHOP } from '@/lib/shopify-shop'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { canCallApi } from '@/lib/api-access'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { PGPRINTS_KEYS } from '@/lib/pgprints-settings'
import { syncDesignTasks, transitionTask, type Actor } from '@/lib/design-tasks'
import { countPendingHandoff, handoffStateFor, listHandoffCards, listSentCards, listHandoffHub } from '@/lib/supplier-handoff'
import { UNMAPPED_TAB } from '@/lib/handoff-shared'
import { hubView } from '@/lib/handoff-hub'
import { nextExternalOrderId } from '@/lib/repos/push-export'
import { GET as getTasks } from '@/app/api/design-studio/tasks/route'
import { GET as getTask } from '@/app/api/design-studio/tasks/[key]/route'
import { GET as getHandoff } from '@/app/api/design-studio/handoff/route'
import { GET as getOrderHandoff, POST as postHandoff, DELETE as deleteHandoff, PATCH as patchHandoff } from '@/app/api/design-studio/orders/[id]/handoff/route'
import { GET as getPreview } from '@/app/api/fulfillment/pgprints/orders/[orderId]/preview/route'
import { POST as postPush } from '@/app/api/fulfillment/pgprints/orders/[orderId]/push/route'
import { POST as postCancel } from '@/app/api/fulfillment/pgprints/orders/[orderId]/cancel/route'
import { POST as postExport } from '@/app/api/fulfillment/export/route'

// The first store uses the global PGprints key, so these fixtures are Litzzy's.
const SHOP = LITZZY_SHOP
const PROJECT = 'proj_hof'
const CSV_SUP = 'sup_hof_csv'
const PG_SUP = 'sup_hof_pg'
const MANGO_SUP = 'sup_hof_mango'
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
  await setCsvLocked(false)
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'HOF', startDate: new Date('2026-06-01') }, update: {} })
  // A previous run that was interrupted may have left orders on this shared store row; they would block the upsert or the cleanup.
  await prisma.order.deleteMany({ where: { store: { shop: LITZZY_SHOP } } })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'hof_csv' }, create: { id: CSV_SUP, name: 'CSV Factory', code: 'hof_csv' }, update: {} })
  await prisma.supplier.upsert({ where: { code: 'pgprints' }, create: { id: PG_SUP, name: 'Pgprints', code: 'pgprints' }, update: {} })
  await prisma.supplierProduct.create({ data: { supplierId: PG_SUP, sku: 'UT2-20OZ', baseCost: 8, apiSku: 'UT2-One_size' } })
  await prisma.supplierProduct.create({ data: { supplierId: PG_SUP, sku: 'NO-API', baseCost: 8 } })
  await prisma.supplierProduct.create({ data: { supplierId: CSV_SUP, sku: 'CSV-TUMBLER', baseCost: 6 } })
  await prisma.supplier.upsert({ where: { code: 'hof_mango' }, create: { id: MANGO_SUP, name: 'Mango Factory', code: 'hof_mango' }, update: {} })
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
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.csvTemplate.deleteMany({ where: { supplierId: CSV_SUP } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: { in: [CSV_SUP, PG_SUP] } } })
  await prisma.supplier.deleteMany({ where: { id: { in: [CSV_SUP, PG_SUP, MANGO_SUP] } } })
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
  it('an order enters the queue with its first approved line, and leaves design only with the last', async () => {
    const before = await countPendingHandoff()
    const o = await makeOrder({ lines: 2, approve: false })
    expect(await countPendingHandoff()).toBe(before)
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: false, blocked: 'Còn 2 dòng chưa duyệt design', handedOff: null })

    await transitionTask(o.keys[0], DES, { to: 'DONE' })
    expect(await countPendingHandoff()).toBe(before + 1)
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, blocked: null })
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', designReady: false })

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
    const sent = await listSentCards()
    expect(sent.sent.find(c => c.order.id === o.id)?.sent).toMatchObject({ stage: 'CSV_WAITING', via: 'CSV', byName: 'Exporter', code: null })
    expect(sent.sent.find(c => c.order.id === o.id)?.state.handedOff).toMatchObject({ mode: 'CSV', byName: 'Exporter' })

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

describe('Duyệt sản xuất checks', () => {
  const PRODUCT = 'gid://shopify/Product/hof-remap'
  afterEach(async () => { await prisma.productProfile.deleteMany({ where: { storeId, shopifyProductId: PRODUCT } }) })

  async function mappedToPgprints() {
    const o = await makeOrder()
    await prisma.orderLine.updateMany({ where: { orderId: o.id }, data: { shopifyProductId: PRODUCT } })
    const ut2 = await prisma.supplierProduct.findFirstOrThrow({ where: { supplierId: PG_SUP, sku: 'UT2-20OZ' } })
    await prisma.productProfile.create({ data: { storeId, shopifyProductId: PRODUCT, title: 'Custom Tumbler', supplierProductId: ut2.id } })
    return o
  }
  const remap = (id: string, token: string | null, body: unknown = { action: 'REMAP' }) => patchHandoff(req(handoffUrl(id), token, json('PATCH', body)), { params: { id } })

  it('flags a line whose supplier predates today\'s mapping, and "Cập nhật xưởng" moves it', async () => {
    const o = await mappedToPgprints()
    const card = (await listHandoffCards()).pending.find(c => c.order.id === o.id)!
    expect(card.lines[0]).toMatchObject({ mappingNow: { supplierName: 'Pgprints', sku: 'UT2-20OZ' }, wrongSizeAreas: [] })

    expect((await remap(o.id, desToken)).status).toBe(403)
    const res = await remap(o.id, exportToken)
    expect(res.status).toBe(200)
    expect((await res.json()).changed).toEqual([`${o.keys[0]}: CSV-TUMBLER → UT2-20OZ`])
    expect(await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })).toMatchObject({ resolvedSupplierId: PG_SUP, resolvedSupplierSku: 'UT2-20OZ' })
    expect((await listHandoffCards()).pending.find(c => c.order.id === o.id)?.lines[0].mappingNow).toBeNull()
    const events = await prisma.designTaskEvent.findMany({ where: { task: { orderId: o.id }, type: 'HANDOFF' } })
    expect(events.map(e => e.message)).toEqual([`Cập nhật xưởng theo mapping hiện tại — ${o.keys[0]}: CSV-TUMBLER → UT2-20OZ`])
  })

  it('never re-maps an order already handed to a supplier', async () => {
    const o = await mappedToPgprints()
    await saveCsv(o.id, exportToken)
    const res = await remap(o.id, adminToken)
    expect(res.status).toBe(409)
    expect(await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })).toMatchObject({ resolvedSupplierId: CSV_SUP })
  })
})

describe('Duyệt sản xuất on a one-sheet template with an alternative piece set', () => {
  const SKU = 'HOF-SHEET'
  const PARTS = ['FRONT', 'BACK']
  afterEach(async () => {
    await prisma.supplierProduct.deleteMany({ where: { supplierId: CSV_SUP, sku: SKU } })
    await prisma.printTemplate.deleteMany({ where: { supplierId: CSV_SUP, supplierSku: SKU } })
  })

  async function sheetTemplate() {
    const t = await prisma.printTemplate.create({ data: {
      supplierId: CSV_SUP, supplierSku: SKU, name: 'One sheet', widthPx: 1000, heightPx: 1000, dpi: 200,
      areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 1000, h: 1000 }]),
      altAreas: JSON.stringify([{ label: 'Pieces', widthPx: 2000, heightPx: 1000, areas: [{ name: 'FRONT', x: 0, y: 0, w: 1000, h: 1000 }, { name: 'BACK', x: 1000, y: 0, w: 1000, h: 1000 }] }]),
    } })
    await prisma.supplierProduct.create({ data: { supplierId: CSV_SUP, sku: SKU, productName: 'Sheet product', baseCost: 5, printTemplateId: t.id } })
  }

  async function lineWith(parts: string[]) {
    const o = await makeOrder({ supplierSku: SKU, approve: false })
    const shopifyLineId = `hof-${seq}-1`
    await prisma.designArtwork.updateMany({ where: { orderId: o.id, shopifyLineId }, data: { removedAt: new Date() } })
    for (const printArea of parts) {
      await prisma.designArtwork.create({ data: { orderId: o.id, shopifyLineId, printArea, version: 1, fileName: `${printArea}.png`, storagePath: `x/${seq}-${printArea}.png`, size: 10, mimeType: 'image/png', widthPx: 100, heightPx: 100 } })
    }
    await transitionTask(o.keys[0], DES, { to: 'DONE' })
    return o
  }

  it('a line with the whole piece set is not asked for the sheet', async () => {
    await sheetTemplate()
    const o = await lineWith(PARTS)
    const card = (await listHandoffCards()).pending.find(c => c.order.id === o.id)
    expect(card?.lines[0].slots).toEqual(PARTS)
  })

  it('a line with the sheet still expects the sheet', async () => {
    await sheetTemplate()
    const o = await lineWith(['Print'])
    const card = (await listHandoffCards()).pending.find(c => c.order.id === o.id)
    expect(card?.lines[0].slots).toEqual(['Print'])
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

    const listed = await (await getHandoff(req(`http://x/api/design-studio/handoff?view=sent&q=${encodeURIComponent(o.number)}`, desToken))).json()
    expect(listed.sent.map((c: any) => c.order.id)).toEqual([o.id])
    const sent = listed.sent[0].sent
    expect(sent).toMatchObject({ stage: 'API_COOLING', via: 'API', code: `PG-${o.number.slice(1)}`, byName: 'Exporter', tracking: [] })
    expect(new Date(sent.cancelUntil).getTime() - row.pushedAt.getTime()).toBe(2 * 3600 * 1000)
    expect((await listHandoffCards()).pending.some(c => c.order.id === o.id)).toBe(false)
  })

  it('past the cancel window the card says the factory has it, and a tracking number moves it on', async () => {
    const o = await makeOrder({ api: true })
    const pre = await preview(o.id, exportToken)
    expect((await push(o.id, pre.payloadHash, exportToken)).status).toBe(200)
    await prisma.supplierOrderPush.updateMany({ where: { orderId: o.id }, data: { pushedAt: new Date(Date.now() - 3 * 3600 * 1000) } })
    const stageOf = async () => (await listSentCards({ q: o.number })).sent.find(c => c.order.id === o.id)?.sent
    expect(await stageOf()).toMatchObject({ stage: 'API_SENT', cancelUntil: null })
    await prisma.shipment.create({ data: { orderId: o.id, projectId: PROJECT, lineKey: `${o.number.slice(1)}_1`, trackingNumber: 'YT123', carrier: 'YunExpress' } })
    expect(await stageOf()).toMatchObject({ stage: 'TRACKING', tracking: [{ number: 'YT123', carrier: 'YunExpress', url: null }] })
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

describe('sent list paging', () => {
  it('pages the orders and counts them all', async () => {
    const a = await makeOrder()
    const b = await makeOrder()
    for (const o of [a, b]) {
      await prisma.order.update({ where: { id: o.id }, data: { supplierHandoffAt: new Date(), supplierHandoffMode: 'CSV', supplierHandoffById: null } })
    }
    const q = 'HOF'
    const first = await listSentCards({ q, page: 1, pageSize: 1 })
    const second = await listSentCards({ q, page: 2, pageSize: 1 })
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toHaveLength(1)
    expect(first.sent[0].order.id).not.toBe(second.sent[0].order.id)
    expect(first.matched).toBeGreaterThanOrEqual(2)
    expect(first.matched).toBe(second.matched)
  })

  it('caps the page size', async () => {
    expect((await listSentCards({ q: 'HOF', pageSize: 100000 })).sent.length).toBeLessThanOrEqual(100)
  })
})

describe('hub tabs by supplier', () => {
  const twoSuppliers = async () => {
    const o = await makeOrder({ lines: 2 })
    const [first, second] = await prisma.orderLine.findMany({ where: { orderId: o.id }, orderBy: { linePosition: 'asc' } })
    await prisma.orderLine.update({ where: { id: first.id }, data: { resolvedBaseCost: 6, qty: 2 } })
    await prisma.orderLine.update({ where: { id: second.id }, data: { resolvedSupplierId: PG_SUP, resolvedSupplierSku: 'UT2-20OZ', resolvedBaseCost: 8 } })
    return { ...o, first, second }
  }

  it('lists a mixed order under each supplier, each with its own cost', async () => {
    const o = await twoSuppliers()
    const hub = await listHandoffHub({ q: o.number, supplier: PG_SUP })
    expect(hub.tabs.find(t => t.id === CSV_SUP)).toMatchObject({ name: 'CSV Factory', channel: 'CSV', orderCount: 1, baseCostTotal: 12 })
    expect(hub.tabs.find(t => t.id === PG_SUP)).toMatchObject({ orderCount: 1, baseCostTotal: 8 })
    expect(hub.selected).toBe(PG_SUP)
    expect(hub.pending.map(c => c.order.id)).toEqual([o.id])
    expect(hub.pending[0].lines.find(l => l.line.supplier?.id === CSV_SUP)).toMatchObject({ baseCost: 12 })
  })

  it('drops a supplier once its lines are sent', async () => {
    const o = await twoSuppliers()
    await prisma.orderLine.update({ where: { id: o.first.id }, data: { exportedAt: new Date(), exportedToSupplierId: CSV_SUP } })
    const hub = await listHandoffHub({ q: o.number })
    expect(hub.tabs.map(t => t.id)).toEqual([PG_SUP])
  })

  it('moves to the tab that holds a searched order', async () => {
    const o = await makeOrder({ api: true })
    const hub = await listHandoffHub({ q: o.keys[0], supplier: CSV_SUP })
    expect(hub.selected).toBe(PG_SUP)
    expect(hub.pending.map(c => c.order.id)).toEqual([o.id])
  })

  it('shows a line with no supplier under the unmapped tab', async () => {
    const o = await makeOrder()
    await prisma.orderLine.updateMany({ where: { orderId: o.id }, data: { resolvedSupplierId: null, resolvedSupplierSku: null } })
    const hub = await listHandoffHub({ q: o.number, supplier: UNMAPPED_TAB })
    expect(hub.tabs).toEqual([expect.objectContaining({ id: UNMAPPED_TAB, channel: null, orderCount: 1, baseCostTotal: 0 })])
    expect(hub.pending[0].lines[0].line.supplier).toBeNull()
    expect(hub.pending[0].lines[0].taskKey).toBe(o.keys[0])
  })

  it('keeps a tab for an active supplier with nothing waiting, and counts what is in design', async () => {
    const o = await makeOrder({ api: true, approve: false })
    await prisma.order.update({ where: { id: o.id }, data: { pipelineStatus: 'PENDING_DESIGN', placedAt: new Date() } })
    const hub = await listHandoffHub({ supplier: PG_SUP })
    const tab = hub.tabs.find(t => t.id === PG_SUP)!
    expect(tab.designCount).toBeGreaterThanOrEqual(1)
    expect(hub.selected).toBe(PG_SUP)
    expect((await listHandoffHub({ q: 'NO-SUCH-ORDER-XYZ', supplier: PG_SUP })).tabs).toEqual([])
    await prisma.order.update({ where: { id: o.id }, data: { placedAt: new Date('2026-01-01T00:00:00Z') } })
    expect((await listHandoffHub({ supplier: PG_SUP })).tabs.find(t => t.id === PG_SUP)?.designCount ?? 0).toBe(tab.designCount - 1)
  })

  it('stays on a chosen tab that is empty', async () => {
    const o = await makeOrder({ approve: false })
    await prisma.order.update({ where: { id: o.id }, data: { placedAt: new Date() } })
    const hub = await listHandoffHub({ supplier: CSV_SUP })
    expect(hub.selected).toBe(CSV_SUP)
  })

  it('lists an order waiting for mapping under the unmapped tab only', async () => {
    const o = await makeOrder({ lines: 2 })
    const [first] = await prisma.orderLine.findMany({ where: { orderId: o.id }, orderBy: { linePosition: 'asc' } })
    await prisma.orderLine.update({ where: { id: first.id }, data: { resolvedSupplierId: null, resolvedSupplierSku: null } })
    await prisma.order.update({ where: { id: o.id }, data: { pipelineStatus: 'PENDING_MAPPING' } })
    const hub = await listHandoffHub({ q: o.number })
    expect(hub.tabs.map(t => t.id)).toEqual([UNMAPPED_TAB])
    expect(hub.pending.map(c => c.order.id)).toEqual([o.id])
  })

  it('answers with no tabs when nothing matches', async () => {
    expect(await listHandoffHub({ q: 'NO-SUCH-ORDER-XYZ' })).toEqual({ tabs: [], selected: null, pending: [] })
  })
})

describe('task screen checks', () => {
  it('gives the order card to a signed-in user, and nobody else', async () => {
    const o = await makeOrder()
    const url = handoffUrl(o.id)
    expect((await getOrderHandoff(req(url, null), { params: { id: o.id } })).status).toBe(401)
    const body = await (await getOrderHandoff(req(url, desToken), { params: { id: o.id } })).json()
    expect(body.card.order.id).toBe(o.id)
    expect(body.card.lines[0]).toMatchObject({ taskKey: o.keys[0], wrongSizeAreas: [] })
  })
})

describe('lines go to their supplier one by one', () => {
  const linesOf = (id: string) => prisma.orderLine.findMany({ where: { orderId: id }, orderBy: { linePosition: 'asc' } })

  /** The #LIT6102 shape: _1 at Mango still in design, _2 at the CSV supplier approved, and a Tip line with no SKU. */
  const lit6102 = async () => {
    const o = await makeOrder({ lines: 2, approve: false })
    const [first, second] = await linesOf(o.id)
    await prisma.orderLine.update({ where: { id: first.id }, data: { resolvedSupplierId: MANGO_SUP, resolvedSupplierSku: 'BJ-M', resolvedBaseCost: 20, previewCdnUrl: null } })
    await prisma.orderLine.update({ where: { id: second.id }, data: { resolvedBaseCost: 6 } })
    await prisma.orderLine.create({ data: { orderId: o.id, shopifyLineId: `${second.shopifyLineId}-tip`, sku: null, productTitle: 'Tip', qty: 1, linePosition: 3, unitPrice: 2 } })
    await prisma.designTask.update({ where: { taskKey: o.keys[0] }, data: { status: 'NEW' } })
    await transitionTask(o.keys[1], DES, { to: 'DONE' })
    return { ...o, first, second }
  }

  it('#LIT6102: the approved line is in its supplier\'s tab, the open one stays in design and warns nobody', async () => {
    const o = await lit6102()
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', designReady: false })
    const hub = await listHandoffHub({ q: o.number, supplier: CSV_SUP })
    expect(hub.tabs.map(t => t.id)).toEqual([CSV_SUP])
    expect(hub.tabs[0]).toMatchObject({ orderCount: 1, baseCostTotal: 6 })
    const card = hub.pending.find(c => c.order.id === o.id)!
    const view = hubView(card, CSV_SUP)
    expect(view.lines.map(l => l.taskKey)).toEqual([o.keys[1]])
    expect(view.inDesign.map(l => l.taskKey)).toEqual([o.keys[0]])
    expect(view.warnings).toEqual([])
    expect(view.baseCost).toBe(6)
    expect(card.state).toMatchObject({ pending: true, blocked: null, readyLineIds: [o.second.id], sentLineIds: [], mode: 'CSV' })
    expect((await listHandoffHub({ supplier: MANGO_SUP })).pending.some(c => c.order.id === o.id)).toBe(false)
  })

  it('a CSV save does not wait for the open line, and the line approved later comes back on its own', async () => {
    const o = await lit6102()
    expect((await saveCsv(o.id, exportToken)).status).toBe(200)
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', supplierHandoffMode: 'CSV' })
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: false, handedOff: { mode: 'CSV' } })
    expect((await listHandoffHub({ q: o.number })).tabs).toEqual([])

    await prisma.designTask.update({ where: { taskKey: o.keys[0] }, data: { status: 'REVIEW' } })
    const r = await transitionTask(o.keys[0], DES, { to: 'DONE' })
    expect(r.order).toMatchObject({ designReady: true, pipelineStatus: 'READY_TO_PRODUCTION' })
    expect((await order(o.id)).supplierHandoffMode).toBe('CSV')
    const hub = await listHandoffHub({ q: o.number })
    expect(hub.tabs.map(t => t.id)).toEqual([MANGO_SUP])
    expect(hubView(hub.pending[0], MANGO_SUP).lines.map(l => l.taskKey)).toEqual([o.keys[0]])
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, readyLineIds: [o.first.id], handedOff: { mode: 'CSV' } })

    // The second save covers it too.
    expect((await saveCsv(o.id, exportToken)).status).toBe(200)
    expect((await listHandoffHub({ q: o.number })).tabs).toEqual([])
    expect((await saveCsv(o.id, exportToken)).status).toBe(409)
  })

  it('the CSV export takes the approved line only, and the order leaves design only with the last line', async () => {
    const o = await makeOrder({ lines: 2, approve: false })
    await transitionTask(o.keys[1], DES, { to: 'DONE' })
    const pre = await (await exportCsv({ preview: true })).json()
    const row = pre.orders.find((x: any) => x.shopifyOrderNumber === o.number)
    expect(row.lines.map((l: any) => ({ key: l.lineKey, included: l.included, inDesign: l.inDesign }))).toEqual([
      { key: o.keys[0], included: false, inDesign: true }, { key: o.keys[1], included: true, inDesign: false },
    ])
    expect(pre.skippedNotReadyLines).toBeGreaterThanOrEqual(1)

    await exportCsv({ markExported: true })
    const [open, sent] = await linesOf(o.id)
    expect(open.exportedAt).toBeNull()
    expect(sent.exportedToSupplierId).toBe(CSV_SUP)
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', exportedAt: null, supplierHandoffAt: null })
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: false, blocked: 'Còn 1 dòng chưa duyệt design', sentLineIds: [sent.id] })
    expect((await listHandoffHub({ q: o.number })).tabs).toEqual([])

    const r = await transitionTask(o.keys[0], DES, { to: 'DONE' })
    expect(r.order).toMatchObject({ designReady: true, pipelineStatus: 'READY_TO_PRODUCTION' })
    expect((await listHandoffHub({ q: o.number })).tabs[0]).toMatchObject({ id: CSV_SUP, orderCount: 1 })
    expect(hubView((await listHandoffHub({ q: o.number })).pending[0], CSV_SUP).lines.map(l => l.taskKey)).toEqual([o.keys[0]])

    await exportCsv({ markExported: true })
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'EXPORTED', exportedToSupplierId: CSV_SUP })
  })

  it('reopening a line already sent asks why, reopens it on its own, and once re-approved it keeps its mark: the supplier is told to re-check', async () => {
    const o = await makeOrder({ lines: 2 })
    const [, sent] = await linesOf(o.id)
    await markSent(sent.id)
    const before = await order(o.id)
    await expect(transitionTask(o.keys[1], DES, { to: 'DOING' })).rejects.toThrow(/Chọn lý do/)
    const r = await transitionTask(o.keys[1], DES, { to: 'DOING', reasons: ['Khách yêu cầu sửa'], note: 'đổi tên Emily' })
    expect(r.task).toMatchObject({ status: 'REJECTED', rejectReasons: ['Khách yêu cầu sửa'], rejectNote: 'đổi tên Emily' })
    expect(await order(o.id)).toMatchObject({ pipelineStatus: before.pipelineStatus, designReady: before.designReady })
    await transitionTask(o.keys[1], DES, { to: 'REVIEW' })
    // Approved again with the same print file: the link the supplier got still leads to it.
    expect((await transitionTask(o.keys[1], DES, { to: 'DONE' })).notice).toMatch(/^Báo .+ xem lại folder design — link cũ vẫn đúng$/)
    const [, after] = await linesOf(o.id)
    expect(after.exportedAt).not.toBeNull()
    expect((await handoffStateFor(o.id))!.readyLineIds).not.toContain(sent.id)
  })

  it('reopening any line throws a saved handoff away, so a saved line is handed over again', async () => {
    const o = await makeOrder({ lines: 2 })
    await saveCsv(o.id, exportToken)
    await transitionTask(o.keys[0], DES, { to: 'DOING' })
    expect((await order(o.id)).supplierHandoffAt).toBeNull()
    const [, other] = await linesOf(o.id)
    expect((await handoffStateFor(o.id))!.readyLineIds).toEqual([other.id])
  })

  it('keeps a rejected, a closed and an unmapped order out of the supplier tabs', async () => {
    for (const data of [{ pipelineStatus: 'DESIGN_REJECTED' }, { pipelineStatus: 'PENDING_MAPPING' }, { financialStatus: 'REFUNDED' }, { financialStatus: 'voided' }, { fulfillmentStatus: 'FULFILLED' }, { pipelineStatus: 'CANCELLED' }]) {
      const o = await lit6102()
      await prisma.order.update({ where: { id: o.id }, data })
      expect((await listHandoffHub({ q: o.number, supplier: CSV_SUP })).pending.some(c => c.order.id === o.id)).toBe(false)
      expect((await handoffStateFor(o.id))!.pending).toBe(false)
    }
  })

  it('a push the app never marked keeps its lines out of the hub, so nobody sends them twice', async () => {
    const before = await countPendingHandoff()
    const o = await makeOrder({ api: true, lines: 2, approve: false })
    await prisma.supplierOrderPush.create({ data: {
      orderId: o.id, supplierId: PG_SUP, externalOrderId: o.number.slice(1), activeKey: `${o.id}::${PG_SUP}`, status: 'CREATED', requestJson: '{}',
    } })
    await transitionTask(o.keys[0], DES, { to: 'DONE' })
    expect(await countPendingHandoff()).toBe(before)
    const pre = await preview(o.id, adminToken)
    expect(pre.laterSend).toBe(false)
    expect(pre.issues.map((i: any) => i.code)).toContain('ACTIVE_PUSH')
    expect((await push(o.id, pre.payloadHash ?? 'x', adminToken)).status).toBe(409)
    expect(createCalls).toBe(0)
  })

  it('PGprints: one line goes now, the later one under its own number beside the live push', async () => {
    const o = await makeOrder({ api: true, lines: 2, approve: false })
    await transitionTask(o.keys[0], DES, { to: 'DONE' })
    const [first, second] = await linesOf(o.id)
    const pre = await preview(o.id, adminToken)
    expect(pre.lines.map((l: any) => l.refId)).toEqual([o.keys[0]])
    expect(pre.payload.line_items).toHaveLength(1)
    expect(pre.payload.order_id).toBe(o.number.slice(1))
    expect(pre.issues.find((i: any) => i.code === 'DESIGN_OPEN')).toMatchObject({ level: 'warning' })
    expect(pre.issues.some((i: any) => i.code === 'NOT_APPROVED')).toBe(false)
    expect(pre.canPush).toBe(true)
    expect((await push(o.id, pre.payloadHash, adminToken)).status).toBe(200)
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', exportedAt: null, supplierHandoffAt: null })
    const marked = await linesOf(o.id)
    expect(marked[0].exportedToSupplierId).toBe(PG_SUP)
    expect(marked[1].exportedAt).toBeNull()
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: false, push: { status: 'CREATED' }, sentLineIds: [first.id] })

    // Nothing new is approved yet: the window shows the push and offers no send.
    const waiting = await preview(o.id, adminToken)
    expect(waiting).toMatchObject({ canPush: false, laterSend: false, activePush: { status: 'CREATED' } })

    const r = await transitionTask(o.keys[1], DES, { to: 'DONE' })
    expect(r.order).toMatchObject({ designReady: true, pipelineStatus: 'READY_TO_PRODUCTION' })
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, pushBeside: true, readyLineIds: [second.id], mode: 'API' })
    const later = await preview(o.id, adminToken)
    expect(later).toMatchObject({ laterSend: true, canPush: true, activePush: { externalOrderId: o.number.slice(1) } })
    expect(later.lines.map((l: any) => l.refId)).toEqual([o.keys[1]])
    expect(later.payload.order_id).toBe(`${o.number.slice(1)}-R2`)
    expect((await push(o.id, later.payloadHash, adminToken)).status).toBe(200)
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'EXPORTED', supplierHandoffMode: 'API' })
    expect(createCalls).toBe(2)
    const pushes = await prisma.supplierOrderPush.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' } })
    expect(pushes.map(p => [p.externalOrderId, p.status, p.exportMarked])).toEqual([[o.number.slice(1), 'CREATED', true], [`${o.number.slice(1)}-R2`, 'CREATED', true]])

    // Everything sent: a third send has nothing to carry.
    const done = await preview(o.id, adminToken)
    expect(done).toMatchObject({ canPush: false, laterSend: false })
    expect((await push(o.id, later.payloadHash, adminToken)).status).toBe(409)

    // A cancel takes the newest send back and keeps the earlier one.
    await postCancel(req(`${pgBase(o.id)}/cancel`, adminToken, json('POST', { confirm: true })), { params: { orderId: o.id } })
    expect((await order(o.id)).pipelineStatus).toBe('READY_TO_PRODUCTION')
    const back = await linesOf(o.id)
    expect(back[0].exportedAt).not.toBeNull()
    expect(back[1].exportedAt).toBeNull()
    expect((await preview(o.id, adminToken)).payload.order_id).toBe(`${o.number.slice(1)}-R3`)
  })

  it('an order going to two API factories gets one number each', async () => {
    const o = await makeOrder({ api: true })
    const no = o.number.slice(1)
    await prisma.supplierOrderPush.create({ data: { orderId: o.id, supplierId: CSV_SUP, externalOrderId: no, status: 'CREATED', requestJson: '{}' } })
    expect(await nextExternalOrderId(no, { orderId: o.id, supplierId: PG_SUP, later: false })).toBe(`${no}-R2`)
    expect(await nextExternalOrderId(no, { orderId: o.id, supplierId: CSV_SUP, later: false })).toBe(no)
    expect(await nextExternalOrderId(no, { orderId: o.id, supplierId: CSV_SUP, later: true })).toBe(`${no}-R2`)
  })

  const markSent = (id: string) => prisma.orderLine.update({ where: { id }, data: { exportedAt: new Date(), exportedToSupplierId: CSV_SUP } })
})
