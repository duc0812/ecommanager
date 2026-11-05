import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'

const mocks = vi.hoisted(() => ({
  normalize: vi.fn(),
  syncStoreOrders: vi.fn(),
  fetchVariantSkus: vi.fn(),
  fetchOrderLinePropsByNames: vi.fn(),
  updateVariantSku: vi.fn(),
  recalculate: vi.fn(),
}))

vi.mock('@/lib/order-normalize', () => ({ normalizeOpenOrderStatuses: mocks.normalize }))
vi.mock('@/lib/shopify-order-sync', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/shopify-order-sync')>()),
  syncStoreOrders: mocks.syncStoreOrders,
}))
vi.mock('@/lib/shopify-orders', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/shopify-orders')>()),
  fetchVariantSkus: mocks.fetchVariantSkus,
  fetchOrderLinePropsByNames: mocks.fetchOrderLinePropsByNames,
  updateVariantSku: mocks.updateVariantSku,
}))
// The real run re-prices (and can re-status) every order it is given, so the unfiltered admin run would reach the rows of other suites.
vi.mock('@/lib/repos/order-costs', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/repos/order-costs')>()),
  recalculateMissingOrderLineCosts: mocks.recalculate,
}))

import { prisma } from '@/lib/db'
import { ordersScopeFixture, call, type Who } from './helpers/orders-scope-fixture'
import { countPendingHandoff } from '@/lib/supplier-handoff'
import { GET as listOrders } from '@/app/api/fulfillment/orders/route'
import { PATCH as orderStatus } from '@/app/api/fulfillment/orders/[id]/status/route'
import { POST as recheck } from '@/app/api/fulfillment/orders/[id]/recheck/route'
import { POST as bulkStatus } from '@/app/api/fulfillment/orders/bulk-status/route'
import { PATCH as lineCost } from '@/app/api/fulfillment/orders/line-cost/route'
import { POST as recalculateCosts } from '@/app/api/fulfillment/orders/recalculate-costs/route'
import { GET as plSummary } from '@/app/api/fulfillment/pl-summary/route'
import { GET as statusCounts } from '@/app/api/fulfillment/status-counts/route'
import { GET as taskFix } from '@/app/api/fulfillment/task-fix/route'
import { POST as taskFixFix } from '@/app/api/fulfillment/task-fix/fix/route'
import { POST as normalize } from '@/app/api/fulfillment/normalize/route'
import { GET as diagnose } from '@/app/api/fulfillment/design-diagnose/route'
import { GET as shopifyOrders } from '@/app/api/shopify/orders/route'
import { POST as ordersSync } from '@/app/api/shopify/orders/sync/route'
import { GET as dsTasks } from '@/app/api/design-studio/tasks/route'
import { GET as dsReview } from '@/app/api/design-studio/tasks/review/route'
import { GET as dsSyncGet, POST as dsSyncPost } from '@/app/api/design-studio/tasks/sync/route'
import { GET as dsTask, PATCH as dsTaskNote } from '@/app/api/design-studio/tasks/[key]/route'
import { POST as dsTransition } from '@/app/api/design-studio/tasks/[key]/transition/route'
import { POST as dsEvent } from '@/app/api/design-studio/tasks/[key]/events/route'
import { PATCH as dsParts } from '@/app/api/design-studio/tasks/[key]/parts/route'
import { GET as dsAutoRenderGet, POST as dsAutoRender } from '@/app/api/design-studio/tasks/[key]/auto-render/route'
import { POST as dsRelease } from '@/app/api/design-studio/tasks/[key]/release-library/route'
import { PUT as dsTaskArtwork } from '@/app/api/design-studio/tasks/[key]/artwork/route'
import { PATCH as dsLine } from '@/app/api/design-studio/lines/[lineId]/route'
import { POST as dsLineArtwork } from '@/app/api/design-studio/lines/[lineId]/artwork/route'
import { GET as dsOrders } from '@/app/api/design-studio/orders/route'
import { GET as dsOrder } from '@/app/api/design-studio/orders/[id]/route'
import { POST as dsRefresh } from '@/app/api/design-studio/orders/[id]/refresh/route'
import { GET as dsHandoff, POST as dsHandoffPost } from '@/app/api/design-studio/orders/[id]/handoff/route'
import { GET as dsFile } from '@/app/api/design-studio/file/[artworkId]/route'
import { DELETE as dsArtworkDelete } from '@/app/api/design-studio/artwork/[artworkId]/route'
import { PUT as dsArtworkPreview } from '@/app/api/design-studio/artwork/[artworkId]/preview/route'
import { POST as dsArtworkPush } from '@/app/api/design-studio/artwork/[artworkId]/push/route'

const fx = ordersScopeFixture('soc')
const SA = fx.storeId('a')
const SB = fx.storeId('b')
const LEAK_MARKERS = ['Beta', 'SOCB', fx.shop('b'), SB, fx.projectId('b')]
const leaks = (body: unknown) => LEAK_MARKERS.filter(m => JSON.stringify(body).includes(m))
const syncResult = { totalSynced: 1, withUnmappedSku: 0, errors: [] as string[], projectId: 'p', projectName: 'P', fromOrderName: null, skippedBeforeFromOrder: 0 }
const normalized = { ordersOpen: 1, since: null, fulfillmentUpdated: 0, pipelineFulfilled: 0, errors: [] as string[] }

