import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { execFileSync } from 'child_process'
import path from 'path'
import { prisma } from '@/lib/db'
import { PGPRINTS_KEYS } from '@/lib/pgprints-settings'
import { bulkUpdateOrderStatus, markOrdersExported, upsertOrderWithLines } from '@/lib/repos/orders'
import { ordersWithComputedPL } from '@/lib/repos/reports'
import { markPushExported } from '@/lib/repos/push-export'
import { cancelPush } from '@/lib/repos/pgprints-push'
import { undoCsvHandoff } from '@/lib/supplier-handoff'
import { exportProgress, isLineExported } from '@/lib/line-export'
import { POST as postExport } from '@/app/api/fulfillment/export/route'
import { GET as getStatusCounts } from '@/app/api/fulfillment/status-counts/route'

const SHOP = 'lx.myshopify.com'
const PROJECT = 'proj_lx'
const MANGO = 'sup_lx_mango'
const JOMALL = 'sup_lx_jomall'
const SCRIPT = path.resolve(__dirname, '../scripts/backfill-line-export.mjs')
const PLACED = new Date('2026-10-05T10:00:00Z')
const COLUMNS = JSON.stringify([
  { header: 'Order', source: 'order.shopifyOrderNumber' },
  { header: 'Key', source: 'line.lineKey' },
  { header: 'SKU', source: 'line.supplierSku' },
])

let storeId = ''
let pgId = ''
let mangoTemplate = ''
let jomallTemplate = ''
let seq = 0

type LineSpec = { title: string; supplierId: string | null; supplierSku?: string | null; exportedAt?: Date; exportedTo?: string }

async function makeOrder(lines: LineSpec[], data: Record<string, unknown> = {}) {
  seq++
  const id = `gid://test/Order/lx-${seq}`
  const number = `#LX${4600 + seq}`
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 60, expectedPayout: 55, totalFees: 5, refundedAmount: 0, placedAt: PLACED,
      pipelineStatus: 'READY_TO_PRODUCTION', orderType: 'NON_CUSTOM', designReady: true, defaultSupplierId: MANGO,
      shippingName: 'Ann Lee', shippingAddress1: '1 Main St', shippingCity: 'Austin', shippingZip: '73301', shippingCountry: 'US', shippingState: 'Texas',
      ...data,
      lines: { create: lines.map((l, i) => ({
        shopifyLineId: `lx-${seq}-${i + 1}`, sku: `LX-${i + 1}`, productTitle: l.title, qty: 1, linePosition: i + 1, unitPrice: 20,
        resolvedSupplierId: l.supplierId, resolvedSupplierSku: l.supplierSku === undefined ? (l.supplierId ? `${l.title.toUpperCase().replace(/\s+/g, '-')}` : null) : l.supplierSku,
        exportedAt: l.exportedAt ?? null, exportedToSupplierId: l.exportedTo ?? null,
      })) },
    },
  })
  return { id, number, no: number.slice(1) }
}

/** The #LIT4628 shape: an add-on (wrongly mapped to the first supplier), a hoodie for Mangoshao, a jersey for Jomall. */
const mixedOrder = (data: Record<string, unknown> = {}) => makeOrder([
  { title: 'Shipping protection', supplierId: MANGO, supplierSku: 'SP' },
  { title: 'Hoodie', supplierId: MANGO, supplierSku: 'MG-HOODIE' },
  { title: 'Jersey', supplierId: JOMALL, supplierSku: 'JM-JERSEY' },
], data)

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const exportCsv = (templateId: string, body: Record<string, unknown>) =>
  postExport(new NextRequest('http://x/api/fulfillment/export', json({ templateId, dateFrom: '2026-10-01', dateTo: '2026-10-31', pipelineStatus: 'READY_TO_PRODUCTION', ...body })))
const previewOf = async (templateId: string, body: Record<string, unknown> = {}) => (await exportCsv(templateId, { preview: true, ...body })).json()
const lines = (orderId: string) => prisma.orderLine.findMany({ where: { orderId }, orderBy: { linePosition: 'asc' } })
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })
const counts = async () => (await getStatusCounts(new NextRequest(`http://x/api/fulfillment/status-counts?projectId=${PROJECT}`))).json()

