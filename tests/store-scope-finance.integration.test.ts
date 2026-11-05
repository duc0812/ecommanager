import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const mocks = vi.hoisted(() => ({
  fetchAllPayouts: vi.fn(),
  fetchBalance: vi.fn(),
  fetchBankAccounts: vi.fn(),
  fetchPayoutTransactions: vi.fn(),
  syncMetaInsights: vi.fn(),
  syncMetaCampaignInsights: vi.fn(),
  refreshReserveData: vi.fn(),
  snapshotProjectMonth: vi.fn(),
  backfillProjectSnapshots: vi.fn(),
}))

vi.mock('@/lib/shopify', () => ({
  fetchAllPayouts: mocks.fetchAllPayouts,
  fetchBalance: mocks.fetchBalance,
  fetchBankAccounts: mocks.fetchBankAccounts,
  fetchPayoutTransactions: mocks.fetchPayoutTransactions,
}))
vi.mock('@/lib/sync-meta-insights', () => ({
  syncMetaInsights: mocks.syncMetaInsights,
  syncMetaCampaignInsights: mocks.syncMetaCampaignInsights,
}))
vi.mock('@/lib/meta-reserve-sync', () => ({ refreshReserveData: mocks.refreshReserveData }))
vi.mock('@/lib/cashflow-snapshot-scheduler', () => ({
  snapshotProjectMonth: mocks.snapshotProjectMonth,
  backfillProjectSnapshots: mocks.backfillProjectSnapshots,
}))

import { prisma } from '@/lib/db'
import {
  ACC_A, ACC_B, ACC_C, ACC_U, NAME_A, NAME_B, NAME_C, PROJECT_A, PROJECT_B, PROJECT_C, SELLER_FEATURES, SHOP_A, SHOP_B, P,
  cleanupFinanceFixture, ensureAdmin, request, seedFinanceFixture, type Fixture,
} from './helpers/finance-scope-fixture'
import { GET as overview } from '@/app/api/overview/route'
import { GET as listProjects, POST as createProject, PATCH as patchProject, DELETE as deleteProject } from '@/app/api/projects/route'
import { GET as analytics } from '@/app/api/projects/analytics/route'
import { GET as profitChart } from '@/app/api/projects/profit-chart/route'
import { GET as projectPl } from '@/app/api/projects/[id]/pl/route'
import { POST as takeSnapshot } from '@/app/api/projects/[id]/snapshot/route'
import { GET as listSnapshots } from '@/app/api/projects/[id]/snapshots/route'
import { POST as backfill } from '@/app/api/projects/snapshot/backfill/route'
import { POST as assignStaff } from '@/app/api/projects/assign/route'
import { GET as dbPayouts } from '@/app/api/shopify/db-payouts/route'
import { GET as livePayouts } from '@/app/api/shopify/payouts/route'
import { GET as payoutDetail } from '@/app/api/shopify/payouts/[id]/route'
import { GET as dbBilling } from '@/app/api/meta/db-billing/route'
import { GET as metaAccounts } from '@/app/api/meta/accounts/route'
import { GET as reserveOverview, POST as refreshReserve } from '@/app/api/meta/reserve/route'
import { GET as listRates, POST as addRate, DELETE as removeRate } from '@/app/api/meta/exchange-rates/route'
import { GET as listBills, POST as createBill } from '@/app/api/finance/other-bills/route'
import { DELETE as deleteBill } from '@/app/api/finance/other-bills/[id]/route'
import { GET as nichePerformance } from '@/app/api/marketing/niche-performance/route'
import { GET as dailySyncStatus, POST as runDailySync } from '@/app/api/sync/daily/route'
import { GET as listStaff, POST as createStaff, DELETE as deleteStaff } from '@/app/api/staff/route'
import { GET as autoSyncStatus, POST as runAutoSync } from '@/app/api/auto-sync/route'
import { SELLER_API_PREFIXES, canCallApi } from '@/lib/api-access'

const before = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/finance-scope/single-store-before.json'), 'utf8'))
const DAILY_KEY = 'last_daily_sync_result'
const AUTO_KEY = 'last_auto_sync_result'

let fx: Fixture
let baseline: any
let baselineCustom: any
let baselineStaff = 0
let savedDaily: string | null = null
let savedAuto: string | null = null
const fetchSpy = vi.fn()

const call = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) })
const ids = (rows: { id: string }[]) => rows.map(r => r.id).filter(id => id.startsWith(P)).sort()
const without = (value: any, ...keys: string[]) => {
  const copy = { ...value }
  for (const key of keys) delete copy[key]
  return copy
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await cleanupFinanceFixture()
  savedDaily = (await prisma.appSetting.findUnique({ where: { key: DAILY_KEY } }))?.value ?? null
  savedAuto = (await prisma.appSetting.findUnique({ where: { key: AUTO_KEY } }))?.value ?? null
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: AUTO_KEY } } })
  baselineStaff = await prisma.staff.count()
  await ensureAdmin()
  baseline = await (await overview(request('/api/overview?period=all', 'admin'))).json()
  baselineCustom = await (await overview(request('/api/overview?period=custom&date=2026-10-05', 'admin'))).json()
  fx = await seedFinanceFixture({ second: true, third: true })
})

