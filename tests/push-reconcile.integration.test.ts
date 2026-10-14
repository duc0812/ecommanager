import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { execFileSync } from 'child_process'
import path from 'path'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { PGPRINTS_KEYS } from '@/lib/pgprints-settings'
import { listReviewCards, loadTask, syncDesignTasks, transitionTask, type Actor } from '@/lib/design-tasks'
import { reconcilePushedOrder } from '@/lib/repos/push-export'
import { countPendingHandoff, handoffStateFor, listHandoffCards } from '@/lib/supplier-handoff'
import { GET as getReview } from '@/app/api/design-studio/tasks/review/route'
import { GET as getPreview } from '@/app/api/fulfillment/pgprints/orders/[orderId]/preview/route'
import { POST as postPush } from '@/app/api/fulfillment/pgprints/orders/[orderId]/push/route'
import { POST as postCancel } from '@/app/api/fulfillment/pgprints/orders/[orderId]/cancel/route'

const SHOP = 'rec.myshopify.com'
const PROJECT = 'proj_rec'
const PG_SUP = 'sup_rec_pg'
const SCRIPT = path.resolve(__dirname, '../scripts/reconcile-pushed-orders.mjs')
const PRINT = JSON.stringify([{ print_area: 'Main', url: 'https://cdn.example/rec.png' }])
const PUSHED_AT = new Date('2026-10-08T03:04:05.000Z')

let storeId = ''
let seq = 0
let DES: Actor
let adminToken = ''
let desToken = ''
let calls: string[] = []

type MakeOpts = { lines?: number; pushStatus?: 'CREATED' | 'SENDING' | 'FAILED' | 'CANCELLED' | null; exportMarked?: boolean; pipelineStatus?: string; approved?: boolean }

async function makeOrder(opts: MakeOpts = {}) {
  seq++
  const id = `gid://test/Order/rec-${seq}`
  const number = `#REC${seq}`
  const count = opts.lines ?? 1
  const approved = opts.approved === true
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 30, expectedPayout: 28, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-05T10:00:00Z'),
      pipelineStatus: opts.pipelineStatus ?? 'PENDING_DESIGN', orderType: 'CUSTOM', defaultSupplierId: PG_SUP, designReady: approved,
      customerEmail: 'mary@example.com', customerName: 'Mary Watson', shippingName: 'Mary Watson', shippingAddress1: '12 Main St',
      shippingCity: 'Denver', shippingZip: '80202', shippingPhone: '+1 303 555 0100', shippingCountry: 'US', shippingState: 'Colorado',
      lines: { create: Array.from({ length: count }, (_, i) => ({
        shopifyLineId: `rec-${seq}-${i + 1}`, sku: 'REC-TUMBLER', productTitle: 'Custom Tumbler', variantTitle: '20oz', qty: 1, linePosition: i + 1, unitPrice: 15,
        resolvedSupplierId: PG_SUP, resolvedSupplierSku: 'UT2-20OZ', customized: true, previewCdnUrl: 'https://cdn.example.com/preview.png',
        designDriveLink: approved ? '/api/design-studio/file/seeded' : null,
        customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Ann' }, { key: '_print_files', value: PRINT }]),
      })) },
    },
  })
  const keys = Array.from({ length: count }, (_, i) => `REC${seq}_${i + 1}`)
  if (!approved) {
    for (let i = 1; i <= count; i++) {
      await prisma.designArtwork.create({
        data: { orderId: id, shopifyLineId: `rec-${seq}-${i}`, printArea: 'Main', version: 1, fileName: 'main.png', storagePath: `x/rec-${seq}-${i}.png`, size: 10, mimeType: 'image/png', widthPx: 100, heightPx: 100 },
      })
    }
    await syncDesignTasks(id)
    await prisma.designTask.updateMany({ where: { orderId: id }, data: { status: 'REVIEW' } })
  }
  let pushId: string | null = null
  if (opts.pushStatus !== null) {
    const status = opts.pushStatus ?? 'CREATED'
    const live = status === 'CREATED' || status === 'SENDING'
    pushId = (await prisma.supplierOrderPush.create({ data: {
      orderId: id, supplierId: PG_SUP, externalOrderId: number.slice(1), activeKey: live ? `${id}::${PG_SUP}` : null, status,
      supplierOrderCode: status === 'CREATED' ? `PG-${number.slice(1)}` : null, requestJson: '{"line_items":[]}', pushedAt: PUSHED_AT, pushedById: null,
      exportMarked: opts.exportMarked ?? false,
    } })).id
  }
  return { id, number, keys, pushId }
}