function runBackfill(...args: string[]): string {
  if (!/test\.db/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing to run the backfill outside test.db')
  return execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }, encoding: 'utf8' })
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'LX', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'lx_mango' }, create: { id: MANGO, name: 'Mangoshao', code: 'lx_mango' }, update: {} })
  await prisma.supplier.upsert({ where: { code: 'lx_jomall' }, create: { id: JOMALL, name: 'Jomall', code: 'lx_jomall' }, update: {} })
  pgId = (await prisma.supplier.upsert({ where: { code: 'pgprints' }, create: { id: 'sup_lx_pg', name: 'Pgprints', code: 'pgprints' }, update: {} })).id
  mangoTemplate = (await prisma.csvTemplate.create({ data: { supplierId: MANGO, name: 'Mango', rowMode: 'PER_LINE', columns: COLUMNS } })).id
  jomallTemplate = (await prisma.csvTemplate.create({ data: { supplierId: JOMALL, name: 'Jomall', rowMode: 'PER_LINE', columns: COLUMNS } })).id
})

afterAll(async () => {
  await prisma.supplierOrderPush.deleteMany({ where: { order: { projectId: PROJECT } } })
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.csvTemplate.deleteMany({ where: { supplierId: { in: [MANGO, JOMALL] } } })
  await prisma.supplier.deleteMany({ where: { id: { in: [MANGO, JOMALL, 'sup_lx_pg'] } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(PGPRINTS_KEYS) } } })
})

afterEach(() => { vi.unstubAllGlobals() })

describe('#LIT4628: one order, two suppliers', () => {
  let o: Awaited<ReturnType<typeof mixedOrder>>

  it('the Mangoshao export holds only the hoodie and names both suppliers in the preview', async () => {
    o = await mixedOrder({ defaultSupplierId: null })
    const pre = await previewOf(mangoTemplate)
    const mine = pre.orders.find((x: any) => x.shopifyOrderNumber === o.number)
    expect(mine.lines).toEqual([expect.objectContaining({ linePosition: 2, included: true, alreadyExported: false })])
    expect(mine.mixedNote).toBe('Đơn có 2 xưởng: Mangoshao (dòng 2) · Jomall (dòng 3)')
    expect(pre.csv).toContain(`${o.no}_1,MG-HOODIE`)
    expect(pre.csv).not.toContain('JM-JERSEY')
    expect(pre.csv).not.toContain(',SP')
  })

  it('exporting Mangoshao marks line 2 only and the order stays exportable', async () => {
    const before = (await counts()).partiallyExported
    const res = await exportCsv(mangoTemplate, { markExported: true })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('MG-HOODIE')
    expect(res.headers.get('X-Export-Lines-Marked')).toBe('1')
    expect(res.headers.get('X-Export-Orders-Completed')).toBe('0')
    expect(res.headers.get('X-Export-Orders-Partial')).toBe('1')

    const [addOn, hoodie, jersey] = await lines(o.id)
    expect(addOn).toMatchObject({ exportedAt: null, exportedToSupplierId: null })
    expect(hoodie.exportedToSupplierId).toBe(MANGO)
    expect(hoodie.exportedAt).toBeInstanceOf(Date)
    expect(jersey).toMatchObject({ exportedAt: null, exportedToSupplierId: null })
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', exportedAt: null, exportedToSupplierId: null })

    const c = await counts()
    expect(c.partiallyExported).toBe(before + 1)
    expect(c.EXPORTED).toBe(0)
    expect(c.READY_TO_PRODUCTION).toBeGreaterThanOrEqual(1)
  })

  it('the orders list shows "Đã xuất 1/2 xưởng" with one chip per supplier', async () => {
    const [row] = await ordersWithComputedPL({ projectId: PROJECT, search: o.number })
    expect(row.exportProgress).toMatchObject({ partial: true, label: 'Đã xuất 1/2 xưởng' })
    expect(row.exportProgress.suppliers).toEqual([
      expect.objectContaining({ id: MANGO, name: 'Mangoshao', positions: [2], done: true }),
      expect.objectContaining({ id: JOMALL, name: 'Jomall', positions: [3], done: false }),
    ])
    const byPos = new Map(row.lines.map((l: any) => [l.linePosition, l.exportedSupplierName]))
    expect(byPos.get(2)).toBe('Mangoshao')
    expect(byPos.get(3)).toBeNull()
    expect(byPos.get(1)).toBeNull()
  })

  it('a second Mangoshao export leaves the order out; the Jomall export picks line 3', async () => {
    const mango = await previewOf(mangoTemplate)
    expect(mango.orders.some((x: any) => x.shopifyOrderNumber === o.number)).toBe(false)
    expect(mango.skippedExportedLines).toBeGreaterThanOrEqual(1)

    const jomall = await previewOf(jomallTemplate)
    const mine = jomall.orders.find((x: any) => x.shopifyOrderNumber === o.number)
    expect(mine.lines).toEqual([expect.objectContaining({ linePosition: 3, included: true })])
    expect(mine.exportProgress).toBe('Đã xuất 1/2 xưởng')
    expect(jomall.csv).toContain(`${o.no}_2,JM-JERSEY`)
  })

  it('exporting Jomall completes the order: EXPORTED, last supplier on the order', async () => {
    const res = await exportCsv(jomallTemplate, { markExported: true })
    expect(res.headers.get('X-Export-Orders-Completed')).toBe('1')
    const after = await order(o.id)
    expect(after).toMatchObject({ pipelineStatus: 'EXPORTED', exportedToSupplierId: JOMALL })
    const jersey = (await lines(o.id))[2]
    expect(jersey.exportedToSupplierId).toBe(JOMALL)
    expect(after.exportedAt!.getTime()).toBe(jersey.exportedAt!.getTime())
    const [row] = await ordersWithComputedPL({ projectId: PROJECT, search: o.number })
    expect(row.exportProgress).toMatchObject({ partial: false, label: null })
    expect((await counts()).partiallyExported).toBe(0)
  })

  it('"Xuất lại cả dòng đã xuất" sends exported lines again without moving their export date', async () => {
    const hoodieBefore = (await lines(o.id))[1]
    const plain = await previewOf(mangoTemplate, { pipelineStatus: 'EXPORTED' })
    expect(plain.orders.some((x: any) => x.shopifyOrderNumber === o.number)).toBe(false)

    const again = await previewOf(mangoTemplate, { pipelineStatus: 'EXPORTED', reExport: true })
    const mine = again.orders.find((x: any) => x.shopifyOrderNumber === o.number)
    expect(mine.lines).toEqual([expect.objectContaining({ linePosition: 2, included: true, alreadyExported: true })])
    expect(again.csv).toContain('MG-HOODIE')

    const res = await exportCsv(mangoTemplate, { pipelineStatus: 'EXPORTED', reExport: true, markExported: true })
    expect(await res.text()).toContain('MG-HOODIE')
    expect(res.headers.get('X-Export-Lines-Marked')).toBe('0')
    const hoodie = (await lines(o.id))[1]
    expect(hoodie.exportedAt!.getTime()).toBe(hoodieBefore.exportedAt!.getTime())
    expect((await order(o.id)).pipelineStatus).toBe('EXPORTED')
  })
})

