import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { canCallApi } from '@/lib/api-access'
import { ordersScopeFixture, call, SELLER_FEATURES } from './helpers/orders-scope-fixture'
import {
  ACC_B, NAME_A, NAME_B, P as FP, PROJECT_A, PROJECT_B, SHOP_B, cleanupFinanceFixture, seedFinanceFixture, type Fixture,
} from './helpers/finance-scope-fixture'
import { apiPathsOfPages } from './helpers/page-api-calls'
import { GET as listStores } from '@/app/api/stores/route'
import { GET as listSuppliers } from '@/app/api/suppliers/route'
import { GET as overview } from '@/app/api/overview/route'
import { GET as autoSync } from '@/app/api/auto-sync/route'
import { GET as listProjects } from '@/app/api/projects/route'
import { GET as analytics } from '@/app/api/projects/analytics/route'
import { GET as snapshots } from '@/app/api/projects/[id]/snapshots/route'
import { GET as profitChart } from '@/app/api/projects/profit-chart/route'
import { GET as dbBilling } from '@/app/api/meta/db-billing/route'
import { GET as dailySync } from '@/app/api/sync/daily/route'
import { GET as reserve } from '@/app/api/meta/reserve/route'
import { GET as otherBills } from '@/app/api/finance/other-bills/route'
import { GET as nichePerformance } from '@/app/api/marketing/niche-performance/route'
import { GET as niches } from '@/app/api/marketing/niches/route'
import { GET as listOrders } from '@/app/api/fulfillment/orders/route'
import { GET as plSummary } from '@/app/api/fulfillment/pl-summary/route'
import { GET as statusCounts } from '@/app/api/fulfillment/status-counts/route'
import { GET as taskFix } from '@/app/api/fulfillment/task-fix/route'

// One seller with the features of the seller account on production and the first store of each of two data sets:
// every call a page makes when it opens must answer 200 with nothing of the second store of either set.
const fx = ordersScopeFixture('spw')
const WALKER = `${FP}-walker@test.local`
let finance: Fixture
let token = ''

const FINANCE_B_MARKERS = [NAME_B, SHOP_B, PROJECT_B, `${FP}-store-b`, ACC_B, `${FP}-bill-b`, `${FP}-staff-b`, `${FP}-order-b`, `${FP}-obill-b`, `"${FP}-b"`]
const B_MARKERS = [...FINANCE_B_MARKERS, ...fx.markers('b')]

const get = (url: string) => new NextRequest(`http://localhost${url}`, { headers: { cookie: `${AUTH_COOKIE}=${token}` } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await cleanupFinanceFixture()
  finance = await seedFinanceFixture({ second: true })
  await fx.seed()
  await prisma.appUser.deleteMany({ where: { email: WALKER } })
  const row = await prisma.appUser.create({
    data: { name: 'walker', email: WALKER, role: 'SELLER', permissions: JSON.stringify(SELLER_FEATURES), storeAccess: { create: [{ storeId: finance.storeA }, { storeId: fx.storeId('a') }] } },
  })
  token = await signToken({ userId: row.id, email: WALKER, name: 'walker', role: 'SELLER', permissions: SELLER_FEATURES, tv: row.tokenVersion })
})

afterAll(async () => {
  await prisma.appUser.deleteMany({ where: { email: WALKER } })
  await fx.cleanup()
  await cleanupFinanceFixture()
})

type OnLoad = { page: string; label: string; run: () => Promise<Response>; shows?: string[] }