const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort()
const mine = (s: 'a' | 'b') => fx.orders.map(n => fx.orderId(s, n)).sort()
const params = <T extends Record<string, string>>(p: T) => ({ params: p })

async function counts(who: Who, query = '') {
  const [cnt, pl] = await Promise.all([
    call(await statusCounts(fx.request(`/api/fulfillment/status-counts${query}`, who))),
    call(await plSummary(fx.request(`/api/fulfillment/pl-summary${query}`, who))),
  ])
  return { cnt, pl }
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = fx.root
  await fx.seed()
})

afterAll(async () => {
  await fx.cleanup()
  fs.rmSync(fx.root, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

beforeEach(() => {
  mocks.normalize.mockReset().mockResolvedValue(normalized)
  mocks.syncStoreOrders.mockReset().mockResolvedValue(syncResult)
  mocks.fetchVariantSkus.mockReset().mockResolvedValue(new Map())
  mocks.fetchOrderLinePropsByNames.mockReset().mockResolvedValue(new Map())
  mocks.updateVariantSku.mockReset().mockResolvedValue(undefined)
  mocks.recalculate.mockReset().mockResolvedValue({ checked: 0 })
})

describe('order list, status counts and P&L', () => {
  it('a seller gets only the orders of its store, each with the store name, and the counts and P&L match', async () => {
    const list = await call(await listOrders(fx.request('/api/fulfillment/orders?pageSize=200', 'sellerA')))
    expect(list.status).toBe(200)
    expect(ids(list.body.orders)).toEqual(mine('a'))
    expect(list.body.total).toBe(4)
    expect(new Set(list.body.orders.map((o: any) => o.storeName))).toEqual(new Set([fx.projectName('a')]))
    expect(leaks(list.body)).toEqual([])

    const { cnt, pl } = await counts('sellerA')
    expect(cnt.status).toBe(200)
    expect(cnt.body).toMatchObject({ PENDING_DESIGN: 1, READY_TO_PRODUCTION: 2, EXPORTED: 1, PENDING_MAPPING: 0, FULFILLED: 0, CANCELLED: 0, partiallyExported: 0 })
    expect(cnt.body.warnings).toMatchObject({ LATE_FULFILLMENT: 4, STUCK_DESIGN: 1, NOT_EXPORTED: 2 })
    expect(pl.body).toMatchObject({ orderCount: 4, revenue: 1000 })

    const other = await counts('sellerB')
    expect(other.cnt.body).toMatchObject({ PENDING_DESIGN: 1, READY_TO_PRODUCTION: 2, EXPORTED: 1 })
    expect(other.pl.body).toMatchObject({ orderCount: 4, revenue: 10000 })
  })

  it('a seller cannot widen the answer by naming another store, its project, or an order of it', async () => {
    for (const route of [listOrders, plSummary, statusCounts]) {
      const path = route === listOrders ? 'orders' : route === plSummary ? 'pl-summary' : 'status-counts'
      const res = await route(fx.request(`/api/fulfillment/${path}?storeId=${SB}`, 'sellerA'))
      expect(res.status).toBe(403)
    }
    const byProject = await call(await listOrders(fx.request(`/api/fulfillment/orders?projectId=${fx.projectId('b')}`, 'sellerA')))
    expect(byProject.body).toMatchObject({ orders: [], total: 0 })
    const bySearch = await call(await listOrders(fx.request('/api/fulfillment/orders?search=SOCB1', 'sellerA')))
    expect(bySearch.body.total).toBe(0)
    const { cnt, pl } = await counts('sellerA', `?projectId=${fx.projectId('b')}`)
    expect(Object.values(cnt.body).filter(v => typeof v === 'number').reduce((a: number, b) => a + (b as number), 0)).toBe(0)
    expect(pl.body.orderCount).toBe(0)
  })

  it('a seller with no store gets nothing, never everything', async () => {
    const list = await call(await listOrders(fx.request('/api/fulfillment/orders?pageSize=200', 'sellerNone')))
    expect(list.body).toMatchObject({ orders: [], total: 0 })
    const { cnt, pl } = await counts('sellerNone')
    expect(cnt.body).toMatchObject({ PENDING_DESIGN: 0, READY_TO_PRODUCTION: 0, EXPORTED: 0 })
    expect(pl.body.orderCount).toBe(0)
  })

  it('a seller of both stores sees both, and may narrow to one', async () => {
    const both = await call(await listOrders(fx.request('/api/fulfillment/orders?search=SOC&pageSize=200', 'sellerAB')))
    expect(ids(both.body.orders)).toEqual([...mine('a'), ...mine('b')].sort())
    const narrowed = await call(await listOrders(fx.request(`/api/fulfillment/orders?search=SOC&pageSize=200&storeId=${SB}`, 'sellerAB')))
    expect(ids(narrowed.body.orders)).toEqual(mine('b'))
  })

  it('admin and support keep one list over both stores, each row with its store name, and may narrow to one', async () => {
    for (const who of ['admin', 'support', 'super'] as const) {
      const all = await call(await listOrders(fx.request('/api/fulfillment/orders?search=SOC&pageSize=200', who)))
      expect(all.status).toBe(200)
      expect(ids(all.body.orders)).toEqual([...mine('a'), ...mine('b')].sort())
      const names = Object.fromEntries(all.body.orders.map((o: any) => [o.id, o.storeName]))
      expect(names[fx.orderId('a', 1)]).toBe(fx.projectName('a'))
      expect(names[fx.orderId('b', 1)]).toBe(fx.projectName('b'))
    }
    const narrowed = await call(await listOrders(fx.request(`/api/fulfillment/orders?pageSize=200&storeId=${SB}`, 'admin')))
    expect(ids(narrowed.body.orders)).toEqual(mine('b'))
    const adminCounts = await counts('admin', `?storeId=${SA}`)
    const sellerCounts = await counts('sellerA')
    expect(adminCounts.cnt.body).toEqual(sellerCounts.cnt.body)
    expect(adminCounts.pl.body).toEqual(sellerCounts.pl.body)
  })

  it('answers 401 without a session', async () => {
    for (const [route, path] of [[listOrders, 'orders'], [plSummary, 'pl-summary'], [statusCounts, 'status-counts'], [taskFix, 'task-fix']] as const) {
      expect((await route(fx.request(`/api/fulfillment/${path}`, null))).status).toBe(401)
    }
  })

  it('the raw order list of Shopify follows the same scope', async () => {
    const admin = await call(await shopifyOrders(fx.request(`/api/shopify/orders?limit=500&projectId=${fx.projectId('b')}`, 'admin')))
    expect(admin.body.orders.length).toBe(4)
    const narrowed = await call(await shopifyOrders(fx.request(`/api/shopify/orders?limit=500&storeId=${SA}&projectId=${fx.projectId('b')}`, 'admin')))
    expect(narrowed.body.orders).toEqual([])
    expect((await shopifyOrders(fx.request('/api/shopify/orders', 'sellerA'))).status).toBe(403)
  })
})

describe('writes on orders and lines', () => {
  const state = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id }, select: { pipelineStatus: true } })).pipelineStatus
  const restore = (id: string, status: string) => prisma.order.update({ where: { id }, data: { pipelineStatus: status } })

  it('a status change on an order of another store is refused and changes nothing', async () => {
    const id = fx.orderId('b', 3)
    const res = await orderStatus(fx.request(`/api/fulfillment/orders/${id}/status`, 'sellerA', { method: 'PATCH', body: { status: 'ON_HOLD' } }), params({ id }))
    expect(res.status).toBe(404)
    expect(await state(id)).toBe('EXPORTED')
  })

  it('a status change on an order of its own store goes through', async () => {
    const id = fx.orderId('a', 3)
    const res = await orderStatus(fx.request(`/api/fulfillment/orders/${id}/status`, 'sellerA', { method: 'PATCH', body: { status: 'ON_HOLD' } }), params({ id }))
    expect(res.status).toBe(200)
    expect(await state(id)).toBe('ON_HOLD')
    await restore(id, 'EXPORTED')
  })

  it('a bulk status change with one id of another store, or an unknown id, refuses all of it', async () => {
    const own = fx.orderId('a', 3)
    const body = (orderIds: string[]) => ({ method: 'POST', body: { orderIds, status: 'ON_HOLD' } })
    for (const orderIds of [[own, fx.orderId('b', 3)], [own, 'soc-order-nope'], [fx.orderId('b', 3)]]) {
      const res = await bulkStatus(fx.request('/api/fulfillment/orders/bulk-status', 'sellerA', body(orderIds)))
      expect(res.status).toBe(404)
    }
    expect(await state(own)).toBe('EXPORTED')
    expect(await state(fx.orderId('b', 3))).toBe('EXPORTED')

    const ok = await call(await bulkStatus(fx.request('/api/fulfillment/orders/bulk-status', 'sellerA', body([own]))))
    expect(ok.status).toBe(200)
    expect(ok.body.count).toBe(1)
    await restore(own, 'EXPORTED')
  })

  it('a bulk status change needs a list of strings, for everyone, and changes nothing without one', async () => {
    const own = fx.orderId('a', 3)
    for (const who of ['sellerA', 'admin'] as const) {
      for (const orderIds of [[own, 7], [own, null], [own, { id: fx.orderId('b', 3) }], own]) {
        const res = await call(await bulkStatus(fx.request('/api/fulfillment/orders/bulk-status', who, { method: 'POST', body: { orderIds, status: 'ON_HOLD' } })))
        expect(res).toEqual({ status: 400, body: { error: 'orderIds[] and status required' } })
      }
    }
    expect(await state(own)).toBe('EXPORTED')
  })

  it('admin keeps changing orders of both stores in one bulk request', async () => {
    const both = [fx.orderId('a', 3), fx.orderId('b', 3)]
    const res = await call(await bulkStatus(fx.request('/api/fulfillment/orders/bulk-status', 'admin', { method: 'POST', body: { orderIds: both, status: 'ON_HOLD' } })))
    expect(res.body.count).toBe(2)
    for (const id of both) await restore(id, 'EXPORTED')
  })

  it('a re-check of an order of another store is refused before Shopify is asked', async () => {
    const other = fx.orderId('b', 1)
    expect((await recheck(fx.request(`/api/fulfillment/orders/${other}/recheck`, 'sellerA', { method: 'POST' }), params({ id: other }))).status).toBe(404)
    const own = fx.orderId('a', 1)
    expect((await recheck(fx.request(`/api/fulfillment/orders/${own}/recheck`, 'sellerA', { method: 'POST' }), params({ id: own }))).status).toBe(200)
    expect(mocks.fetchVariantSkus).not.toHaveBeenCalled()
  })

  it('a manual line cost on a line of another store is refused and changes nothing', async () => {
    const patch = (lineId: string, who: Who) => lineCost(fx.request('/api/fulfillment/orders/line-cost', who, { method: 'PATCH', body: { lineId, manualBaseCost: 7 } }))
    expect((await patch(fx.lineId('b', 2), 'sellerA')).status).toBe(404)
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: fx.lineId('b', 2) } })).manualBaseCost).toBeNull()
    expect((await patch(fx.lineId('a', 2), 'sellerA')).status).toBe(200)
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: fx.lineId('a', 2) } })).manualBaseCost).toBe(7)
    await prisma.orderLine.update({ where: { id: fx.lineId('a', 2) }, data: { manualBaseCost: null } })
  })

  it('recalculating costs touches only the stores of the caller', async () => {
    expect((await recalculateCosts(fx.request('/api/fulfillment/orders/recalculate-costs', 'sellerA', { method: 'POST', body: {} }))).status).toBe(200)
    expect(mocks.recalculate.mock.calls[0][0].storeIds).toEqual([SA])
    mocks.recalculate.mockClear()
    expect((await recalculateCosts(fx.request('/api/fulfillment/orders/recalculate-costs', 'sellerNone', { method: 'POST', body: {} }))).status).toBe(200)
    expect(mocks.recalculate.mock.calls[0][0].storeIds).toEqual([])
    mocks.recalculate.mockClear()
    expect((await recalculateCosts(fx.request('/api/fulfillment/orders/recalculate-costs', 'admin', { method: 'POST', body: {} }))).status).toBe(200)
    expect(mocks.recalculate.mock.calls[0][0].storeIds).toBeUndefined()
  })
})