describe('which lines count', () => {
  it('add-on lines never need a supplier export, even when mapped', async () => {
    const o = await makeOrder([
      { title: 'Package Protection', supplierId: MANGO, supplierSku: 'PP' },
      { title: 'Mug', supplierId: MANGO, supplierSku: 'MG-MUG' },
    ])
    const r = await markOrdersExported([o.id], MANGO)
    expect(r).toMatchObject({ count: 1, lines: 1, completed: [o.id] })
    const [addOn, mug] = await lines(o.id)
    expect(addOn.exportedAt).toBeNull()
    expect(mug.exportedToSupplierId).toBe(MANGO)
    expect((await order(o.id)).pipelineStatus).toBe('EXPORTED')
  })

  it('orders not ready for production are not touched', async () => {
    const o = await mixedOrder({ pipelineStatus: 'PENDING_DESIGN' })
    expect(await markOrdersExported([o.id], MANGO)).toMatchObject({ count: 0, lines: 0 })
    expect((await lines(o.id)).every(l => l.exportedAt === null)).toBe(true)
  })

  it('an order exported before line tracking counts its lines as sent, and a new mark keeps that', async () => {
    const t1 = new Date('2026-10-06T08:00:00Z')
    const o = await mixedOrder({ pipelineStatus: 'EXPORTED', exportedAt: t1, exportedToSupplierId: MANGO })
    const legacy = { pipelineStatus: 'EXPORTED', exportedAt: t1, exportedToSupplierId: MANGO, lines: await lines(o.id) }
    expect(legacy.lines.map(l => isLineExported(legacy, l))).toEqual([false, true, true])
    expect(exportProgress(legacy)).toMatchObject({ partial: false, suppliersDone: 2, suppliersTotal: 2 })
    expect((await previewOf(jomallTemplate, { pipelineStatus: 'EXPORTED' })).orders.some((x: any) => x.shopifyOrderNumber === o.number)).toBe(false)

    const res = await exportCsv(jomallTemplate, { pipelineStatus: 'EXPORTED', reExport: true, markExported: true })
    expect(await res.text()).toContain(o.no)
    const [, hoodie, jersey] = await lines(o.id)
    expect(hoodie).toMatchObject({ exportedToSupplierId: MANGO })
    expect(hoodie.exportedAt!.getTime()).toBe(t1.getTime())
    expect(jersey.exportedAt!.getTime()).toBe(t1.getTime())
    expect((await order(o.id)).pipelineStatus).toBe('EXPORTED')
  })
})