afterAll(async () => {
  await cleanupFinanceFixture()
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: AUTO_KEY } } })
  await prisma.appSetting.deleteMany({ where: { key: DAILY_KEY } })
  if (savedDaily !== null) await prisma.appSetting.create({ data: { key: DAILY_KEY, value: savedDaily } })
  if (savedAuto !== null) await prisma.appSetting.create({ data: { key: AUTO_KEY, value: savedAuto } })
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchAllPayouts.mockResolvedValue([])
  mocks.fetchBalance.mockResolvedValue({ amount: '1.00', currency: 'USD' })
  mocks.fetchBankAccounts.mockResolvedValue([])
  mocks.fetchPayoutTransactions.mockResolvedValue([])
  mocks.syncMetaInsights.mockResolvedValue({ synced: 2, accounts: 1, errors: [], perAccount: [], range: { since: '2026-10-01', until: '2026-10-05' } })
  mocks.syncMetaCampaignInsights.mockResolvedValue({ synced: 1, accounts: 1, errors: [], perAccount: [], range: { since: '2026-10-01', until: '2026-10-05' } })
  mocks.refreshReserveData.mockResolvedValue({ refreshed: [], errors: [] })
  mocks.snapshotProjectMonth.mockResolvedValue({})
  mocks.backfillProjectSnapshots.mockResolvedValue({ created: 0 })
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
})