describe('need to fix', () => {
  it('a seller sees the tasks of its store only, each with the store name, and the counts follow the rows', async () => {
    const res = await call(await taskFix(fx.request('/api/fulfillment/task-fix', 'sellerA')))
    expect(res.status).toBe(200)
    const rowOrders = new Set<string>(res.body.rows.map((r: any) => r.orderId))
    expect(Array.from(rowOrders).sort()).toEqual(mine('a').filter(id => rowOrders.has(id)))
    expect(rowOrders.has(fx.orderId('a', 1))).toBe(true)
    expect(res.body.rows.every((r: any) => r.storeName === fx.projectName('a'))).toBe(true)
    expect(Object.values(res.body.counts).reduce((a: number, b) => a + (b as number), 0)).toBe(res.body.rows.length)
    expect(leaks(res.body)).toEqual([])
  })

  it('admin sees the tasks of both stores, each with its store name', async () => {
    const res = await call(await taskFix(fx.request('/api/fulfillment/task-fix', 'admin')))
    const named = Object.fromEntries(res.body.rows.map((r: any) => [r.orderId, r.storeName]))
    expect(named[fx.orderId('a', 1)]).toBe(fx.projectName('a'))
    expect(named[fx.orderId('b', 1)]).toBe(fx.projectName('b'))
    const narrowed = await call(await taskFix(fx.request(`/api/fulfillment/task-fix?storeId=${SB}`, 'admin')))
    expect(narrowed.body.rows.length).toBeGreaterThan(0)
    expect(narrowed.body.rows.every((r: any) => r.orderId.startsWith('soc-order-b'))).toBe(true)
  })

  it('the finished tasks follow the same scope', async () => {
    const seller = await call(await taskFix(fx.request('/api/fulfillment/task-fix?done=1', 'sellerA')))
    expect(seller.body.done.map((d: any) => d.orderId)).toEqual([fx.orderId('a', 1)])
    expect(seller.body.done[0].storeName).toBe(fx.projectName('a'))
    const admin = await call(await taskFix(fx.request('/api/fulfillment/task-fix?done=1', 'admin')))
    expect(admin.body.done.map((d: any) => d.orderId)).toEqual(expect.arrayContaining([fx.orderId('a', 1), fx.orderId('b', 1)]))
  })

})