function req(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const pgBase = (id: string) => `http://x/api/fulfillment/pgprints/orders/${encodeURIComponent(id)}`
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })
const pushRow = (id: string) => prisma.supplierOrderPush.findUniqueOrThrow({ where: { id } })
const createCalls = () => calls.filter(p => p.includes('/orders/create')).length

function runScript(...args: string[]): string {
  if (!/test\.db/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing to run the reconcile script outside test.db')
  return execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }, encoding: 'utf8' })
}

async function setSetting(key: string, value: string) {
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'REC', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'pgprints' }, create: { id: PG_SUP, name: 'Pgprints', code: 'pgprints' }, update: {} })
  await prisma.supplierProduct.create({ data: { supplierId: PG_SUP, sku: 'UT2-20OZ', baseCost: 8, apiSku: 'UT2-One_size' } })
  const adminPerms = DEFAULT_ROLE_PERMISSIONS.ADMIN
  const adminId = (await prisma.appUser.upsert({ where: { email: 'admin@rec.test' }, create: { name: 'Admin', email: 'admin@rec.test', role: 'ADMIN', permissions: JSON.stringify(adminPerms) }, update: {} })).id
  const desId = (await prisma.appUser.upsert({ where: { email: 'des@rec.test' }, create: { name: 'Des', email: 'des@rec.test', role: 'SUPPORT', permissions: JSON.stringify(['design_tasks']) }, update: {} })).id
  DES = { id: desId, name: 'Des', role: 'SUPPORT', permissions: ['design_tasks'] }
  adminToken = await signToken({ userId: adminId, email: 'admin@rec.test', name: 'Admin', role: 'ADMIN', permissions: adminPerms, tv: 0 })
  desToken = await signToken({ userId: desId, email: 'des@rec.test', name: 'Des', role: 'SUPPORT', permissions: ['design_tasks'], tv: 0 })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: PG_SUP } })
  await prisma.supplier.deleteMany({ where: { id: PG_SUP } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['admin@rec.test', 'des@rec.test'] } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: [...Object.values(PGPRINTS_KEYS), 'design.settings'] } } })
  delete process.env.NEXT_PUBLIC_APP_URL
})

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://tool.shop-example.com'
  await setSetting(PGPRINTS_KEYS.storeId, 'rec-store-id-123456')
  await setSetting(PGPRINTS_KEYS.secretKey, 'rec-secret-key-0123456789')
  await setSetting(PGPRINTS_KEYS.defaultShipClass, 'US Economy')
  await setSetting(PGPRINTS_KEYS.pushEnabled, 'true')
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://app.pgprints.io') throw new Error(`test blocked a call to ${url.origin}`)
    calls.push(url.pathname)
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('order pushed to PGprints before its design was approved in the app', () => {
  it('review cards carry a "Đã gửi PGprints <code>" chip while the push is live', async () => {
    const pushed = await makeOrder()
    const plain = await makeOrder({ pushStatus: null })
    const failed = await makeOrder({ pushStatus: 'FAILED' })
    const cards = await listReviewCards()
    expect(cards.find(c => c.task.taskKey === pushed.keys[0])?.push).toEqual({ status: 'CREATED', supplierOrderCode: `PG-${pushed.number.slice(1)}`, externalOrderId: pushed.number.slice(1) })
    expect(cards.find(c => c.task.taskKey === plain.keys[0])?.push).toBeNull()
    expect(cards.find(c => c.task.taskKey === failed.keys[0])?.push).toBeNull()
    const body = await (await getReview(req('http://x/api/design-studio/tasks/review?q=REC', desToken))).json()
    expect(body.cards.find((c: any) => c.task.taskKey === pushed.keys[0]).push.supplierOrderCode).toBe(`PG-${pushed.number.slice(1)}`)
    expect(body.me).toMatchObject({ canApprove: true, canHandoff: false })
  })

  it('approving the last line marks the order exported once, as an API handoff, without calling PGprints', async () => {
    const o = await makeOrder({ lines: 2 })
    const pending = await countPendingHandoff()

    const first = await transitionTask(o.keys[0], DES, { to: 'DONE' })
    expect(first.order).toMatchObject({ designReady: false, pipelineStatus: 'PENDING_DESIGN' })
    expect((await pushRow(o.pushId!)).exportMarked).toBe(false)

    const last = await transitionTask(o.keys[1], DES, { to: 'DONE' })
    expect(last.order).toMatchObject({ designReady: true, pipelineStatus: 'EXPORTED' })

    const after = await order(o.id)
    expect(after).toMatchObject({ pipelineStatus: 'EXPORTED', exportedToSupplierId: PG_SUP, supplierHandoffMode: 'API', supplierHandoffById: null })
    expect(after.exportedAt?.getTime()).toBe(PUSHED_AT.getTime())
    expect(after.supplierHandoffAt?.getTime()).toBe(PUSHED_AT.getTime())
    const push = await pushRow(o.pushId!)
    expect(push).toMatchObject({ status: 'CREATED', exportMarked: true })
    expect(JSON.parse(push.prevExportJson!)).toEqual({
      pipelineStatus: 'READY_TO_PRODUCTION', exportedAt: null, exportedToSupplierId: null,
      supplierHandoffAt: null, supplierHandoffMode: null, supplierHandoffById: null, linesMarked: expect.any(Number),
    })
    const pgLines = await prisma.orderLine.findMany({ where: { orderId: o.id, resolvedSupplierId: PG_SUP } })
    expect(pgLines.length).toBeGreaterThan(0)
    expect(pgLines.every(l => l.exportedToSupplierId === PG_SUP && l.exportedAt?.getTime() === PUSHED_AT.getTime())).toBe(true)
    expect(createCalls()).toBe(0)
    expect(await countPendingHandoff()).toBe(pending)
    expect((await listHandoffCards()).pending.some(c => c.order.id === o.id)).toBe(false)
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: false, handedOff: { mode: 'API', byName: null }, push: { status: 'CREATED' } })
    const events = (await loadTask(o.keys[1]))!.events.map(e => e.message)
    expect(events.filter(m => m === `Đơn đã gửi PGprints từ trước (mã PG-${o.number.slice(1)}) — đánh dấu Exported, không gửi lại`)).toHaveLength(1)
    expect(events.at(-1)).toBe('Duyệt design (designer)')
  })

  it('a later push attempt is refused as a duplicate and never reaches PGprints', async () => {
    const o = await makeOrder()
    await transitionTask(o.keys[0], DES, { to: 'DONE' })
    const pre = await (await getPreview(req(`${pgBase(o.id)}/preview`, adminToken), { params: { orderId: o.id } })).json()
    expect(pre.canPush).toBe(false)
    expect(pre.activePush).toMatchObject({ status: 'CREATED', supplierOrderCode: `PG-${o.number.slice(1)}` })
    const res = await postPush(req(`${pgBase(o.id)}/push`, adminToken, post({ confirm: true, payloadHash: pre.payloadHash ?? 'x' })), { params: { orderId: o.id } })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('DUPLICATE')
    expect(createCalls()).toBe(0)
    expect(await prisma.supplierOrderPush.count({ where: { orderId: o.id } })).toBe(1)
    expect(await reconcilePushedOrder(o.id)).toBe(false)
    expect((await order(o.id)).exportedAt?.getTime()).toBe(PUSHED_AT.getTime())
  })

  it('cancelling the reconciled push hands the order back to the queue', async () => {
    const o = await makeOrder()
    await transitionTask(o.keys[0], DES, { to: 'DONE' })
    const res = await postCancel(req(`${pgBase(o.id)}/cancel`, adminToken, post({ confirm: true })), { params: { orderId: o.id } })
    expect(res.status).toBe(200)
    expect((await res.json()).exportReverted).toBe(true)
    expect(await order(o.id)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', exportedAt: null, supplierHandoffAt: null, supplierHandoffMode: null })
    expect(await handoffStateFor(o.id)).toMatchObject({ pending: true, push: null })
  })

  it('a push whose result is unknown (SENDING) is not reconciled; the card warns instead', async () => {
    const o = await makeOrder({ pushStatus: 'SENDING' })
    const r = await transitionTask(o.keys[0], DES, { to: 'DONE' })
    expect(r.order).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION' })
    expect(await order(o.id)).toMatchObject({ exportedAt: null, supplierHandoffAt: null })
    const card = (await listHandoffCards()).pending.find(c => c.order.id === o.id)!
    expect(card.state).toMatchObject({ pending: true, mode: 'API', push: { status: 'SENDING', externalOrderId: o.number.slice(1) } })
  })

  it('an order without a push, or with a cancelled one, just becomes ready', async () => {
    const plain = await makeOrder({ pushStatus: null })
    const cancelled = await makeOrder({ pushStatus: 'CANCELLED' })
    for (const o of [plain, cancelled]) {
      const r = await transitionTask(o.keys[0], DES, { to: 'DONE' })
      expect(r.order).toMatchObject({ designReady: true, pipelineStatus: 'READY_TO_PRODUCTION' })
      expect(await order(o.id)).toMatchObject({ exportedAt: null, supplierHandoffAt: null })
    }
  })
})