describe('/api/overview', () => {
  it('a seller on Alpha sees only Alpha totals to the cent, and net cashflow leaves Beta out', async () => {
    const { status, body } = await call(await overview(request('/api/overview?period=all', 'seller-a')))
    expect(status).toBe(200)
    expect(body.shopify.totalRevenue).toBeCloseTo(1040.75, 2)
    expect(body.shopify.payoutCount).toBe(2)
    expect(body.shopify.recentPayouts.map((p: { id: number }) => p.id)).toEqual([9_500_002, 9_500_001])
    expect(body.meta.totalSpend).toBeCloseTo(335, 2)
    expect(body.meta.billingCount).toBe(3)
    expect(body.meta.recentBillings.map((b: { id: string }) => b.id).sort()).toEqual([`${P}-bill-a1`, `${P}-bill-a2`, `${P}-bill-u1`])
    expect(body.netCashflow).toBeCloseTo(705.75, 2)
    expect(body.projects).toMatchObject({ count: 1, list: [{ id: PROJECT_A, name: NAME_A, staffCount: 2, monthlyCost: 1000 }] })
    expect(body.staff).toEqual({ count: 2, totalMonthlyCost: 1000 })
    expect(body.stores).toEqual([NAME_A])
  })

  it('with one store the figures are exactly what the single-store implementation returned', async () => {
    for (const [key, query] of [['overviewAll', 'period=all'], ['overviewCustom', 'period=custom&date=2026-10-05']] as const) {
      const { body } = await call(await overview(request(`/api/overview?${query}`, 'seller-a')))
      expect(without(body, 'chartData', 'stores')).toEqual(before[key])
    }
  })

  it('a seller with a project-less ad account also sees it, and a seller with no store sees nothing', async () => {
    const withUnassigned = await call(await overview(request('/api/overview?period=custom&date=2026-10-05', 'seller-a')))
    expect(withUnassigned.body.periodMetrics.adSpendByAccount.map((a: { accountId: string }) => a.accountId).sort()).toEqual([`${P}-accdb-a`, `${P}-accdb-u`])
    const none = await call(await overview(request('/api/overview?period=custom&date=2026-10-05', 'seller-none')))
    expect(none.body.shopify).toEqual({ totalRevenue: 0, payoutCount: 0, recentPayouts: [] })
    expect(none.body.meta).toMatchObject({ totalSpend: 0, billingCount: 0, recentBillings: [] })
    expect(none.body.projects).toEqual({ count: 0, list: [] })
    expect(none.body.staff).toEqual({ count: 0, totalMonthlyCost: 0 })
    expect(none.body.periodMetrics).toMatchObject({ orders: 0, revenue: 0, adSpend: 0, unfulfilledOrders: 0 })
    expect(none.body.stores).toEqual([])
  })

  it('a seller cannot name a store it was not given, and a seller of two stores can narrow to either', async () => {
    expect((await overview(request(`/api/overview?storeId=${fx.storeB}`, 'seller-a'))).status).toBe(403)
    const both = await call(await overview(request('/api/overview?period=all', 'seller-ab')))
    expect(both.body.shopify.totalRevenue).toBeCloseTo(3041.25, 2)
    expect(both.body.stores).toEqual([NAME_A, NAME_B])
    const one = await call(await overview(request(`/api/overview?period=all&storeId=${fx.storeB}`, 'seller-ab')))
    expect(one.body.shopify.totalRevenue).toBeCloseTo(2000.5, 2)
    expect(one.body.stores).toEqual([NAME_B])
  })

  it('admin with no filter sums every store and names them; ?storeId narrows to one', async () => {
    const all = await call(await overview(request('/api/overview?period=all', 'admin')))
    expect(all.body.stores).toEqual(expect.arrayContaining([NAME_A, NAME_B, NAME_C]))
    expect(all.body.shopify.totalRevenue - baseline.shopify.totalRevenue).toBeCloseTo(3041.25, 2)
    expect(all.body.shopify.payoutCount - baseline.shopify.payoutCount).toBe(3)
    expect(all.body.meta.totalSpend - baseline.meta.totalSpend).toBeCloseTo(745.3, 2)
    expect(all.body.netCashflow - baseline.netCashflow).toBeCloseTo(3041.25 - 745.3, 2)
    expect(all.body.projects.count - baseline.projects.count).toBe(3)

    const b = await call(await overview(request(`/api/overview?period=all&storeId=${fx.storeB}`, 'admin')))
    expect(b.body.stores).toEqual([NAME_B])
    expect(b.body.shopify).toMatchObject({ payoutCount: 1 })
    expect(b.body.shopify.totalRevenue).toBeCloseTo(2000.5, 2)
    expect(b.body.meta.totalSpend).toBeCloseTo(410.3, 2)
    expect(b.body.netCashflow).toBeCloseTo(1590.2, 2)
    expect(b.body.projects.list.map((p: { id: string }) => p.id)).toEqual([PROJECT_B])
    expect(b.body.staff).toEqual({ count: 2, totalMonthlyCost: 1200 })
  })

  it("each store's period uses its own time zone before the figures are summed", async () => {
    const { body } = await call(await overview(request('/api/overview?period=custom&date=2026-10-05', 'seller-bc')))
    expect(body.stores).toEqual([NAME_B, NAME_C])
    expect(body.periodMetrics.orders).toBe(3)
    expect(body.periodMetrics.revenue).toBeCloseTo(1210, 2)
    expect(body.periodMetrics.unfulfilledOrders).toBe(3)
    expect(body.periodMetrics.adSpend).toBeCloseTo(100, 2)
    expect(body.periodMetrics.adSpendByAccount.map((a: { accountId: string }) => a.accountId).sort()).toEqual([`${P}-accdb-b`, `${P}-accdb-c`, `${P}-accdb-u`])
    expect(body.periodMetrics.avgOrderValue).toBeCloseTo(1210 / 3, 2)
  })

  it('admin with no filter adds the zone groups too, and the accounts of no store land in the first one', async () => {
    const { body } = await call(await overview(request('/api/overview?period=custom&date=2026-10-05', 'admin')))
    const base = baselineCustom.periodMetrics
    expect(body.periodMetrics.orders - base.orders).toBe(4)
    expect(body.periodMetrics.revenue - base.revenue).toBeCloseTo(1310, 2)
    expect(body.periodMetrics.unfulfilledOrders - base.unfulfilledOrders).toBe(4)
    expect(body.periodMetrics.adSpend - base.adSpend).toBeCloseTo(150, 2)
  })

  it('a request without a session is 401', async () => {
    expect((await overview(request('/api/overview', null))).status).toBe(401)
  })
})

describe('/api/projects', () => {
  it('lists only the seller\'s projects, with only their staff assignments, and matches the single-store output', async () => {
    const { body } = await call(await listProjects(request('/api/projects', 'seller-a')))
    expect(ids(body)).toEqual([PROJECT_A])
    expect(body).toEqual(before.projects)
    const ab = await call(await listProjects(request('/api/projects', 'seller-ab')))
    expect(ids(ab.body)).toEqual([PROJECT_A, PROJECT_B])
    expect((await call(await listProjects(request('/api/projects', 'seller-none')))).body).toEqual([])
  })

  it('admin lists every project and ?storeId narrows to that store\'s project', async () => {
    const all = await call(await listProjects(request('/api/projects', 'admin')))
    expect(ids(all.body)).toEqual([PROJECT_A, PROJECT_B, PROJECT_C])
    const one = await call(await listProjects(request(`/api/projects?storeId=${fx.storeC}`, 'admin')))
    expect(ids(one.body)).toEqual([PROJECT_C])
    expect((await listProjects(request(`/api/projects?storeId=${fx.storeB}`, 'seller-a'))).status).toBe(403)
  })

  it('a seller holding setup permissions still cannot create, rename or delete a project, or assign staff', async () => {
    expect((await createProject(request('/api/projects', 'seller-writer', { method: 'POST', body: { name: `${P}-new`, startDate: '2026-10-01' } }))).status).toBe(403)
    expect((await patchProject(request('/api/projects', 'seller-writer', { method: 'PATCH', body: { id: PROJECT_B, name: 'renamed' } }))).status).toBe(403)
    expect((await deleteProject(request('/api/projects', 'seller-writer', { method: 'DELETE', body: { id: PROJECT_B } }))).status).toBe(403)
    expect((await assignStaff(request('/api/projects/assign', 'seller-writer', { method: 'POST', body: { staffId: `${P}-staff-a`, projectId: PROJECT_B, startDate: '2026-10-01' } }))).status).toBe(403)
    expect(await prisma.project.findUnique({ where: { id: PROJECT_B }, select: { name: true } })).toEqual({ name: NAME_B })
    expect(await prisma.project.count({ where: { name: `${P}-new` } })).toBe(0)
    expect(await prisma.staffAssignment.count({ where: { staffId: `${P}-staff-a`, projectId: PROJECT_B } })).toBe(0)
  })
})