describe('an inline fix', () => {
  type Kind = 'MISSING_SKU' | 'MISSING_BASE_COST'
  const variantOf = (s: 'a' | 'b', n: number) => `gid://shopify/ProductVariant/soc-${s}${n}`
  const item = (kind: Kind, lineId: string) => (kind === 'MISSING_SKU' ? { lineId, sku: 'FIX-SKU' } : { lineId, baseCost: 3 })
  const fix = (who: Who, kind: Kind, orderId: string, fixes: unknown[]) =>
    taskFixFix(fx.request('/api/fulfillment/task-fix/fix', who, { method: 'POST', body: { orderId, taskType: kind, fixes } }))
  const lineIds = [fx.lineId('a', 1), fx.lineId('a', 2), fx.lineId('a', 4), fx.lineId('b', 1), fx.lineId('b', 2)]
  const snapshot = async () => (await prisma.orderLine.findMany({ where: { id: { in: lineIds } }, orderBy: { id: 'asc' } })).map(l => [l.id, l.sku, l.manualBaseCost])

  beforeAll(async () => {
    for (const [s, n] of [['a', 1], ['a', 2], ['a', 4], ['b', 1], ['b', 2]] as const) {
      await prisma.orderLine.update({ where: { id: fx.lineId(s, n) }, data: { shopifyVariantId: variantOf(s, n) } })
    }
  })
  afterAll(async () => {
    await prisma.orderLine.updateMany({ where: { id: { in: lineIds } }, data: { shopifyVariantId: null } })
  })

  // The order whose lines the fix is for, the line that is its own, and a line of another order of the same store.
  const target: Record<Kind, { order: string; own: string; sameStore: string; otherStore: string }> = {
    MISSING_SKU: { order: fx.orderId('a', 1), own: fx.lineId('a', 1), sameStore: fx.lineId('a', 2), otherStore: fx.lineId('b', 1) },
    MISSING_BASE_COST: { order: fx.orderId('a', 2), own: fx.lineId('a', 2), sameStore: fx.lineId('a', 4), otherStore: fx.lineId('b', 2) },
  }

  it.each<Kind>(['MISSING_SKU', 'MISSING_BASE_COST'])('%s: an order of another store is refused', async kind => {
    const before = await snapshot()
    const other = kind === 'MISSING_SKU' ? fx.orderId('b', 1) : fx.orderId('b', 2)
    const lineId = target[kind].otherStore
    expect((await fix('sellerA', kind, other, [item(kind, lineId)])).status).toBe(404)
    expect(mocks.updateVariantSku).not.toHaveBeenCalled()
    expect(await snapshot()).toEqual(before)
  })

  it.each<Kind>(['MISSING_SKU', 'MISSING_BASE_COST'])('%s: one line outside the order refuses the whole request, whichever place it has', async kind => {
    const { order, own, sameStore, otherStore } = target[kind]
    const before = await snapshot()
    const missingOrder = await call(await fix('sellerA', kind, 'soc-order-nope', [item(kind, own)]))
    expect(missingOrder.status).toBe(404)

    for (const fixes of [[item(kind, own), item(kind, otherStore)], [item(kind, otherStore), item(kind, own)], [item(kind, own), item(kind, sameStore)]]) {
      const seller = await call(await fix('sellerA', kind, order, fixes))
      expect(seller).toEqual(missingOrder)
      const admin = await call(await fix('admin', kind, order, fixes))
      expect(admin.status).toBe(400)
      expect(admin.body.error).toMatch(/không thuộc đơn/)
    }
    expect((await call(await fix('sellerA', kind, order, [item(kind, own), { lineId: 7 }]))).status).toBe(404)
    expect((await call(await fix('admin', kind, order, [item(kind, own), null]))).status).toBe(400)

    expect(mocks.updateVariantSku).not.toHaveBeenCalled()
    expect(await snapshot()).toEqual(before)
  })

  it.each<Kind>(['MISSING_SKU', 'MISSING_BASE_COST'])('%s: lines of the order itself are fixed, for a seller of the store and for admin', async kind => {
    const { order, own } = target[kind]
    const before = await snapshot()
    for (const who of ['sellerA', 'admin'] as const) {
      const done = await call(await fix(who, kind, order, [item(kind, own)]))
      expect(done.body).toMatchObject({ applied: 1, errors: [] })
      const line = await prisma.orderLine.findUniqueOrThrow({ where: { id: own } })
      expect(kind === 'MISSING_SKU' ? line.sku : line.manualBaseCost).toBe(kind === 'MISSING_SKU' ? 'FIX-SKU' : 3)
      await prisma.orderLine.update({ where: { id: own }, data: { sku: before.find(row => row[0] === own)![1] as string | null, manualBaseCost: null } })
    }
    expect(mocks.updateVariantSku).toHaveBeenCalledTimes(kind === 'MISSING_SKU' ? 2 : 0)
    if (kind === 'MISSING_SKU') expect(mocks.updateVariantSku).toHaveBeenCalledWith(fx.shop('a'), `token-${fx.P}-a`, variantOf('a', 1), 'FIX-SKU')
    expect(await snapshot()).toEqual(before)
  })
})