describe('hand-set status keeps the lines consistent', () => {
  it('EXPORTED marks every line sent; back to Ready reopens every supplier', async () => {
    const o = await mixedOrder()
    await bulkUpdateOrderStatus([o.id], 'EXPORTED')
    const marked = await lines(o.id)
    expect(marked.map(l => l.exportedToSupplierId)).toEqual([null, MANGO, JOMALL])
    await bulkUpdateOrderStatus([o.id], 'READY_TO_PRODUCTION')
    expect((await lines(o.id)).every(l => l.exportedAt === null && l.exportedToSupplierId === null)).toBe(true)
  })

  it('a partly exported Ready order moved to Ready again keeps its marks', async () => {
    const o = await mixedOrder()
    await markOrdersExported([o.id], MANGO)
    await bulkUpdateOrderStatus([o.id], 'READY_TO_PRODUCTION')
    expect((await lines(o.id))[1].exportedToSupplierId).toBe(MANGO)
  })
})

describe('re-sync keeps the line export fields', () => {
  it('lines recreated by the order sync keep exportedAt / exportedToSupplierId by shopifyLineId', async () => {
    const id = 'gid://test/Order/lx-resync'
    const input = (titles: string[]) => ({
      id, projectId: PROJECT, storeId, shopifyOrderNumber: '#LXRESYNC', customerEmail: null, customerName: null, shippingCountry: 'US', shippingState: null,
      financialStatus: 'PAID', fulfillmentStatus: null, currency: 'USD', grossAmount: 40, expectedPayout: 38, totalFees: 2, refundedAmount: 0,
      defaultSupplierId: null, placedAt: PLACED, pipelineStatus: 'READY_TO_PRODUCTION' as const,
      lines: titles.map((t, i) => ({
        shopifyLineId: `lxr-${t}`, sku: `R-${t}`, variantTitle: null, productTitle: t, qty: 1, linePosition: i + 1, unitPrice: 20,
        resolvedSupplierId: t === 'jersey' ? JOMALL : MANGO, resolvedSupplierSku: `S-${t}`, resolvedBaseCost: 5,
      })),
    })
    await upsertOrderWithLines(input(['hoodie', 'jersey']))
    await markOrdersExported([id], MANGO)
    const at = (await prisma.orderLine.findFirstOrThrow({ where: { orderId: id, shopifyLineId: 'lxr-hoodie' } })).exportedAt!

    await upsertOrderWithLines(input(['hoodie', 'jersey', 'cap']))
    const after = await prisma.orderLine.findMany({ where: { orderId: id } })
    const byLine = new Map(after.map(l => [l.shopifyLineId, l]))
    expect(byLine.get('lxr-hoodie')!.exportedAt!.getTime()).toBe(at.getTime())
    expect(byLine.get('lxr-hoodie')!.exportedToSupplierId).toBe(MANGO)
    expect(byLine.get('lxr-jersey')).toMatchObject({ exportedAt: null, exportedToSupplierId: null })
    expect(byLine.get('lxr-cap')).toMatchObject({ exportedAt: null, exportedToSupplierId: null })
  })
})