describe('scripts/reconcile-pushed-orders.mjs', () => {
  it('dry run lists the orders and writes nothing; --apply marks them once and is idempotent', async () => {
    await prisma.supplierOrderPush.deleteMany({ where: { order: { projectId: PROJECT } } })
    const ready = await makeOrder({ approved: true, pipelineStatus: 'READY_TO_PRODUCTION' })
    const unknown = await makeOrder({ approved: true, pipelineStatus: 'READY_TO_PRODUCTION', pushStatus: 'SENDING' })
    const notReady = await makeOrder({ pushStatus: 'CREATED' })
    const noPush = await makeOrder({ approved: true, pipelineStatus: 'READY_TO_PRODUCTION', pushStatus: null })
    const marked = await makeOrder({ approved: true, pipelineStatus: 'EXPORTED', exportMarked: true })

    const dry = runScript()
    expect(dry).toContain('DRY-RUN')
    expect(dry).toContain(`-> EXPORTED  ${ready.number}  PGprints PG-${ready.number.slice(1)}`)
    expect(dry).toContain(`skip ${unknown.number}`)
    expect(dry).not.toContain(notReady.number)
    expect(dry).not.toContain(noPush.number)
    expect(dry).not.toContain(marked.number)
    expect(dry).toMatch(/toMark=1 unknownResult=1/)
    expect(await order(ready.id)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', exportedAt: null, supplierHandoffAt: null })
    expect((await pushRow(ready.pushId!)).exportMarked).toBe(false)

    const applied = runScript('--apply')
    expect(applied).toContain('APPLIED (1 marked EXPORTED)')
    const after = await order(ready.id)
    expect(after).toMatchObject({ pipelineStatus: 'EXPORTED', exportedToSupplierId: PG_SUP, supplierHandoffMode: 'API', supplierHandoffById: null })
    expect(after.exportedAt?.getTime()).toBe(PUSHED_AT.getTime())
    expect(after.supplierHandoffAt?.getTime()).toBe(PUSHED_AT.getTime())
    const push = await pushRow(ready.pushId!)
    expect(push.exportMarked).toBe(true)
    expect(JSON.parse(push.prevExportJson!)).toEqual({
      pipelineStatus: 'READY_TO_PRODUCTION', exportedAt: null, exportedToSupplierId: null,
      supplierHandoffAt: null, supplierHandoffMode: null, supplierHandoffById: null, linesMarked: expect.any(Number),
    })
    const scriptLines = await prisma.orderLine.findMany({ where: { orderId: ready.id, resolvedSupplierId: PG_SUP } })
    expect(scriptLines.length).toBeGreaterThan(0)
    expect(scriptLines.every(l => l.exportedToSupplierId === PG_SUP && l.exportedAt?.getTime() === PUSHED_AT.getTime())).toBe(true)
    expect(await order(unknown.id)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', supplierHandoffAt: null })
    expect(await order(notReady.id)).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', supplierHandoffAt: null })
    expect(await order(noPush.id)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', supplierHandoffAt: null })
    expect(await handoffStateFor(ready.id)).toMatchObject({ pending: false, handedOff: { mode: 'API' } })

    const again = runScript('--apply')
    expect(again).toMatch(/toMark=0/)
    expect(again).toContain('APPLIED (0 marked EXPORTED)')
    expect(createCalls()).toBe(0)

    const res = await postCancel(req(`${pgBase(ready.id)}/cancel`, adminToken, post({ confirm: true })), { params: { orderId: ready.id } })
    expect((await res.json()).exportReverted).toBe(true)
    expect(await order(ready.id)).toMatchObject({ pipelineStatus: 'READY_TO_PRODUCTION', exportedAt: null, supplierHandoffAt: null })
  })
})