describe('Shopify jobs started from the pages', () => {
  const sync = (who: Who, body: unknown = {}) => ordersSync(fx.request('/api/shopify/orders/sync', who, { method: 'POST', body }))
  const synced = () => mocks.syncStoreOrders.mock.calls.map(c => c[0] as string).sort()

  it('a seller syncs only the stores assigned to it, with or without naming one', async () => {
    expect((await sync('sellerA')).status).toBe(200)
    expect(synced()).toEqual([SA])
    mocks.syncStoreOrders.mockClear()
    expect((await sync('sellerA', { storeId: SA })).status).toBe(200)
    expect(synced()).toEqual([SA])
    mocks.syncStoreOrders.mockClear()
    expect((await sync('sellerAB')).status).toBe(200)
    expect(synced()).toEqual([SA, SB].sort())
  })

  it('a seller who names a store outside its list is refused before any store is asked', async () => {
    const res = await sync('sellerA', { storeId: SB })
    expect(res.status).toBe(403)
    expect(mocks.syncStoreOrders).not.toHaveBeenCalled()
    expect((await sync('sellerNone')).status).toBe(403)
    expect((await sync('sellerNone', { storeId: SA })).status).toBe(403)
    expect(mocks.syncStoreOrders).not.toHaveBeenCalled()
  })

  it('a seller who names an order picks it among its own stores only', async () => {
    const res = await sync('sellerA', { fromOrderName: fx.orderNumber('b', 1) })
    expect(res.status).toBe(200)
    expect(synced()).toEqual([SA])
  })

  it('admin still syncs every connected store, or the one it names', async () => {
    expect((await sync('admin')).status).toBe(200)
    expect(synced()).toEqual(expect.arrayContaining([SA, SB]))
    mocks.syncStoreOrders.mockClear()
    expect((await sync('admin', { storeId: SB })).status).toBe(200)
    expect(synced()).toEqual([SB])
  })

  it('normalizing statuses runs for the stores of the caller only', async () => {
    const run = (who: Who) => normalize(fx.request('/api/fulfillment/normalize', who, { method: 'POST' }))
    const stores = () => mocks.normalize.mock.calls.map(c => c[0].storeId as string).sort()
    expect((await run('sellerA')).status).toBe(200)
    expect(stores()).toEqual([SA])
    mocks.normalize.mockClear()
    expect((await run('sellerNone')).status).toBe(400)
    expect(mocks.normalize).not.toHaveBeenCalled()
    expect((await run('admin')).status).toBe(200)
    expect(stores()).toEqual(expect.arrayContaining([SA, SB]))
    expect((await normalize(fx.request('/api/fulfillment/normalize', null, { method: 'POST' }))).status).toBe(401)
  })

  it('the design diagnosis finds an order inside the chosen store only', async () => {
    const number = fx.orderNumber('b', 1)
    // Found, the diagnosis then stops at the Trello settings, which the test database does not have.
    const found = await call(await diagnose(fx.request(`/api/fulfillment/design-diagnose?order=${encodeURIComponent(number)}`, 'admin')))
    expect(found).toEqual({ status: 400, body: { error: 'Trello not configured' } })
    const narrowed = await call(await diagnose(fx.request(`/api/fulfillment/design-diagnose?order=${encodeURIComponent(number)}&storeId=${SA}`, 'admin')))
    expect(narrowed).toEqual({ status: 404, body: { error: `order ${number} not found` } })
    expect((await diagnose(fx.request(`/api/fulfillment/design-diagnose?order=${encodeURIComponent(number)}`, 'sellerA'))).status).toBe(403)
  })
})