describe('project routes', () => {
  it('a seller gets 403 on analytics, profit chart, P&L, snapshots and a snapshot run of another store\'s project', async () => {
    const other = `projectId=${PROJECT_B}`
    expect((await analytics(request(`/api/projects/analytics?${other}`, 'seller-a'))).status).toBe(403)
    expect((await profitChart(request(`/api/projects/profit-chart?${other}`, 'seller-a'))).status).toBe(403)
    expect((await projectPl(request(`/api/projects/${PROJECT_B}/pl`, 'seller-a'), { params: { id: PROJECT_B } })).status).toBe(403)
    expect((await listSnapshots(request(`/api/projects/${PROJECT_B}/snapshots`, 'seller-a'), { params: { id: PROJECT_B } })).status).toBe(403)
    const run = request(`/api/projects/${PROJECT_B}/snapshot`, 'seller-a', { method: 'POST', body: { month: '2026-09' } })
    expect((await takeSnapshot(run, { params: { id: PROJECT_B } })).status).toBe(403)
    expect(mocks.snapshotProjectMonth).not.toHaveBeenCalled()
  })

  it('the same seller reads its own project, and admin reads any', async () => {
    expect((await analytics(request(`/api/projects/analytics?projectId=${PROJECT_A}&dateFrom=2026-10-01&dateTo=2026-10-31`, 'seller-a'))).status).toBe(200)
    expect((await profitChart(request(`/api/projects/profit-chart?projectId=${PROJECT_A}&period=custom&from=2026-10-01&to=2026-10-31`, 'seller-a'))).status).toBe(200)
    expect((await projectPl(request(`/api/projects/${PROJECT_A}/pl`, 'seller-a'), { params: { id: PROJECT_A } })).status).toBe(200)
    const snaps = await call(await listSnapshots(request(`/api/projects/${PROJECT_A}/snapshots`, 'seller-a'), { params: { id: PROJECT_A } }))
    expect(snaps.body).toEqual({ rows: [] })
    expect((await analytics(request(`/api/projects/analytics?projectId=${PROJECT_B}&dateFrom=2026-10-01&dateTo=2026-10-31`, 'admin'))).status).toBe(200)
    expect((await takeSnapshot(request(`/api/projects/${PROJECT_B}/snapshot`, 'admin', { method: 'POST', body: { month: '2026-09' } }), { params: { id: PROJECT_B } })).status).toBe(200)
    expect(mocks.snapshotProjectMonth).toHaveBeenCalledWith(PROJECT_B, '2026-09')
  })

  it('a missing projectId is still 400 and an unknown project 404 for admin', async () => {
    expect((await analytics(request('/api/projects/analytics', 'seller-a'))).status).toBe(400)
    expect((await analytics(request('/api/projects/analytics?projectId=nope', 'admin'))).status).toBe(404)
    expect((await analytics(request('/api/projects/analytics?projectId=nope', 'seller-a'))).status).toBe(403)
  })

  it('backfill by a seller reaches only its own projects', async () => {
    expect((await backfill(request('/api/projects/snapshot/backfill', 'seller-a', { method: 'POST', body: { projectId: PROJECT_B } }))).status).toBe(403)
    expect(mocks.backfillProjectSnapshots).not.toHaveBeenCalled()
    const own = await call(await backfill(request('/api/projects/snapshot/backfill', 'seller-a', { method: 'POST', body: {} })))
    expect(Object.keys(own.body.results)).toEqual([PROJECT_A])
    expect(mocks.backfillProjectSnapshots).toHaveBeenCalledTimes(1)
    const all = await call(await backfill(request('/api/projects/snapshot/backfill', 'admin', { method: 'POST', body: {} })))
    expect(Object.keys(all.body.results)).toEqual(expect.arrayContaining([PROJECT_A, PROJECT_B, PROJECT_C]))
  })
})