const ON_LOAD: OnLoad[] = [
  // The store filter (use-store-filter.ts) asks for the stores when Overview, Orders and Need To Fix open.
  ...['/', '/orders', '/task-fix'].map(page => ({ page, label: 'GET /api/stores', run: async () => listStores(get('/api/stores')), shows: [NAME_A, fx.projectName('a')] })),
  { page: '/', label: 'GET /api/overview', run: async () => overview(get('/api/overview?period=all')), shows: [NAME_A] },
  { page: '/projects', label: 'GET /api/auto-sync', run: async () => autoSync(get('/api/auto-sync')) },
  { page: '/projects', label: 'GET /api/projects', run: async () => listProjects(get('/api/projects')), shows: [NAME_A, fx.projectName('a')] },
  { page: '/projects', label: 'GET /api/projects/analytics', run: async () => analytics(get(`/api/projects/analytics?projectId=${PROJECT_A}`)), shows: [NAME_A] },
  { page: '/projects', label: 'GET /api/projects/:id/snapshots', run: async () => snapshots(get(`/api/projects/${PROJECT_A}/snapshots`), { params: { id: PROJECT_A } }) },
  { page: '/projects', label: 'GET /api/projects/profit-chart', run: async () => profitChart(get(`/api/projects/profit-chart?projectId=${PROJECT_A}&period=this-month`)) },
  { page: '/finance/meta', label: 'GET /api/meta/db-billing', run: async () => dbBilling(get('/api/meta/db-billing')) },
  { page: '/finance/meta', label: 'GET /api/sync/daily', run: async () => dailySync(get('/api/sync/daily')) },
  { page: '/finance/meta', label: 'GET /api/meta/reserve', run: async () => reserve(get('/api/meta/reserve?horizon=30')) },
  { page: '/finance/other-bills', label: 'GET /api/finance/other-bills?category=SUBSCRIPTION', run: async () => otherBills(get('/api/finance/other-bills?month=2026-10&category=SUBSCRIPTION')) },
  { page: '/finance/other-bills', label: 'GET /api/finance/other-bills', run: async () => otherBills(get('/api/finance/other-bills?month=2026-10')) },
  { page: '/marketing/niche-performance', label: 'GET /api/marketing/niche-performance', run: async () => nichePerformance(get(`/api/marketing/niche-performance?projectId=${PROJECT_A}`)) },
  { page: '/marketing/niche-performance', label: 'GET /api/marketing/niches', run: async () => niches() },
  { page: '/orders', label: 'GET /api/suppliers', run: async () => listSuppliers(get('/api/suppliers')) },
  { page: '/orders', label: 'GET /api/fulfillment/orders', run: async () => listOrders(get('/api/fulfillment/orders?page=1&pageSize=50')), shows: [fx.orderNumber('a', 1)] },
  { page: '/orders', label: 'GET /api/fulfillment/pl-summary', run: async () => plSummary(get('/api/fulfillment/pl-summary')) },
  { page: '/orders', label: 'GET /api/fulfillment/status-counts', run: async () => statusCounts(get('/api/fulfillment/status-counts')) },
  { page: '/task-fix', label: 'GET /api/fulfillment/task-fix', run: async () => taskFix(get('/api/fulfillment/task-fix')), shows: [fx.orderNumber('a', 1)] },
  { page: '/task-fix', label: 'GET /api/fulfillment/task-fix?done=1', run: async () => taskFix(get('/api/fulfillment/task-fix?done=1')), shows: [fx.orderNumber('a', 1)] },
]

describe('every call a page makes when it opens answers the seller with its own stores only', () => {
  it.each(ON_LOAD)('$page: $label', async ({ run, shows }) => {
    const { status, body } = await call(await run())
    expect(status).toBe(200)
    const text = JSON.stringify(body)
    expect(B_MARKERS.filter(m => text.includes(m))).toEqual([])
    for (const marker of shows ?? []) expect(text).toContain(marker)
  })

  it('the seller has two stores and the second store of each set holds rows, so a clean answer proves something', async () => {
    const { body } = await call(await overview(get('/api/overview?period=all')))
    expect([...body.stores].sort()).toEqual([NAME_A, fx.projectName('a')].sort())
    expect(await prisma.order.count({ where: { storeId: { in: [finance.storeB, fx.storeId('b')] } } })).toBeGreaterThan(4)
    expect(await prisma.payout.count({ where: { storeId: finance.storeB } })).toBeGreaterThan(0)
  })
})

type Check = [method: string, path: string, expected: 'ok' | 'forbidden']

