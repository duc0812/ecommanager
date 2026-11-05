import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  normalize: vi.fn(),
  tracking: vi.fn(),
  parcelpanel: vi.fn(),
}))

vi.mock('@/lib/order-normalize', () => ({ normalizeOpenOrderStatuses: mocks.normalize }))
vi.mock('@/lib/tracking/tracking-sync', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/tracking/tracking-sync')>()),
  syncStoreTracking: mocks.tracking,
}))
vi.mock('@/lib/tracking/parcelpanel-sync', () => ({ syncParcelPanelTracking: mocks.parcelpanel }))
vi.mock('@/lib/tracking/parcelpanel-config', () => ({ getParcelPanelApiKey: vi.fn(async () => 'pp-key') }))

import { prisma } from '@/lib/db'
import { saveStoreCredential } from '@/lib/store-connections'
import { dropSessionUser, superRequest } from './helpers/session'
import { POST as normalizeRoute } from '@/app/api/fulfillment/normalize/route'
import { POST as trackingRoute } from '@/app/api/fulfillment/tracking/sync/route'
import { POST as parcelpanelRoute } from '@/app/api/fulfillment/tracking/parcelpanel-sync/route'
import { runDailyTrackingSync } from '@/lib/tracking/scheduler'
import { runDailyOrderNormalize } from '@/lib/order-normalize-scheduler'

const SHOP_A = 'sjr-a.myshopify.com'
const SHOP_B = 'sjr-b.myshopify.com'
const PROJECT_A = 'proj_sjr_a'
let storeA = ''
let storeB = ''

const normalized = (open: number) => ({ ordersOpen: open, since: null, fulfillmentUpdated: open * 2, pipelineFulfilled: open, errors: [] as string[] })
const tracked = (n: number) => ({ days: 30, since: '2026-10-01', ordersProcessed: n, shipmentCount: n, withTracking: n, withoutTracking: 0, fulfillmentStatusUpdated: n, errors: [] as string[] })

async function cleanup() {
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } })
  await prisma.project.deleteMany({ where: { id: PROJECT_A } })
  await prisma.appSetting.deleteMany({ where: { key: { in: ['last_tracking_sync_result', 'last_order_normalize_result'] } } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.project.create({ data: { id: PROJECT_A, name: 'SJR Alpha', startDate: new Date('2026-05-01') } })
  storeA = (await prisma.shopifyStore.create({ data: { shop: SHOP_A, projectId: PROJECT_A, connectedAt: new Date('2026-09-01') } })).id
  storeB = (await prisma.shopifyStore.create({ data: { shop: SHOP_B, connectedAt: new Date('2026-09-02') } })).id
  await saveStoreCredential(storeA, { authMode: 'TOKEN', accessToken: 'token-sjr-a' })
  await saveStoreCredential(storeB, { authMode: 'TOKEN', accessToken: 'token-sjr-b' })
})

beforeEach(async () => {
  mocks.normalize.mockReset()
  mocks.tracking.mockReset()
  mocks.parcelpanel.mockReset()
  await prisma.shopifyStore.updateMany({ where: { id: { in: [storeA, storeB] } }, data: { enabled: true, lastError: null, lastErrorAt: null } })
  await prisma.appSetting.deleteMany({ where: { key: { in: ['last_tracking_sync_result', 'last_order_normalize_result'] } } })
})

afterAll(async () => { await cleanup(); await dropSessionUser() })

const post = (path: string) => new NextRequest(`http://test${path}`, { method: 'POST' })
const runNormalize = async () => normalizeRoute(await superRequest('http://test/api/fulfillment/normalize', { method: 'POST' }))