describe('Design Studio lists', () => {
  const keys = (rows: { taskKey: string }[]) => rows.map(r => r.taskKey).sort()

  it('a seller sees the tasks of its store only, and the search does not look past its stores', async () => {
    const queue = await call(await dsTasks(fx.request('/api/design-studio/tasks', 'sellerA')))
    expect(queue.status).toBe(200)
    expect(keys(queue.body.tasks)).toEqual([1, 2, 4].map(n => fx.taskKey('a', n)).sort())
    expect(queue.body.tasks.every((t: any) => t.storeName === fx.projectName('a'))).toBe(true)
    expect(leaks(queue.body)).toEqual([])

    const byStatus = await call(await dsTasks(fx.request('/api/design-studio/tasks?statuses=NEW,REVIEW,DONE', 'sellerA')))
    expect(keys(byStatus.body.tasks)).toEqual([1, 2, 4].map(n => fx.taskKey('a', n)).sort())
    const search = await call(await dsTasks(fx.request('/api/design-studio/tasks?q=SOC', 'sellerA')))
    expect(keys(search.body.tasks)).toEqual([1, 2, 4].map(n => fx.taskKey('a', n)).sort())
    const lookingForOther = await call(await dsTasks(fx.request(`/api/design-studio/tasks?q=${fx.prefix('b')}`, 'sellerA')))
    expect(lookingForOther.body.tasks).toEqual([])
    expect((await dsTasks(fx.request(`/api/design-studio/tasks?storeId=${SB}`, 'sellerA'))).status).toBe(403)
  })

  it('the count waiting to be handed to a supplier counts the stores of the caller only', async () => {
    expect(await countPendingHandoff({ storeIds: [SA] })).toBe(1)
    expect(await countPendingHandoff({ storeIds: [SB] })).toBe(1)
    expect(await countPendingHandoff({ storeIds: [] })).toBe(0)
    expect(await countPendingHandoff({ storeIds: null })).toBeGreaterThanOrEqual(2)
    const seller = await call(await dsTasks(fx.request('/api/design-studio/tasks', 'sellerA')))
    expect(seller.body.handoffCount).toBe(1)
    const none = await call(await dsTasks(fx.request('/api/design-studio/tasks', 'sellerNone')))
    expect(none.body).toMatchObject({ tasks: [], handoffCount: 0 })
  })

  it('admin and support see the tasks of both stores in one queue, each with its store name', async () => {
    for (const who of ['admin', 'support'] as const) {
      const queue = await call(await dsTasks(fx.request('/api/design-studio/tasks?q=SOC', who)))
      expect(keys(queue.body.tasks)).toEqual([...[1, 2, 4].map(n => fx.taskKey('a', n)), ...[1, 2, 4].map(n => fx.taskKey('b', n))].sort())
      const names = Object.fromEntries(queue.body.tasks.map((t: any) => [t.taskKey, t.storeName]))
      expect(names[fx.taskKey('a', 1)]).toBe(fx.projectName('a'))
      expect(names[fx.taskKey('b', 1)]).toBe(fx.projectName('b'))
    }
    const narrowed = await call(await dsTasks(fx.request(`/api/design-studio/tasks?q=SOC&storeId=${SB}`, 'admin')))
    expect(keys(narrowed.body.tasks)).toEqual([1, 2, 4].map(n => fx.taskKey('b', n)).sort())
  })

  it('the review queue follows the same scope', async () => {
    const seller = await call(await dsReview(fx.request('/api/design-studio/tasks/review', 'sellerA')))
    const sellerKeys = seller.body.cards.map((c: any) => c.task.taskKey)
    expect(sellerKeys).toContain(fx.taskKey('a', 2))
    expect(sellerKeys).not.toContain(fx.taskKey('b', 2))
    expect(leaks(seller.body)).toEqual([])
    const admin = await call(await dsReview(fx.request('/api/design-studio/tasks/review', 'admin')))
    expect(admin.body.cards.map((c: any) => c.task.taskKey)).toEqual(expect.arrayContaining([fx.taskKey('a', 2), fx.taskKey('b', 2)]))
  })

  it('the order list of Design Studio follows the same scope and names the store', async () => {
    const seller = await call(await dsOrders(fx.request('/api/design-studio/orders?limit=500', 'sellerA')))
    expect(ids(seller.body.orders)).toEqual(mine('a'))
    expect(seller.body.orders.every((o: any) => o.storeName === fx.projectName('a'))).toBe(true)
    expect(leaks(seller.body)).toEqual([])
    const admin = await call(await dsOrders(fx.request(`/api/design-studio/orders?limit=500&search=SOC`, 'admin')))
    expect(ids(admin.body.orders)).toEqual([...mine('a'), ...mine('b')].sort())
  })
})