describe('Shopify payout routes', () => {
  const dbIds = async (who: string, query = '') => {
    const res = await call(await dbPayouts(request(`/api/shopify/db-payouts${query}`, who)))
    return { status: res.status, ids: (res.body?.payouts ?? []).map((p: { id: number }) => p.id) }
  }

  it('db-payouts shows the first store of the seller, not the first store overall', async () => {
    expect(await dbIds('seller-a')).toEqual({ status: 200, ids: [9_500_002, 9_500_001] })
    expect(await dbIds('seller-b')).toEqual({ status: 200, ids: [9_500_011] })
    expect(await dbIds('seller-ab')).toEqual({ status: 200, ids: [9_500_002, 9_500_001] })
    expect(await dbIds('admin')).toEqual({ status: 200, ids: [9_500_002, 9_500_001] })
  })

  it('db-payouts: a store outside the seller\'s stores is 403, an assigned one narrows, admin may name any', async () => {
    expect((await dbIds('seller-a', `?storeId=${fx.storeB}`)).status).toBe(403)
    expect(await dbIds('seller-ab', `?storeId=${fx.storeB}`)).toEqual({ status: 200, ids: [9_500_011] })
    expect(await dbIds('admin', `?storeId=${fx.storeB}`)).toEqual({ status: 200, ids: [9_500_011] })
    expect((await dbIds('admin', '?storeId=nope')).status).toBe(404)
    expect((await dbIds('seller-none')).status).toBe(200)
  })

  it('live payouts call Shopify for the seller\'s store only', async () => {
    await livePayouts(request('/api/shopify/payouts', 'seller-b'))
    expect(mocks.fetchAllPayouts).toHaveBeenLastCalledWith({ shop: SHOP_B, token: 'token-fsf-b' }, { date_min: '2026-10-06', date_max: undefined })
    mocks.fetchAllPayouts.mockClear()
    expect((await livePayouts(request(`/api/shopify/payouts?storeId=${fx.storeB}`, 'seller-a'))).status).toBe(403)
    expect(mocks.fetchAllPayouts).not.toHaveBeenCalled()
    await livePayouts(request(`/api/shopify/payouts?storeId=${fx.storeA}`, 'admin'))
    expect(mocks.fetchAllPayouts).toHaveBeenLastCalledWith({ shop: SHOP_A, token: 'token-fsf-a' }, expect.anything())
  })

  it('a payout detail of another store is 403 and never reaches Shopify', async () => {
    const open = (who: string, id: number) => payoutDetail(request(`/api/shopify/payouts/${id}`, who), { params: { id: String(id) } })
    expect((await open('seller-a', 9_500_011)).status).toBe(403)
    expect(mocks.fetchPayoutTransactions).not.toHaveBeenCalled()
    expect((await open('seller-a', 9_500_001)).status).toBe(200)
    expect(mocks.fetchPayoutTransactions).toHaveBeenCalledTimes(1)
    expect((await open('admin', 9_500_011)).status).toBe(200)
  })
})

