import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const shopify = vi.hoisted(() => ({
  fetchAllPayouts: vi.fn(),
  fetchBalance: vi.fn(),
  fetchBankAccounts: vi.fn(),
  fetchPayoutTransactions: vi.fn(),
}))

vi.mock('@/lib/shopify', () => shopify)

import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { saveStoreCredential } from '@/lib/store-connections'
import { SHOPIFY_PAYOUT_START_DATE } from '@/lib/shopify-payout-policy'
import { GET as dbPayouts } from '@/app/api/shopify/db-payouts/route'
import { GET as livePayouts } from '@/app/api/shopify/payouts/route'
import { GET as payoutDetail } from '@/app/api/shopify/payouts/[id]/route'

const SHOP_A = 'spr-a.myshopify.com'
const SHOP_B = 'spr-b.myshopify.com'
const BANK_A = 'gid://shopify/ShopifyPaymentsBankAccount/spr-a'
const BANK_B = 'gid://shopify/ShopifyPaymentsBankAccount/spr-b'
const SUPER_EMAIL = 'spr-super@test.local'
let storeA = ''
let storeB = ''
let session = ''

const req = (path: string) => new NextRequest(`http://test${path}`, { headers: { cookie: `${AUTH_COOKIE}=${session}` } })

async function cleanup() {
  await prisma.appUser.deleteMany({ where: { email: SUPER_EMAIL } })
  const stores = await prisma.shopifyStore.findMany({ where: { shop: { in: [SHOP_A, SHOP_B] } }, select: { id: true } })
  const ids = stores.map(s => s.id)
  await prisma.payout.deleteMany({ where: { storeId: { in: ids } } })
  await prisma.bankAccount.deleteMany({ where: { storeId: { in: ids } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { in: ids } } })
}

const payout = (id: number, storeId: string, date: string, amount: number, bank: string) => prisma.payout.create({ data: {
  id, storeId, status: 'paid', date, currency: 'USD', amount, chargesFeeAmount: 0, chargesGrossAmount: amount, refundsFeeAmount: 0,
  refundsGrossAmount: 0, adjustmentsFeeAmount: 0, adjustmentsGrossAmount: 0, bankAccountShopifyId: bank,
} })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await cleanup()
  const user = await prisma.appUser.create({ data: { name: 'spr super', email: SUPER_EMAIL, role: 'SUPERADMIN', permissions: JSON.stringify(DEFAULT_ROLE_PERMISSIONS.SUPERADMIN) } })
  session = await signToken({ userId: user.id, email: SUPER_EMAIL, name: user.name, role: 'SUPERADMIN', permissions: DEFAULT_ROLE_PERMISSIONS.SUPERADMIN, tv: user.tokenVersion })
  // Store B synced last, which is what made the old route pick it.
  storeA = (await prisma.shopifyStore.create({ data: {
    shop: SHOP_A, connectedAt: new Date('2000-01-01'), lastSyncAt: new Date('2026-11-01'), currentBalance: 11.11, currentBalanceCurrency: 'USD',
  } })).id
  storeB = (await prisma.shopifyStore.create({ data: {
    shop: SHOP_B, connectedAt: new Date('2000-01-02'), lastSyncAt: new Date('2026-11-05'), currentBalance: 22.22, currentBalanceCurrency: 'EUR', payoutStartDate: '2026-10-06',
  } })).id
  await saveStoreCredential(storeA, { authMode: 'TOKEN', accessToken: 'token-spr-a' })
  await saveStoreCredential(storeB, { authMode: 'TOKEN', accessToken: 'token-spr-b' })
  await prisma.bankAccount.create({ data: { id: BANK_A, storeId: storeA, accountNumber: '****1111', bankName: 'Bank A', country: 'US', currency: 'USD', status: 'VALIDATED' } })
  await prisma.bankAccount.create({ data: { id: BANK_B, storeId: storeB, accountNumber: '****2222', bankName: 'Bank B', country: 'DE', currency: 'EUR', status: 'VALIDATED' } })
  await payout(9_300_001, storeA, '2026-07-10', 100, BANK_A)
  await payout(9_300_002, storeA, '2026-03-01', 50, BANK_A)
  await payout(9_300_011, storeB, '2026-10-10', 7, BANK_B)
  await payout(9_300_012, storeB, '2026-09-01', 900, BANK_B)
})

beforeEach(() => {
  vi.clearAllMocks()
  shopify.fetchAllPayouts.mockResolvedValue([])
  shopify.fetchBalance.mockResolvedValue({ amount: '1.00', currency: 'USD' })
  shopify.fetchBankAccounts.mockResolvedValue([])
  shopify.fetchPayoutTransactions.mockResolvedValue([])
})