describe('Design Studio, one task, line, order or file at a time', () => {
  const noEvents = async (key: string) => prisma.designTaskEvent.count({ where: { task: { taskKey: key } } })
  const status = async (key: string) => (await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })).status

  it('a seller opens a task of its own store and gets 404 on a task of another store', async () => {
    const own = fx.taskKey('a', 1)
    const other = fx.taskKey('b', 1)
    const opened = await call(await dsTask(fx.request(`/api/design-studio/tasks/${own}`, 'sellerA'), params({ key: own })))
    expect(opened.status).toBe(200)
    expect(opened.body.task.taskKey).toBe(own)
    expect(leaks(opened.body)).toEqual([])
    const closed = await dsTask(fx.request(`/api/design-studio/tasks/${other}`, 'sellerA'), params({ key: other }))
    expect(closed.status).toBe(404)
    const admin = await dsTask(fx.request(`/api/design-studio/tasks/${other}`, 'admin'), params({ key: other }))
    expect(admin.status).toBe(200)
  })

  it('every write on a task of another store is refused and changes nothing', async () => {
    const key = fx.taskKey('b', 1)
    const p = params({ key })
    const url = `/api/design-studio/tasks/${key}`
    const attempts: Array<[string, () => Promise<Response>]> = [
      ['note', () => dsTaskNote(fx.request(url, 'designerA', { method: 'PATCH', body: { designNote: 'hello' } }), p)],
      ['transition', () => dsTransition(fx.request(`${url}/transition`, 'designerA', { method: 'POST', body: { to: 'DOING' } }), p)],
      ['event', () => dsEvent(fx.request(`${url}/events`, 'designerA', { method: 'POST', body: { message: 'hello' } }), p)],
      ['rename part', () => dsParts(fx.request(`${url}/parts`, 'designerA', { method: 'PATCH', body: { from: 'Front', to: 'Back' } }), p)],
      ['render read', () => dsAutoRenderGet(fx.request(`${url}/auto-render`, 'designerA'), p)],
      ['render start', () => dsAutoRender(fx.request(`${url}/auto-render`, 'designerA', { method: 'POST' }), p)],
      ['release', () => dsRelease(fx.request(`${url}/release-library`, 'designerA', { method: 'POST' }), p)],
      ['upload', () => dsTaskArtwork(fx.request(`${url}/artwork?fileName=x.png&printArea=Front`, 'designerA', { method: 'PUT', raw: 'png-bytes', headers: { 'content-type': 'image/png' } }), p)],
    ]
    for (const [name, attempt] of attempts) expect([name, (await attempt()).status]).toEqual([name, 404])
    expect(await status(key)).toBe('NEW')
    expect(await noEvents(key)).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: fx.orderId('b', 1) }, include: { lines: true } })).lines[0].designNote).toBeNull()
    expect(await prisma.designArtwork.count({ where: { orderId: fx.orderId('b', 1) } })).toBe(1)
  })

  it('a seller may add a note to a task of its own store', async () => {
    const key = fx.taskKey('a', 1)
    const res = await dsEvent(fx.request(`/api/design-studio/tasks/${key}/events`, 'designerA', { method: 'POST', body: { message: 'hello' } }), params({ key }))
    expect(res.status).toBe(200)
    expect(await noEvents(key)).toBe(1)
    await prisma.designTaskEvent.deleteMany({ where: { task: { taskKey: key } } })
  })

  it('the upload route, which the middleware skips, needs a session and the store of the task', async () => {
    const key = fx.taskKey('b', 1)
    const upload = (who: Who | null) => dsTaskArtwork(
      fx.request(`/api/design-studio/tasks/${key}/artwork?fileName=x.png&printArea=Front`, who, { method: 'PUT', raw: 'png-bytes', headers: { 'content-type': 'image/png' } }),
      params({ key }),
    )
    expect((await upload(null)).status).toBe(401)
    expect((await upload('sellerA')).status).toBe(404)
    expect((await upload('sellerNone')).status).toBe(404)
  })

  it('syncing design tasks for one order needs that order in scope; the all-store sync is not for a seller', async () => {
    const sync = (who: Who, body?: unknown) => dsSyncPost(fx.request('/api/design-studio/tasks/sync', who, { method: 'POST', body: body ?? {} }))
    expect((await sync('designerA', { orderId: fx.orderId('b', 1) })).status).toBe(404)
    expect((await sync('designerA', { orderId: fx.orderId('a', 1) })).status).toBe(200)
    expect((await sync('designerA')).status).toBe(403)
    const last = await call(await dsSyncGet(fx.request('/api/design-studio/tasks/sync', 'designerA')))
    expect(last.status).toBe(200)
  })

  it('a note on a line of another store is refused, and a line of its own store takes it', async () => {
    const patch = (lineId: string, note: string) => dsLine(fx.request(`/api/design-studio/lines/${lineId}`, 'designerA', { method: 'PATCH', body: { note } }), params({ lineId }))
    expect((await patch(fx.lineId('b', 1), 'hello')).status).toBe(404)
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: fx.lineId('b', 1) } })).designNote).toBeNull()
    expect((await patch(fx.lineId('a', 1), 'hello')).status).toBe(200)
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: fx.lineId('a', 1) } })).designNote).toBe('hello')
    await prisma.orderLine.update({ where: { id: fx.lineId('a', 1) }, data: { designNote: null } })
    await prisma.designTaskEvent.deleteMany({ where: { task: { taskKey: fx.taskKey('a', 1) } } })
  })

  it('a file sent to a line of another store is refused before it is read', async () => {
    const lineId = fx.lineId('b', 1)
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }))
    form.set('printArea', 'Front')
    const res = await dsLineArtwork(fx.request(`/api/design-studio/lines/${lineId}/artwork`, 'designerA', { method: 'POST', raw: form }), params({ lineId }))
    expect(res.status).toBe(404)
    expect(await prisma.designArtwork.count({ where: { orderId: fx.orderId('b', 1) } })).toBe(1)
  })

  it('an order workspace, its refresh and its hand-over card follow the same scope', async () => {
    const own = fx.orderId('a', 1)
    const other = fx.orderId('b', 1)
    expect((await dsOrder(fx.request(`/api/design-studio/orders/${own}`, 'sellerA'), params({ id: own }))).status).toBe(200)
    expect((await dsOrder(fx.request(`/api/design-studio/orders/${other}`, 'sellerA'), params({ id: other }))).status).toBe(404)
    expect((await dsOrder(fx.request(`/api/design-studio/orders/${other}`, 'admin'), params({ id: other }))).status).toBe(200)

    expect((await dsRefresh(fx.request(`/api/design-studio/orders/${other}/refresh`, 'sellerA', { method: 'POST' }), params({ id: other }))).status).toBe(404)
    expect(mocks.fetchOrderLinePropsByNames).not.toHaveBeenCalled()

    expect((await dsHandoff(fx.request(`/api/design-studio/orders/${own}/handoff`, 'sellerA'), params({ id: own }))).status).toBe(200)
    expect((await dsHandoff(fx.request(`/api/design-studio/orders/${other}/handoff`, 'sellerA'), params({ id: other }))).status).toBe(404)
    // A seller without CSV Export is refused whatever the order; one who holds it still gets nothing of another store.
    const handOver = (who: Who) => dsHandoffPost(fx.request(`/api/design-studio/orders/${other}/handoff`, who, { method: 'POST', body: { mode: 'CSV' } }), params({ id: other }))
    expect((await handOver('sellerA')).status).toBe(403)
    expect((await handOver('exporterA')).status).toBe(404)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: other }, select: { supplierHandoffAt: true } })).toEqual({ supplierHandoffAt: null })
  })

  it('a file of a task of another store is not served, small preview or original', async () => {
    const own = fx.artworkId('a')
    const other = fx.artworkId('b')
    const get = (id: string, who: Who, query = '') => dsFile(fx.request(`/api/design-studio/file/${id}${query}`, who), params({ artworkId: id }))
    const served = await get(own, 'sellerA')
    expect(served.status).toBe(200)
    expect(await served.text()).toBe(fx.artworkBytes('a'))
    expect((await get(other, 'sellerA')).status).toBe(404)
    expect((await get(other, 'sellerA', '?preview=1')).status).toBe(404)
    expect((await get(other, 'sellerA', '?thumb=1')).status).toBe(404)
    const admin = await get(other, 'admin')
    expect(admin.status).toBe(200)
    expect(await admin.text()).toBe(fx.artworkBytes('b'))
  })

  it('removing, previewing and pushing a file of another store are refused and change nothing', async () => {
    const id = fx.artworkId('b')
    const p = params({ artworkId: id })
    expect((await dsArtworkDelete(fx.request(`/api/design-studio/artwork/${id}`, 'sellerA', { method: 'DELETE' }), p)).status).toBe(404)
    expect((await dsArtworkPreview(fx.request(`/api/design-studio/artwork/${id}/preview`, 'sellerA', { method: 'PUT', raw: 'jpeg' }), p)).status).toBe(404)
    expect((await dsArtworkPush(fx.request(`/api/design-studio/artwork/${id}/push`, 'sellerA', { method: 'POST' }), p)).status).toBe(404)
    const row = await prisma.designArtwork.findUniqueOrThrow({ where: { id } })
    expect(row.removedAt).toBeNull()
    expect(row.previewPath).toBeNull()
    expect(row.storage).toBe('LOCAL')
  })
})