describe('Meta routes', () => {
  it('db-billing gives a seller only its project\'s and the project-less accounts and billings', async () => {
    const { body } = await call(await dbBilling(request('/api/meta/db-billing', 'seller-a')))
    expect(ids(body.accounts)).toEqual([`${P}-accdb-a`, `${P}-accdb-u`])
    expect(ids(body.billings)).toEqual([`${P}-bill-a1`, `${P}-bill-a2`, `${P}-bill-u1`])
    expect(body).toEqual(before.dbBilling)
    const none = await call(await dbBilling(request('/api/meta/db-billing', 'seller-none')))
    expect(none.body).toEqual({ empty: true, accounts: [] })
  })

  it('db-billing: another store\'s project, account or staff filter is 403 for a seller and works for admin', async () => {
    expect((await dbBilling(request(`/api/meta/db-billing?projectId=${PROJECT_B}`, 'seller-a'))).status).toBe(403)
    const other = await call(await dbBilling(request(`/api/meta/db-billing?accountId=${P}-accdb-b`, 'seller-a')))
    expect(other.body.billings).toEqual([])
    const admin = await call(await dbBilling(request(`/api/meta/db-billing?projectId=${PROJECT_B}`, 'admin')))
    expect(ids(admin.body.billings)).toEqual([`${P}-bill-b1`])
    const all = await call(await dbBilling(request('/api/meta/db-billing', 'admin')))
    expect(ids(all.body.billings)).toEqual([`${P}-bill-a1`, `${P}-bill-a2`, `${P}-bill-b1`, `${P}-bill-u1`])
  })

  it('accounts list is scoped for a seller and complete for admin; a seller still cannot write', async () => {
    const seller = await call(await metaAccounts(request('/api/meta/accounts', 'seller-a')))
    expect(seller.body).toEqual(before.metaAccounts)
    expect((await call(await metaAccounts(request('/api/meta/accounts', 'seller-none')))).body).toEqual([])
    const admin = await call(await metaAccounts(request('/api/meta/accounts', 'admin')))
    expect(ids(admin.body)).toEqual([`${P}-accdb-a`, `${P}-accdb-b`, `${P}-accdb-c`, `${P}-accdb-u`])
    const text = JSON.stringify(seller.body)
    expect(text).not.toContain('accessToken')
  })

  it('reserve overview lists a seller\'s accounts only, and a refresh touches only those', async () => {
    const overviewBody = await call(await reserveOverview(request('/api/meta/reserve', 'seller-a')))
    expect(overviewBody.body.accounts.map((a: { id: string }) => a.id).sort()).toEqual([`${P}-accdb-a`, `${P}-accdb-u`])
    const refused = await refreshReserve(request('/api/meta/reserve', 'seller-a', { method: 'POST', body: { accountId: `${P}-accdb-b` } }))
    expect(refused.status).toBe(403)
    expect(mocks.refreshReserveData).not.toHaveBeenCalled()
    mocks.refreshReserveData.mockImplementation(async (id: string) => ({ refreshed: [id], errors: [] }))
    const own = await call(await refreshReserve(request('/api/meta/reserve', 'seller-a', { method: 'POST', body: {} })))
    expect(own.status).toBe(200)
    expect(mocks.refreshReserveData.mock.calls.map(c => c[0]).sort()).toEqual([`${P}-accdb-a`, `${P}-accdb-u`])
    mocks.refreshReserveData.mockClear()
    await refreshReserve(request('/api/meta/reserve', 'admin', { method: 'POST', body: {} }))
    expect(mocks.refreshReserveData).toHaveBeenCalledTimes(1)
    expect(mocks.refreshReserveData.mock.calls[0][0]).toBeNull()
  })

  it('exchange rates are global: a seller may read them and may not change them', async () => {
    expect(canCallApi('SELLER', SELLER_FEATURES, '/api/meta/exchange-rates', 'GET')).toBe('ok')
    expect((await listRates()).status).toBe(200)
    const rateCount = await prisma.metaExchangeRate.count()
    expect((await addRate(request('/api/meta/exchange-rates', 'seller-writer', { method: 'POST', body: { effectiveDate: '2026-10-01', rate: 25000 } }))).status).toBe(403)
    expect((await removeRate(request('/api/meta/exchange-rates', 'seller-writer', { method: 'DELETE', body: { id: 'x' } }))).status).toBe(403)
    expect(await prisma.metaExchangeRate.count()).toBe(rateCount)
  })
})

describe('/api/finance/other-bills', () => {
  it('lists a seller\'s project bills and the project-less ones, with only its projects in the picker', async () => {
    const { body } = await call(await listBills(request('/api/finance/other-bills', 'seller-a')))
    expect(without(body, 'stats')).toEqual(without(before.otherBills, 'stats'))
    expect(body.stats).toEqual(before.otherBills.stats)
    expect(ids(body.bills)).toEqual([`${P}-obill-a`, `${P}-obill-u`])
    expect(ids(body.projects)).toEqual([PROJECT_A])
    expect((await call(await listBills(request('/api/finance/other-bills', 'seller-none')))).body.bills).toEqual([])
  })

  it('403 on another store\'s project filter, creating a bill for it, and deleting its bill', async () => {
    expect((await listBills(request(`/api/finance/other-bills?projectId=${PROJECT_B}`, 'seller-a'))).status).toBe(403)
    const input = { vendor: `${P}-new`, category: 'OTHER', amount: 5, currency: 'USD', paidAt: '2026-10-05', paymentMethod: 'OTHER' }
    expect((await createBill(request('/api/finance/other-bills', 'seller-a', { method: 'POST', body: { ...input, projectId: PROJECT_B } }))).status).toBe(403)
    expect(await prisma.otherBill.count({ where: { vendor: `${P}-new` } })).toBe(0)
    expect((await deleteBill(request(`/api/finance/other-bills/${P}-obill-b`, 'seller-a', { method: 'DELETE' }), { params: { id: `${P}-obill-b` } })).status).toBe(403)
    expect(await prisma.otherBill.count({ where: { id: `${P}-obill-b` } })).toBe(1)
  })

  it('a seller creates and deletes a bill of its own project; admin sees every bill', async () => {
    const input = { vendor: `${P}-new`, category: 'OTHER', amount: 5, currency: 'USD', paidAt: '2026-10-05', paymentMethod: 'OTHER', projectId: PROJECT_A }
    const created = await call(await createBill(request('/api/finance/other-bills', 'seller-a', { method: 'POST', body: input })))
    expect(created.status).toBe(200)
    const billId = created.body.bill.id
    expect((await deleteBill(request(`/api/finance/other-bills/${billId}`, 'seller-a', { method: 'DELETE' }), { params: { id: billId } })).status).toBe(200)
    const all = await call(await listBills(request('/api/finance/other-bills', 'admin')))
    expect(ids(all.body.bills)).toEqual([`${P}-obill-a`, `${P}-obill-b`, `${P}-obill-u`])
    const narrowed = await call(await listBills(request(`/api/finance/other-bills?projectId=${PROJECT_B}`, 'admin')))
    expect(ids(narrowed.body.bills)).toEqual([`${P}-obill-b`])
  })
})