describe('PGprints push and the undo paths touch only their own lines', () => {
  async function pushRow(orderId: string, pushedAt: Date) {
    return prisma.supplierOrderPush.create({ data: {
      orderId, supplierId: pgId, externalOrderId: `lx-push-${orderId.split('-').pop()}`, activeKey: `${orderId}::${pgId}`,
      status: 'CREATED', requestJson: '{}', pushedAt,
    } })
  }

  it('a push marks the PGprints lines at the push time; cancel unmarks only those', async () => {
    const csvAt = new Date('2026-10-07T09:00:00Z')
    const o = await makeOrder([
      { title: 'Tumbler', supplierId: pgId, supplierSku: 'UT2-20OZ' },
      { title: 'Poster', supplierId: MANGO, supplierSku: 'MG-POSTER', exportedAt: csvAt, exportedTo: MANGO },
      { title: 'Tip', supplierId: null, supplierSku: null },
    ])
    const pushedAt = new Date('2026-10-08T09:00:00Z')
    const p = await pushRow(o.id, pushedAt)
    expect(await markPushExported({ id: p.id, orderId: o.id, supplierId: pgId, pushedAt, pushedById: null })).toBe(true)

    const [tumbler, poster, tip] = await lines(o.id)
    expect(tumbler.exportedToSupplierId).toBe(pgId)
    expect(tumbler.exportedAt!.getTime()).toBe(pushedAt.getTime())
    expect(poster.exportedAt!.getTime()).toBe(csvAt.getTime())
    expect(tip.exportedAt).toBeNull()
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'EXPORTED', exportedToSupplierId: pgId, supplierHandoffMode: 'API' })
    expect(JSON.parse((await prisma.supplierOrderPush.findUniqueOrThrow({ where: { id: p.id } })).prevExportJson!)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', linesMarked: 1 })

    await prisma.appSetting.upsert({ where: { key: PGPRINTS_KEYS.storeId }, create: { key: PGPRINTS_KEYS.storeId, value: 'lx-store-123456' }, update: { value: 'lx-store-123456' } })
    await prisma.appSetting.upsert({ where: { key: PGPRINTS_KEYS.secretKey }, create: { key: PGPRINTS_KEYS.secretKey, value: 'lx-secret-0123456789' }, update: { value: 'lx-secret-0123456789' } })
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      if (new URL(String(input)).origin !== 'https://app.pgprints.io') throw new Error('blocked')
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const r = await cancelPush(o.id)
    expect(r.exportReverted).toBe(true)
    const [t2, p2] = await lines(o.id)
    expect(t2).toMatchObject({ exportedAt: null, exportedToSupplierId: null })
    expect(p2.exportedToSupplierId).toBe(MANGO)
    expect(p2.exportedAt!.getTime()).toBe(csvAt.getTime())
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', exportedAt: null, supplierHandoffMode: null })
  })

  it('a push over an order with nothing of PGprints marks nothing', async () => {
    const o = await mixedOrder()
    const pushedAt = new Date('2026-10-09T09:00:00Z')
    const p = await pushRow(o.id, pushedAt)
    expect(await markPushExported({ id: p.id, orderId: o.id, supplierId: pgId, pushedAt })).toBe(false)
    expect((await lines(o.id)).every(l => l.exportedAt === null)).toBe(true)
    expect((await order(o.id)).pipelineStatus).toBe('READY_TO_PRODUCTION')
  })

  it('"Hoàn tác" of a CSV handoff on a partly exported order leaves the line marks alone', async () => {
    const o = await mixedOrder({ supplierHandoffAt: new Date(), supplierHandoffMode: 'CSV' })
    await markOrdersExported([o.id], MANGO)
    await undoCsvHandoff(o.id, null)
    expect(await order(o.id)).toMatchObject({ supplierHandoffAt: null, pipelineStatus: 'READY_TO_PRODUCTION' })
    expect((await lines(o.id))[1].exportedToSupplierId).toBe(MANGO)
  })
})

