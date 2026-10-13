import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

vi.mock('@/lib/token-store', () => ({ getShopifyConnection: vi.fn(async () => ({ shop: 'dt-job.myshopify.com', token: 't' })) }))
vi.mock('@/lib/shopify-orders', () => ({ fetchOrderLinePropsByNames: vi.fn(async () => new Map()) }))

import { prisma } from '@/lib/db'
import { fetchOrderLinePropsByNames } from '@/lib/shopify-orders'
import {
  DESIGN_TASK_SYNC_KEY, REFRESH_BATCH, REFRESH_MAX_ORDERS, getLastDesignTaskSync, runDesignTaskSync, runDesignTaskSyncJob,
} from '@/lib/design-task-sync'
import { isJobRunning } from '@/lib/job-lock'

const SHOP = 'dt-job.myshopify.com'
const PROJECT = 'proj_dt_job'
const SUP = 'sup_dt_job'
let storeId = ''
let seq = 0

const base = () => ({
  projectId: PROJECT, storeId, financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0,
})

async function order(opts: { status: string; placedAt: string; fulfillment?: string; link?: string | null; attrs?: string | null }) {
  seq += 1
  const id = `gid://test/Order/dt-job-${seq}`
  await prisma.order.create({ data: {
    ...base(), id, shopifyOrderNumber: `#DTJ${seq}`, placedAt: new Date(opts.placedAt), pipelineStatus: opts.status, fulfillmentStatus: opts.fulfillment ?? null,
    lines: { create: [{
      shopifyLineId: 'l1', sku: `DTJ-${seq}`, productTitle: 'Mug', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP,
      designDriveLink: opts.link ?? null, customAttributesJson: opts.attrs === undefined ? '[]' : opts.attrs,
      imageUrl: 'https://cdn.example/i.png', shopifyProductId: 'gid://shopify/Product/1',
    }] },
  } })
  return { id, key: `DTJ${seq}_1` }
}

const taskOf = (orderId: string) => prisma.designTask.findFirst({ where: { orderId }, include: { events: true } })

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'DT job', startDate: new Date('2026-01-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DTJOB' }, create: { id: SUP, name: 'DT Job Supplier', code: 'DTJOB' }, update: {} })
  // More than 100 newer orders, so anything from 2025 sits outside the "newest 100" window.
  await prisma.order.createMany({ data: Array.from({ length: 105 }, (_, i) => ({
    ...base(), id: `gid://test/Order/dt-job-filler-${i}`, shopifyOrderNumber: `#DTJF${i}`,
    placedAt: new Date(Date.UTC(2026, 9, 12, 0, i)), pipelineStatus: 'READY_TO_PRODUCTION',
  })) })
})

beforeEach(() => {
  vi.mocked(fetchOrderLinePropsByNames).mockClear()
  globalThis.__designSyncRefreshAttempts = undefined
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appSetting.deleteMany({ where: { key: DESIGN_TASK_SYNC_KEY } })
})

describe('runDesignTaskSync scope', () => {
  it('gives an old PENDING_DESIGN / DESIGN_REJECTED order a task although it is far outside the newest 100', async () => {
    const pending = await order({ status: 'PENDING_DESIGN', placedAt: '2025-03-01' })
    const rejected = await order({ status: 'DESIGN_REJECTED', placedAt: '2025-03-02' })
    const s = await runDesignTaskSync()
    expect(s.errors).toEqual([])
    expect(s.created).toBeGreaterThanOrEqual(2)
    expect(s.scope.design).toBeGreaterThanOrEqual(2)
    expect((await taskOf(pending.id))?.status).toBe('NEW')
    expect((await taskOf(rejected.id))?.status).toBe('NEW')
  })

  it('never deletes an untouched NEW task of an old order, and still visits an old order with an open task', async () => {
    const old = await order({ status: 'READY_TO_PRODUCTION', placedAt: '2025-01-05', link: 'https://drive.example/lib' })
    await prisma.designTask.create({ data: { orderId: old.id, shopifyLineId: 'l1', taskKey: old.key, status: 'NEW', events: { create: { type: 'SYSTEM', message: 'created' } } } })
    const idle = await order({ status: 'ON_HOLD', placedAt: '2025-01-06' })
    await prisma.designTask.create({ data: { orderId: idle.id, shopifyLineId: 'l1', taskKey: idle.key, status: 'NEW' } })
    const before = await prisma.designTask.count()

    const s = await runDesignTaskSync()
    expect(await prisma.designTask.count()).toBeGreaterThanOrEqual(before)
    expect((await taskOf(idle.id))?.status).toBe('NEW')
    expect((await taskOf(old.id))?.status).toBe('DONE')
    expect(s.completed).toBeGreaterThanOrEqual(1)
    expect(s).not.toHaveProperty('pruned')
  })

  it('creates no task for fulfilled, cancelled or refunded orders and cancels the open ones they still hold', async () => {
    const fulfilled = await order({ status: 'FULFILLED', placedAt: '2026-10-12T02:00:00Z' })
    const shipped = await order({ status: 'PENDING_DESIGN', placedAt: '2026-10-12T02:01:00Z', fulfillment: 'FULFILLED' })
    const cancelled = await order({ status: 'CANCELLED', placedAt: '2026-10-12T02:02:00Z' })
    const refunded = await order({ status: 'REFUNDED', placedAt: '2026-10-12T02:03:00Z' })
    const stale = await order({ status: 'FULFILLED', placedAt: '2025-02-01' })
    await prisma.designTask.create({ data: { orderId: stale.id, shopifyLineId: 'l1', taskKey: stale.key, status: 'NEW' } })

    await runDesignTaskSync()
    for (const o of [fulfilled, shipped, cancelled, refunded]) expect(await taskOf(o.id)).toBeNull()
    const closed = await taskOf(stale.id)
    expect(closed?.status).toBe('CANCELLED')
    expect(closed?.events.some(e => e.type === 'SYSTEM' && e.message.includes('fulfilled'))).toBe(true)
  })
})