afterAll(async () => { await cleanup() })

describe('GET /api/shopify/db-payouts with two stores', () => {
  it('shows the first connected store, not the one that synced last: payouts, totals, balance, banks and start date are all its own', async () => {
    const body = await (await dbPayouts(req('/api/shopify/db-payouts'))).json()
    expect(body.payouts.map((p: { id: number }) => p.id)).toEqual([9_300_001, 9_300_002])
    expect(body.stats).toMatchObject({ total_payouts: 2, total_paid: 2, total_amount_paid: '150.00' })
    expect(body.balance).toEqual({ amount: '11.11', currency: 'USD' })
    expect(body.bankAccounts.map((b: { id: string }) => b.id)).toEqual([BANK_A])
    expect(body.bankSummary).toHaveLength(1)
    expect(body.payout_start_date).toBe(SHOPIFY_PAYOUT_START_DATE)
  })

  it('?storeId shows that store alone, from its own start date', async () => {
    const body = await (await dbPayouts(req(`/api/shopify/db-payouts?storeId=${storeB}&date_min=2026-01-01`))).json()
    expect(body.payouts.map((p: { id: number }) => p.id)).toEqual([9_300_011])
    expect(body.stats.total_amount_paid).toBe('7.00')
    expect(body.balance).toEqual({ amount: '22.22', currency: 'EUR' })
    expect(body.bankAccounts.map((b: { id: string }) => b.id)).toEqual([BANK_B])
    expect(body.payout_start_date).toBe('2026-10-06')
  })

  it('an unknown storeId is a 404, and an empty store answers empty with its own start date', async () => {
    expect((await dbPayouts(req('/api/shopify/db-payouts?storeId=nope'))).status).toBe(404)
    const body = await (await dbPayouts(req(`/api/shopify/db-payouts?storeId=${storeB}&date_min=2026-12-01`))).json()
    expect(body).toMatchObject({ empty: true, payout_start_date: '2026-10-06' })
  })
})

describe('GET /api/shopify/payouts (live) with two stores', () => {
  it("calls Shopify with the first connected store's token by default, and the named store's with ?storeId", async () => {
    const first = await (await livePayouts(req('/api/shopify/payouts'))).json()
    expect(shopify.fetchAllPayouts).toHaveBeenLastCalledWith({ shop: SHOP_A, token: 'token-spr-a' }, { date_min: SHOPIFY_PAYOUT_START_DATE, date_max: undefined })
    expect(first.payout_start_date).toBe(SHOPIFY_PAYOUT_START_DATE)

    const second = await (await livePayouts(req(`/api/shopify/payouts?storeId=${storeB}&date_min=2026-01-01`))).json()
    expect(shopify.fetchAllPayouts).toHaveBeenLastCalledWith({ shop: SHOP_B, token: 'token-spr-b' }, { date_min: '2026-10-06', date_max: undefined })
    expect(second.payout_start_date).toBe('2026-10-06')
  })

  it('answers 401 for a store that is not connected', async () => {
    await prisma.shopifyStoreCredential.delete({ where: { storeId: storeB } })
    try {
      expect((await livePayouts(req(`/api/shopify/payouts?storeId=${storeB}`))).status).toBe(401)
    } finally {
      await saveStoreCredential(storeB, { authMode: 'TOKEN', accessToken: 'token-spr-b' })
    }
  })
})

describe('GET /api/shopify/payouts/[id]', () => {
  const detail = (id: number | string, query = '') => payoutDetail(req(`/api/shopify/payouts/${id}${query}`), { params: { id: String(id) } })

  it("uses the payout's own store when it was synced", async () => {
    await detail(9_300_011)
    expect(shopify.fetchPayoutTransactions).toHaveBeenLastCalledWith({ shop: SHOP_B, token: 'token-spr-b' }, 9_300_011)
    await detail(9_300_001, `?storeId=${storeB}`)
    expect(shopify.fetchPayoutTransactions).toHaveBeenLastCalledWith({ shop: SHOP_A, token: 'token-spr-a' }, 9_300_001)
  })

  it('a payout never synced goes to ?storeId, else the first connected store', async () => {
    await detail(9_399_999, `?storeId=${storeB}`)
    expect(shopify.fetchPayoutTransactions).toHaveBeenLastCalledWith({ shop: SHOP_B, token: 'token-spr-b' }, 9_399_999)
    await detail(9_399_998)
    expect(shopify.fetchPayoutTransactions).toHaveBeenLastCalledWith({ shop: SHOP_A, token: 'token-spr-a' }, 9_399_998)
  })
})