describe('scripts/backfill-line-export.mjs', () => {
  const T1 = new Date('2026-09-20T10:00:00Z')
  const T2 = new Date('2026-09-21T10:00:00Z')
  let a: { id: string; number: string; no: string }
  let b: { id: string; number: string; no: string }
  let c: { id: string; number: string; no: string }
  let d: { id: string; number: string; no: string }

  beforeAll(async () => {
    a = await mixedOrder({ pipelineStatus: 'EXPORTED', exportedAt: T1, exportedToSupplierId: MANGO })
    b = await mixedOrder({ pipelineStatus: 'FULFILLED', fulfillmentStatus: 'FULFILLED', exportedAt: T2, exportedToSupplierId: MANGO })
    c = await mixedOrder({ pipelineStatus: 'READY_TO_PRODUCTION', exportedAt: T2, exportedToSupplierId: MANGO })
    d = await makeOrder([
      { title: 'Hoodie', supplierId: MANGO, supplierSku: 'MG-HOODIE', exportedAt: T2, exportedTo: MANGO },
      { title: 'Jersey', supplierId: JOMALL, supplierSku: 'JM-JERSEY' },
    ], { pipelineStatus: 'EXPORTED', exportedAt: T2, exportedToSupplierId: MANGO })
  })

  it('dry run lists the marks and the lines to check, and writes nothing', async () => {
    const out = runBackfill()
    expect(out).toContain(`mark  ${a.number} dòng 2  Mangoshao`)
    expect(out).toContain(`mark  ${a.number} dòng 3  Jomall`)
    expect(out).toContain(`mark  ${b.number} dòng 2  Mangoshao`)
    expect(out).not.toContain(`mark  ${b.number} dòng 3`)
    expect(out).not.toContain(`mark  ${a.number} dòng 1`)
    expect(out).not.toContain(`mark  ${c.number}`)
    expect(out).not.toContain(`mark  ${d.number}`)
    expect(out).toContain('Cần kiểm tra')
    expect(out).toContain(`${a.number}  dòng 3  Jomall  (đơn xuất cho Mangoshao)  fulfillment unfulfilled`)
    expect(out).toContain('DRY-RUN')
    expect((await lines(a.id)).every(l => l.exportedAt === null)).toBe(true)
  })

  it('--apply writes the marks at the order export time, once', async () => {
    expect(runBackfill('--apply')).toContain('APPLIED')
    const [aAddOn, aHoodie, aJersey] = await lines(a.id)
    expect(aAddOn.exportedAt).toBeNull()
    expect(aHoodie).toMatchObject({ exportedToSupplierId: MANGO })
    expect(aHoodie.exportedAt!.getTime()).toBe(T1.getTime())
    expect(aJersey).toMatchObject({ exportedToSupplierId: JOMALL })
    expect(aJersey.exportedAt!.getTime()).toBe(T1.getTime())
    const [, bHoodie, bJersey] = await lines(b.id)
    expect(bHoodie.exportedAt!.getTime()).toBe(T2.getTime())
    expect(bJersey.exportedAt).toBeNull()
    expect((await lines(c.id)).every(l => l.exportedAt === null)).toBe(true)
    expect((await lines(d.id))[1].exportedAt).toBeNull()

    const again = runBackfill('--apply')
    expect(again).not.toContain(`mark  ${a.number}`)
    expect(again).not.toContain(`mark  ${b.number}`)
  })

  it('--reopen unmarks the other supplier of the named order and puts it back to Ready, idempotently', async () => {
    const dry = runBackfill('--reopen', `${a.no},LXNOPE`)
    expect(dry).toContain(`reopen ${a.number}: bỏ đánh dấu dòng 3 (Jomall) · EXPORTED -> READY_TO_PRODUCTION`)
    expect(dry).toContain('LXNOPE: không tìm thấy')
    expect((await order(a.id)).pipelineStatus).toBe('EXPORTED')

    expect(runBackfill('--apply', '--reopen', a.no)).toMatch(/1 đơn mở lại/)
    const [, hoodie, jersey] = await lines(a.id)
    expect(hoodie.exportedToSupplierId).toBe(MANGO)
    expect(jersey).toMatchObject({ exportedAt: null, exportedToSupplierId: null })
    expect(await order(a.id)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', exportedToSupplierId: MANGO })

    const twice = runBackfill('--apply', '--reopen', a.no)
    expect(twice).toContain(`${a.number}: không đổi`)
    expect(twice).toMatch(/0 đơn mở lại/)

    const jomall = await previewOf(jomallTemplate, { dateFrom: '2026-09-01' })
    expect(jomall.orders.find((x: any) => x.shopifyOrderNumber === a.number).lines).toEqual([expect.objectContaining({ linePosition: 3, included: true })])
    await exportCsv(jomallTemplate, { dateFrom: '2026-09-01', markExported: true })
    expect(await order(a.id)).toMatchObject({ pipelineStatus: 'EXPORTED', exportedToSupplierId: JOMALL })

    const late = runBackfill('--apply', '--reopen', a.no)
    expect(late).toContain(`${a.number}: không đổi`)
    expect((await order(a.id)).pipelineStatus).toBe('EXPORTED')
  })

  it('a file argument picks the database like DATABASE_URL', () => {
    const file = (process.env.DATABASE_URL ?? '').replace(/^file:/, '')
    const out = execFileSync(process.execPath, [SCRIPT, file], { env: { ...process.env, DATABASE_URL: '' }, encoding: 'utf8' })
    expect(out).toContain('DRY-RUN')
    expect(out).toMatch(/ordersWithExportedAt=\d+/)
  })
})