describe('runDesignTaskSync Shopify refresh', () => {
  it('asks Shopify in batches, caps one run, and a scheduled run does not re-ask within the retry window', async () => {
    const total = REFRESH_MAX_ORDERS + 10
    // Newest of all, so leftovers of other suites never take a slot of the capped batch.
    for (let i = 0; i < total; i += 1) await order({ status: 'PENDING_DESIGN', placedAt: `2027-06-01T00:${String(i % 60).padStart(2, '0')}:00Z`, attrs: null })

    const first = await runDesignTaskSync({ trigger: 'schedule', now: 1_000_000 })
    const calls = vi.mocked(fetchOrderLinePropsByNames).mock.calls
    expect(calls).toHaveLength(Math.ceil(REFRESH_MAX_ORDERS / REFRESH_BATCH))
    expect(calls.every(c => c[2].length <= REFRESH_BATCH)).toBe(true)
    expect(first.refresh.needing).toBeGreaterThanOrEqual(total)
    expect(first.refresh.attempted).toBe(REFRESH_MAX_ORDERS)
    expect(first.refresh.notFound).toBe(REFRESH_MAX_ORDERS)
    expect(first.refresh.deferred).toBe(first.refresh.needing - REFRESH_MAX_ORDERS)
    expect(first.refresh.error).toBeNull()

    vi.mocked(fetchOrderLinePropsByNames).mockClear()
    await runDesignTaskSync({ trigger: 'schedule', now: 1_000_000 + 60_000 })
    const asked = vi.mocked(fetchOrderLinePropsByNames).mock.calls.flatMap(c => c[2])
    expect(asked.length).toBe(total - REFRESH_MAX_ORDERS)
    expect(new Set(asked).size).toBe(asked.length)
    const firstAsked = new Set(calls.flatMap(c => c[2]))
    expect(asked.some(n => firstAsked.has(n))).toBe(false)

    vi.mocked(fetchOrderLinePropsByNames).mockClear()
    const manual = await runDesignTaskSync({ trigger: 'manual', now: 1_000_000 + 120_000 })
    expect(manual.refresh.attempted).toBe(REFRESH_MAX_ORDERS)
  })

  it('reports a Shopify failure without stopping the task sync', async () => {
    vi.mocked(fetchOrderLinePropsByNames).mockRejectedValueOnce(new Error('Shopify GraphQL 502'))
    const late = await order({ status: 'PENDING_DESIGN', placedAt: '2026-10-12T05:00:00Z', attrs: null })
    const s = await runDesignTaskSync()
    expect(s.refresh.error).toContain('502')
    expect(s.refresh.attempted).toBe(0)
    expect((await taskOf(late.id))?.status).toBe('NEW')
  })
})

describe('runDesignTaskSyncJob', () => {
  it('never overlaps itself: a second call while one runs is skipped', async () => {
    const [a, b] = await Promise.all([runDesignTaskSyncJob('schedule'), runDesignTaskSyncJob('manual')])
    expect([a.skipped, b.skipped].sort()).toEqual([false, true])
    expect(isJobRunning('design-task-sync')).toBe(false)
    const again = await runDesignTaskSyncJob('manual')
    expect(again.skipped).toBe(false)
  })

  it('stores the last result in AppSetting', async () => {
    const before = Date.now()
    const r = await runDesignTaskSyncJob('schedule')
    expect(r.skipped).toBe(false)
    const last = await getLastDesignTaskSync()
    expect(last?.trigger).toBe('schedule')
    expect(last?.error).toBeNull()
    expect(new Date(last!.ranAt).getTime()).toBeGreaterThanOrEqual(before)
    const stored = JSON.parse((await prisma.appSetting.findUniqueOrThrow({ where: { key: DESIGN_TASK_SYNC_KEY } })).value)
    expect(stored).toMatchObject({ trigger: 'schedule', created: expect.any(Number), orders: expect.any(Number), refresh: expect.any(Object) })
  })
})