// Each /api path found in the pages a seller can open (see apiPathsOfPages), with the calls the page makes to it and what the seller gets.
const CLASSIFIED: Record<string, Check[]> = {
  // session and routes that carry no store data
  '/api/auth/logout': [['POST', '/api/auth/logout', 'ok']],
  '/api/auth/me': [['GET', '/api/auth/me', 'ok']],
  '/api/stores': [['GET', '/api/stores', 'ok']],
  '/api/spy/ad-domains': [['GET', '/api/spy/ad-domains', 'ok'], ['POST', '/api/spy/ad-domains', 'ok'], ['PATCH', '/api/spy/ad-domains', 'ok'], ['DELETE', '/api/spy/ad-domains', 'ok']],
  '/api/spy/ads': [['GET', '/api/spy/ads', 'ok']],
  '/api/spy/ads/:p': [['GET', '/api/spy/ads/a1', 'ok']],
  '/api/spy/best-sellers': [['GET', '/api/spy/best-sellers', 'ok']],
  '/api/spy/cron': [['GET', '/api/spy/cron', 'ok'], ['POST', '/api/spy/cron', 'forbidden']],
  '/api/spy/media/:p': [['GET', '/api/spy/media/a1', 'ok']],
  '/api/spy/niches': [['GET', '/api/spy/niches', 'ok']],
  '/api/spy/pages': [['GET', '/api/spy/pages', 'ok'], ['POST', '/api/spy/pages', 'ok'], ['PATCH', '/api/spy/pages', 'ok']],
  '/api/spy/presumptions': [['GET', '/api/spy/presumptions', 'ok']],
  '/api/spy/product-types': [['GET', '/api/spy/product-types', 'ok']],
  '/api/spy/products': [['GET', '/api/spy/products', 'ok']],
  '/api/spy/scan': [['POST', '/api/spy/scan', 'ok']],
  '/api/spy/scan-ads': [['POST', '/api/spy/scan-ads', 'ok']],
  '/api/spy/scan-quota': [['GET', '/api/spy/scan-quota', 'ok']],
  '/api/spy/stores': [['GET', '/api/spy/stores', 'ok'], ['POST', '/api/spy/stores', 'ok'], ['DELETE', '/api/spy/stores', 'ok']],
  '/api/tools/creative/file/:p/:p': [['GET', '/api/tools/creative/file/j1/out.png', 'ok']],
  '/api/tools/creative/jobs': [['GET', '/api/tools/creative/jobs', 'ok'], ['POST', '/api/tools/creative/jobs', 'ok']],
  '/api/tools/creative/jobs/:p': [['GET', '/api/tools/creative/jobs/j1', 'ok'], ['DELETE', '/api/tools/creative/jobs/j1', 'ok']],
  '/api/tools/creative/models': [['GET', '/api/tools/creative/models', 'ok']],
  '/api/tools/creative/settings': [['GET', '/api/tools/creative/settings', 'ok'], ['POST', '/api/tools/creative/settings', 'forbidden']],
  '/api/fulfillment/crawler': [['POST', '/api/fulfillment/crawler', 'ok']],
  // routes that filter by store (Task 8 and this task); the ones a page calls when it opens are run above
  '/api/overview': [['GET', '/api/overview', 'ok']],
  '/api/auto-sync': [['GET', '/api/auto-sync', 'ok'], ['POST', '/api/auto-sync', 'ok']],
  '/api/projects': [['GET', '/api/projects', 'ok']],
  '/api/projects/:p/snapshots': [['GET', '/api/projects/p1/snapshots', 'ok'], ['PATCH', '/api/projects/p1/snapshots', 'forbidden']],
  '/api/projects/analytics': [['GET', '/api/projects/analytics', 'ok']],
  '/api/projects/profit-chart': [['GET', '/api/projects/profit-chart', 'ok']],
  '/api/projects/snapshot/backfill': [['POST', '/api/projects/snapshot/backfill', 'forbidden']],
  '/api/meta/db-billing': [['GET', '/api/meta/db-billing', 'ok']],
  '/api/meta/reserve': [['GET', '/api/meta/reserve', 'ok'], ['POST', '/api/meta/reserve', 'forbidden']],
  '/api/sync/daily': [['GET', '/api/sync/daily', 'ok']],
  '/api/finance/other-bills': [['GET', '/api/finance/other-bills', 'ok'], ['POST', '/api/finance/other-bills', 'forbidden']],
  '/api/finance/other-bills/:p': [['DELETE', '/api/finance/other-bills/b1', 'forbidden']],
  '/api/marketing/niche-performance': [['GET', '/api/marketing/niche-performance', 'ok']],
  '/api/marketing/niches': [['GET', '/api/marketing/niches', 'ok'], ['POST', '/api/marketing/niches', 'ok']],
  '/api/fulfillment/orders': [['GET', '/api/fulfillment/orders', 'ok']],
  '/api/fulfillment/orders/:p/recheck': [['POST', '/api/fulfillment/orders/o1/recheck', 'ok']],
  '/api/fulfillment/orders/:p/status': [['PATCH', '/api/fulfillment/orders/o1/status', 'ok']],
  '/api/fulfillment/orders/bulk-status': [['POST', '/api/fulfillment/orders/bulk-status', 'ok']],
  '/api/fulfillment/orders/line-cost': [['PATCH', '/api/fulfillment/orders/line-cost', 'ok']],
  '/api/fulfillment/pl-summary': [['GET', '/api/fulfillment/pl-summary', 'ok']],
  '/api/fulfillment/status-counts': [['GET', '/api/fulfillment/status-counts', 'ok']],
  '/api/fulfillment/task-fix': [['GET', '/api/fulfillment/task-fix', 'ok']],
  '/api/fulfillment/task-fix/fix': [['POST', '/api/fulfillment/task-fix/fix', 'ok']],
  '/api/shopify/orders/sync': [['POST', '/api/shopify/orders/sync', 'ok']],
  '/api/design-studio/tasks/:p': [['PUT', '/api/design-studio/tasks/K1/artwork', 'ok']],
  // "Mở lại để sửa" on a sent line is a task action of the line's store, like the one above (requireLineScope).
  '/api/design-studio/lines/:p/reopen': [['POST', '/api/design-studio/lines/l1/reopen', 'ok']],
  // The shared supplier list the order filters use: no store data and no apiKey (Prisma omits it), read-only for a seller, sub-routes closed.
  '/api/suppliers': [['GET', '/api/suppliers', 'ok'], ['POST', '/api/suppliers', 'forbidden']],
  // Intentionally denied. Shared factory data and the all-store parts are not store data a seller may read.
  '/api/design-studio/products/:p': [['GET', '/api/design-studio/products/k1', 'forbidden']],
  '/api/fulfillment/:p/orders/:p': [
    ['GET', '/api/fulfillment/pgprints/orders/o1/preview', 'forbidden'],
    ['POST', '/api/fulfillment/pgprints/orders/o1/push', 'forbidden'],
  ],
  '/api/projects/seller-commission': [['GET', '/api/projects/seller-commission', 'forbidden']],
  '/api/meta/sync-insights': [['POST', '/api/meta/sync-insights', 'forbidden']],
  '/api/meta/sync-campaign-insights': [['POST', '/api/meta/sync-campaign-insights', 'forbidden']],
  '/api/marketing/campaign-overrides': [['PUT', '/api/marketing/campaign-overrides', 'forbidden']],
  // Billing is read-only for a seller (SELLER_READ_ONLY_PREFIXES): its sync and file import stay closed. The pages draw no button for
  // them for a seller (useSellerReadOnly) and the Meta Billing page does not poll GET /api/meta/sync for one; the paths stay listed
  // here because the page code still names them, and the 403 is what a seller would get if it called them.
  '/api/meta/sync': [['GET', '/api/meta/sync', 'forbidden'], ['POST', '/api/meta/sync', 'forbidden']],
  '/api/meta/import': [['POST', '/api/meta/import', 'forbidden']],
}