describe('manual triggers run every connected store', () => {
  it('normalize: totals over the stores that worked, the failing one named, the other still run', async () => {
    mocks.normalize.mockImplementation(async (p: { storeId: string }) => {
      if (p.storeId === storeB) throw new Error('Shopify GraphQL 500')
      return normalized(3)
    })
    const res = await runNormalize()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ordersOpen: 3, fulfillmentUpdated: 6, pipelineFulfilled: 3, errors: [] })
    expect(body.storeErrors).toEqual([`${SHOP_B}: Shopify GraphQL 500`])
    expect(body.stores).toEqual([{ storeId: storeA, shop: SHOP_A, ok: true }, { storeId: storeB, shop: SHOP_B, ok: false, error: 'Shopify GraphQL 500' }])
    expect(mocks.normalize.mock.calls.map(c => [c[0].shop, c[0].accessToken])).toEqual([[SHOP_A, 'token-sjr-a'], [SHOP_B, 'token-sjr-b']])
  })

  it('normalize with one connected store answers what it always did, plus stores', async () => {
    await prisma.shopifyStore.update({ where: { id: storeB }, data: { enabled: false } })
    mocks.normalize.mockResolvedValue(normalized(4))
    const body = await (await runNormalize()).json()
    expect(body).toEqual({ ...normalized(4), stores: [{ storeId: storeA, shop: SHOP_A, ok: true }] })
  })

  it('normalize answers 502 when every store failed, and 400 when none is connected', async () => {
    mocks.normalize.mockRejectedValue(new Error('down'))
    expect((await runNormalize()).status).toBe(502)
    await prisma.shopifyStore.updateMany({ where: { id: { in: [storeA, storeB] } }, data: { enabled: false } })
    const none = await runNormalize()
    expect(none.status).toBe(400)
    expect((await none.json()).error).toBe('Not connected to Shopify.')
  })

  it('tracking sync: projectName joins the stores that ran, and a store without a project fails alone', async () => {
    mocks.tracking.mockImplementation(async (p: { storeId: string }) => tracked(p.storeId === storeA ? 2 : 5))
    const body = await (await trackingRoute(post('/api/fulfillment/tracking/sync?days=7'))).json()
    expect(body.shipmentCount).toBe(2)
    expect(body.projectName).toBe('SJR Alpha')
    expect(body.storeErrors).toEqual([`${SHOP_B}: Store not linked to a project. Assign it in /setup/projects.`])
    expect(mocks.tracking).toHaveBeenCalledTimes(1)
    expect(mocks.tracking.mock.calls[0][0]).toMatchObject({ shop: SHOP_A, days: 7 })
  })

  it('tracking sync: the only store having no project keeps the old 400', async () => {
    await prisma.shopifyStore.update({ where: { id: storeA }, data: { enabled: false } })
    const res = await trackingRoute(post('/api/fulfillment/tracking/sync'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('not linked to a project')
  })

  it('parcelpanel sync streams progress that continues across stores and ends with the totals', async () => {
    mocks.parcelpanel.mockImplementation(async (p: { storeId: string; onProgress: (d: number, t: number) => void }) => {
      const total = p.storeId === storeA ? 2 : 3
      for (let done = 1; done <= total; done += 1) p.onProgress(done, total)
      return { ordersChecked: total, shipmentsUpdated: total, delivered: 1, errors: [] as string[] }
    })
    const res = await parcelpanelRoute()
    const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l))
    const progress = lines.filter(l => l.type === 'progress').map(l => [l.done, l.total])
    expect(progress).toEqual([[1, 2], [2, 2], [3, 5], [4, 5], [5, 5]])
    expect(lines.at(-1)).toMatchObject({ type: 'done', ordersChecked: 5, shipmentsUpdated: 5, delivered: 2 })
    expect(mocks.parcelpanel.mock.calls.map(c => c[0].storeId)).toEqual([storeA, storeB])
  })
})

describe('schedulers run every connected store', () => {
  it('tracking: saves totals plus how each store went, and a failing store is recorded on it', async () => {
    mocks.tracking.mockImplementation(async (p: { storeId: string }) => {
      if (p.storeId === storeA) throw new Error('token revoked')
      return tracked(4)
    })
    await runDailyTrackingSync()
    const saved = JSON.parse((await prisma.appSetting.findUnique({ where: { key: 'last_tracking_sync_result' } }))!.value)
    expect(saved).toMatchObject({ shipmentCount: 4, shop: SHOP_B })
    expect(saved.stores).toEqual([{ storeId: storeA, shop: SHOP_A, ok: false, error: 'token revoked' }, { storeId: storeB, shop: SHOP_B, ok: true }])
    expect((await prisma.shopifyStore.findUnique({ where: { id: storeA } }))!.lastError).toBe('[tracking-sync] token revoked')
    expect((await prisma.shopifyStore.findUnique({ where: { id: storeB } }))!.lastError).toBeNull()
  })

  it('normalize: saves nothing when no store got through, but every failure is recorded on its store', async () => {
    mocks.normalize.mockRejectedValue(new Error('down'))
    await runDailyOrderNormalize()
    expect(await prisma.appSetting.findUnique({ where: { key: 'last_order_normalize_result' } })).toBeNull()
    expect((await prisma.shopifyStore.findUnique({ where: { id: storeA } }))!.lastError).toBe('[order-normalize] down')
    expect((await prisma.shopifyStore.findUnique({ where: { id: storeB } }))!.lastError).toBe('[order-normalize] down')
  })

  it('normalize: a run that works clears the earlier error', async () => {
    await prisma.shopifyStore.update({ where: { id: storeA }, data: { lastError: '[order-normalize] down' } })
    mocks.normalize.mockResolvedValue(normalized(1))
    await runDailyOrderNormalize()
    expect((await prisma.shopifyStore.findUnique({ where: { id: storeA } }))!.lastError).toBeNull()
    const saved = JSON.parse((await prisma.appSetting.findUnique({ where: { key: 'last_order_normalize_result' } }))!.value)
    expect(saved).toMatchObject({ ordersOpen: 2, fulfillmentUpdated: 4 })
  })
})