describe('/api/marketing/niche-performance', () => {
  it('a seller gets its own project by default, 403 on another store\'s, and admin may pick any', async () => {
    const own = await call(await nichePerformance(request('/api/marketing/niche-performance?period=custom&from=2026-10-01&to=2026-10-31', 'seller-a')))
    expect(own.status).toBe(200)
    expect(own.body.project).toEqual({ id: PROJECT_A, name: NAME_A })
    expect((await nichePerformance(request(`/api/marketing/niche-performance?projectId=${PROJECT_B}`, 'seller-a'))).status).toBe(403)
    expect((await nichePerformance(request(`/api/marketing/niche-performance?projectId=${PROJECT_B}`, 'admin'))).status).toBe(200)
    expect((await nichePerformance(request('/api/marketing/niche-performance', 'seller-none'))).status).toBe(404)
  })
})

describe('/api/sync/daily', () => {
  const lastRun = {
    startedAt: '2026-11-05T08:00:00.000Z',
    finishedAt: '2026-11-05T08:05:00.000Z',
    ok: false,
    steps: {
      payouts: {
        synced_payouts: 40,
        store: { id: 'x', shop: SHOP_B },
        stores: [
          { storeId: 'fsf-store-a', shop: SHOP_A, ok: true },
          { storeId: 'fsf-store-b', shop: SHOP_B, ok: false, error: 'beta token expired' },
        ],
      },
      billing: {
        status: 'COMPLETED_WITH_ERRORS',
        totals: { synced: 12 },
        accountErrors: [{ account: `${ACC_B} name`, error: 'beta rate limit' }, { account: `${ACC_A} name`, error: 'alpha rate limit' }],
      },
      reserve: {
        refreshed: [ACC_A, ACC_B],
        errors: [{ accountId: ACC_B, message: 'beta reserve failed' }],
      },
      snapshot: { periodMonth: '2026-10', closed: [NAME_A, NAME_B], errors: [{ project: NAME_B, error: 'beta snapshot failed' }] },
    },
  }

  beforeEach(async () => {
    await prisma.appSetting.upsert({ where: { key: DAILY_KEY }, create: { key: DAILY_KEY, value: JSON.stringify(lastRun) }, update: { value: JSON.stringify(lastRun) } })
  })

  it('shows a seller the run for its own stores and accounts, with nothing about the others', async () => {
    const { status, body } = await call(await dailySyncStatus(request('/api/sync/daily', 'seller-a')))
    expect(status).toBe(200)
    const text = JSON.stringify(body)
    for (const leak of [SHOP_B, ACC_B, NAME_B, 'beta']) expect(text).not.toContain(leak)
    expect(body.last.steps.payouts.stores).toEqual([{ storeId: 'fsf-store-a', shop: SHOP_A, ok: true }])
    expect(body.last.steps.billing.accountErrors).toEqual([{ account: `${ACC_A} name`, error: 'alpha rate limit' }])
    expect(body.last.steps.reserve).toEqual({ refreshed: [ACC_A], errors: [] })
    expect(body.last.steps.snapshot).toEqual({ periodMonth: '2026-10', closed: [NAME_A], errors: [] })
    expect(body.last.ok).toBe(true)
    expect(body.canRun).toBe(false)
    expect(body.schedule).toBeTruthy()
  })

  it('shows admin the whole run and lets it start one', async () => {
    const { body } = await call(await dailySyncStatus(request('/api/sync/daily', 'admin')))
    expect(body.last).toEqual(lastRun)
    expect(body.canRun).toBe(true)
  })

  it('a seller cannot start the all-store run', async () => {
    expect((await runDailySync(request('/api/sync/daily', 'seller-a', { method: 'POST' }))).status).toBe(403)
  })
})