describe('the /api paths of the pages a seller opens', () => {
  const pages = apiPathsOfPages('SELLER', SELLER_FEATURES)

  it('open the pages of the production seller: Orders & P/L and Product Crawler need no Fulfillment Dashboard, CSV Export is not among them', () => {
    expect(pages.map(p => p.route)).toEqual([
      '/', '/finance/meta', '/finance/other-bills', '/fulfillment/crawler', '/fulfillment/orders', '/marketing/niche-performance', '/orders',
      '/projects', '/projects/seller-profit', '/task-fix', '/tools/creative', '/tools/spy-idea', '/tools/spy-idea/ads/[id]', '/tools/spy-idea/niches',
      '/tools/spy-idea/product-types', '/tools/spy-idea/sources',
    ])
  })

  it('name no /api path that is not classified here', () => {
    const named = Array.from(new Set(pages.flatMap(p => p.paths))).sort()
    expect(named.filter(path => !(path in CLASSIFIED))).toEqual([])
    expect(Object.keys(CLASSIFIED).filter(path => !named.includes(path))).toEqual([])
  })

  it.each(Object.entries(CLASSIFIED).flatMap(([key, checks]) => checks.map(([method, path, expected]) => ({ key, method, path, expected }))))(
    '$method $path is $expected for the seller',
    ({ method, path, expected }) => {
      expect(canCallApi('SELLER', SELLER_FEATURES, path, method)).toBe(expected)
    },
  )
})