describe('/api/staff', () => {
  it('a seller gets staff assigned to its projects, with those assignments only; same output as before for one store', async () => {
    const { body } = await call(await listStaff(request('/api/staff', 'seller-a')))
    expect(body).toEqual(before.staff)
    const ab = await call(await listStaff(request('/api/staff', 'seller-ab')))
    expect(ids(ab.body)).toEqual([`${P}-staff-a`, `${P}-staff-ab`, `${P}-staff-b`])
    const b = await call(await listStaff(request('/api/staff', 'seller-b')))
    expect(ids(b.body)).toEqual([`${P}-staff-ab`, `${P}-staff-b`])
    const shared = b.body.find((s: { id: string }) => s.id === `${P}-staff-ab`)
    expect(shared.assignments.map((a: { projectId: string }) => a.projectId)).toEqual([PROJECT_B])
    expect((await call(await listStaff(request('/api/staff', 'seller-none')))).body).toEqual([])
  })

  it('admin gets everyone, and a seller holding setup_hr still cannot add or remove staff', async () => {
    const admin = await call(await listStaff(request('/api/staff', 'admin')))
    expect(admin.body.length - baselineStaff).toBe(3)
    expect((await createStaff(request('/api/staff', 'seller-writer', { method: 'POST', body: { name: `${P}-new` } }))).status).toBe(403)
    expect((await deleteStaff(request('/api/staff', 'seller-writer', { method: 'DELETE', body: { id: `${P}-staff-b` } }))).status).toBe(403)
    expect(await prisma.staff.count({ where: { id: `${P}-staff-b` } })).toBe(1)
  })
})

describe('/api/auto-sync', () => {
  const okOrders = { ok: true, json: async () => ({ totalSynced: 3, withUnmappedSku: 1, errors: [], stores: [] }) }

  it('a seller\'s run syncs only its stores\' orders and its accounts\' insights, and keeps its own last result', async () => {
    fetchSpy.mockResolvedValue(okOrders)
    const run = await call(await runAutoSync(request('/api/auto-sync', 'seller-a', { method: 'POST' })))
    expect(run.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/shopify/orders/sync')
    expect(JSON.parse(init.body)).toEqual({ storeId: fx.storeA })
    expect(mocks.syncMetaInsights.mock.calls.map(c => c[0].accountId).sort()).toEqual([`${P}-accdb-a`, `${P}-accdb-u`])
    expect(mocks.syncMetaCampaignInsights.mock.calls.map(c => c[0].accountId).sort()).toEqual([`${P}-accdb-a`, `${P}-accdb-u`])
    expect(run.body.result.orders).toMatchObject({ totalSynced: 3 })

    const mine = await call(await autoSyncStatus(request('/api/auto-sync', 'seller-a')))
    expect(mine.body.lastResult.orders.totalSynced).toBe(3)
    const other = await call(await autoSyncStatus(request('/api/auto-sync', 'seller-b')))
    expect(other.body.lastResult).toBeNull()
    const none = await call(await autoSyncStatus(request('/api/auto-sync', 'seller-none')))
    expect(none.body.lastResult).toBeNull()
  })

  it('a seller of two stores syncs each store by itself and adds the counts', async () => {
    fetchSpy.mockResolvedValue(okOrders)
    const run = await call(await runAutoSync(request('/api/auto-sync', 'seller-ab', { method: 'POST' })))
    expect(fetchSpy.mock.calls.map(c => JSON.parse(c[1].body).storeId).sort()).toEqual([fx.storeA, fx.storeB].sort())
    expect(run.body.result.orders.totalSynced).toBe(6)
  })

  it('a seller with no store syncs nothing', async () => {
    const run = await call(await runAutoSync(request('/api/auto-sync', 'seller-none', { method: 'POST' })))
    expect(run.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mocks.syncMetaInsights).not.toHaveBeenCalled()
  })

  it('admin\'s run is the one it always was: one order sync for every store and one insights sync for every account', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ totalSynced: 9, withUnmappedSku: 0, errors: [], stores: [] }) })
    const run = await call(await runAutoSync(request('/api/auto-sync', 'admin', { method: 'POST' })))
    expect(run.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][1].body).toBeUndefined()
    expect(mocks.syncMetaInsights).toHaveBeenCalledWith()
    const saved = await call(await autoSyncStatus(request('/api/auto-sync', 'admin')))
    expect(saved.body.lastResult.orders.totalSynced).toBe(9)
    const seller = await call(await autoSyncStatus(request('/api/auto-sync', 'seller-a')))
    expect(seller.body.lastResult.orders.totalSynced).toBe(3)
  })
})

describe('the seller allow-list', () => {
  it('holds exactly the finance routes this change filters', () => {
    for (const prefix of [
      '/api/overview', '/api/projects', '/api/shopify/db-payouts', '/api/shopify/payouts', '/api/meta/db-billing', '/api/meta/accounts',
      '/api/meta/reserve', '/api/meta/exchange-rates', '/api/finance/other-bills', '/api/marketing/niche-performance', '/api/marketing/niches',
      '/api/sync/daily', '/api/staff', '/api/auto-sync',
    ]) expect(SELLER_API_PREFIXES).toContain(prefix)
    for (const stillDenied of ['/api/meta/sync', '/api/meta/import', '/api/meta/verify-spend', '/api/finance/fulfillment', '/api/projects-x']) {
      expect(SELLER_API_PREFIXES.some(p => stillDenied === p || stillDenied.startsWith(`${p}/`))).toBe(false)
    }
  })
})
