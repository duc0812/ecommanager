import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shopify = vi.hoisted(() => ({
  fetchAllPayouts: vi.fn(),
  fetchBalance: vi.fn(),
  fetchBankAccounts: vi.fn(),
}))

vi.mock('@/lib/shopify', () => shopify)

import { prisma } from '@/lib/db'
import { saveStoreCredential } from '@/lib/store-connections'
import { SHOPIFY_PAYOUT_START_DATE } from '@/lib/shopify-payout-policy'
import { PayoutSyncError, syncPayoutsForConnectedStores } from '@/lib/shopify-payouts-sync'
import { DAILY_SYNC_RESULT_KEY, monthToCloseOn, runDailySync, waitForMetaBillingSync } from './daily-sync'

function job(status: string) {
  return { status, totals: { pages: 1, activitiesScanned: 2, paidFound: 3, synced: 3 } } as any
}

describe('runDailySync', () => {
  beforeEach(async () => {
    await prisma.appSetting.deleteMany({ where: { key: DAILY_SYNC_RESULT_KEY } })
  })

  it('runs payouts, then Meta billing, then the reserve refresh, then the month close', async () => {
    const order: string[] = []
    const result = await runDailySync({
      payouts: async () => { order.push('payouts'); return { synced_payouts: 3 } },
      billing: async () => { order.push('billing'); return { status: 'COMPLETED' } },
      reserve: async () => { order.push('reserve'); return { refreshed: ['act_1'] } },
      snapshot: async () => { order.push('snapshot'); return { skipped: true } },
    })
    // Billing before the reserve refresh: the reserve reads thresholds off billing history,
    // and both hit the Meta API, which is rate limited.
    // The month close must come last: it snapshots what the three syncs just refreshed.
    expect(order).toEqual(['payouts', 'billing', 'reserve', 'snapshot'])
    expect(result.steps.payouts).toEqual({ synced_payouts: 3 })
    expect(result.ok).toBe(true)
  })

  it('keeps going when one step fails and records its error', async () => {
    const result = await runDailySync({
      payouts: async () => { throw new Error('Shopify token expired') },
      billing: async () => ({ status: 'COMPLETED' }),
      reserve: async () => ({ refreshed: [] }),
      snapshot: async () => ({ skipped: true }),
    })
    expect(result.steps.payouts).toEqual({ error: 'Shopify token expired' })
    expect(result.steps.billing).toEqual({ status: 'COMPLETED' })
    expect(result.ok).toBe(false)
  })

  it('saves the run so the page can show whether it last worked', async () => {
    await runDailySync({
      payouts: async () => ({ synced_payouts: 1 }),
      billing: async () => ({ status: 'COMPLETED_WITH_ERRORS' }),
      reserve: async () => ({ refreshed: ['act_1'] }),
      snapshot: async () => ({ skipped: true }),
    })
    const row = await prisma.appSetting.findUnique({ where: { key: DAILY_SYNC_RESULT_KEY } })
    const saved = JSON.parse(row!.value)
    expect(saved.steps.billing).toEqual({ status: 'COMPLETED_WITH_ERRORS' })
    expect(typeof saved.startedAt).toBe('string')
    expect(typeof saved.finishedAt).toBe('string')
  })
})

describe('runDailySync across stores', () => {
  beforeEach(async () => {
    await prisma.appSetting.deleteMany({ where: { key: DAILY_SYNC_RESULT_KEY } })
  })

  it('is not ok when a step reports a store that failed, and still keeps that step result', async () => {
    const stores = [{ storeId: 'a', shop: 'a.myshopify.com', ok: true }, { storeId: 'b', shop: 'b.myshopify.com', ok: false, error: 'token revoked' }]
    const result = await runDailySync({
      payouts: async () => ({ synced_payouts: 2, stores }),
      billing: async () => ({ status: 'COMPLETED' }),
      reserve: async () => ({ refreshed: [] }),
      snapshot: async () => ({ skipped: true }),
    })
    expect(result.ok).toBe(false)
    expect(result.steps.payouts).toEqual({ synced_payouts: 2, stores })
  })
})

describe('payout sync across stores', () => {
  const SHOPS = { a: 'ds-a.myshopify.com', b: 'ds-b.myshopify.com', c: 'ds-c.myshopify.com' }
  const ids: Record<string, string> = {}
  const payout = (id: number, date: string) => ({
    id, status: 'paid', date, currency: 'USD', amount: '10.00', bank_account_id: null,
    summary: { charges_fee_amount: '0', charges_gross_amount: '10', refunds_fee_amount: '0', refunds_gross_amount: '0', adjustments_fee_amount: '0', adjustments_gross_amount: '0' },
  })

  async function cleanup() {
    const stores = await prisma.shopifyStore.findMany({ where: { shop: { in: Object.values(SHOPS) } }, select: { id: true } })
    await prisma.payout.deleteMany({ where: { storeId: { in: stores.map(s => s.id) } } })
    await prisma.shopifyStore.deleteMany({ where: { id: { in: stores.map(s => s.id) } } })
  }

  beforeEach(async () => {
    await cleanup()
    for (const [key, shop] of Object.entries(SHOPS)) {
      const store = await prisma.shopifyStore.create({ data: { shop, ...(key === 'a' ? { payoutStartDate: '2026-07-01' } : {}), connectedAt: new Date(`2026-09-0${key === 'a' ? 1 : key === 'b' ? 2 : 3}`) } })
      ids[key] = store.id
      await saveStoreCredential(store.id, { authMode: 'TOKEN', accessToken: `token-${key}` })
    }
    shopify.fetchAllPayouts.mockReset()
    shopify.fetchBalance.mockReset().mockResolvedValue({ amount: '5.00', currency: 'USD' })
    shopify.fetchBankAccounts.mockReset().mockResolvedValue([])
  })
  afterEach(cleanup)

  const all = () => Object.values(ids)

  it("reads each store from its own start date, saves payouts under that store, and one store failing does not stop the next", async () => {
    shopify.fetchAllPayouts.mockImplementation(async (creds: { shop: string }) => {
      if (creds.shop === SHOPS.b) throw new Error('Shopify answered 401')
      return creds.shop === SHOPS.a ? [payout(9_200_001, '2026-07-10')] : [payout(9_200_002, '2026-03-01')]
    })
    const { results, merged } = await syncPayoutsForConnectedStores({ requestedDateMin: '2026-01-01', storeIds: all() })

    expect(results.map(r => [r.shop, r.ok])).toEqual([[SHOPS.a, true], [SHOPS.b, false], [SHOPS.c, true]])
    const asked = Object.fromEntries(shopify.fetchAllPayouts.mock.calls.map(c => [c[0].shop, c[1].date_min]))
    expect(asked).toEqual({ [SHOPS.a]: '2026-07-01', [SHOPS.b]: SHOPIFY_PAYOUT_START_DATE, [SHOPS.c]: SHOPIFY_PAYOUT_START_DATE })
    expect(merged).toMatchObject({ synced_payouts: 2, payout_start_date: '2026-07-01' })
    expect((await prisma.payout.findUnique({ where: { id: 9_200_001 } }))!.storeId).toBe(ids.a)
    expect((await prisma.payout.findUnique({ where: { id: 9_200_002 } }))!.storeId).toBe(ids.c)
    expect((await prisma.shopifyStore.findUnique({ where: { id: ids.b } }))!.lastError).toBe('Shopify answered 401')
    expect((await prisma.shopifyStore.findUnique({ where: { id: ids.a } }))!.lastError).toBeNull()
  })

  it("drops a payout dated before that store's own start date", async () => {
    shopify.fetchAllPayouts.mockResolvedValue([payout(9_200_003, '2026-06-30'), payout(9_200_004, '2026-07-01')])
    await syncPayoutsForConnectedStores({ storeIds: [ids.a] })
    expect(await prisma.payout.findUnique({ where: { id: 9_200_003 } })).toBeNull()
    expect(await prisma.payout.findUnique({ where: { id: 9_200_004 } })).not.toBeNull()
  })

  it('refuses a date range that ends before a store starts, before any store runs', async () => {
    await expect(syncPayoutsForConnectedStores({ dateMax: '2026-06-01', storeIds: [ids.a] })).rejects.toBeInstanceOf(PayoutSyncError)
    expect(shopify.fetchAllPayouts).not.toHaveBeenCalled()
    expect((await prisma.shopifyStore.findUnique({ where: { id: ids.a } }))!.lastError).toBeNull()
  })
})

describe('monthToCloseOn', () => {
  it('closes the month just ended when the run falls on the 1st in Vietnam', () => {
    // 2026-10-01 15:00 Asia/Ho_Chi_Minh is 08:00 UTC.
    expect(monthToCloseOn(new Date('2026-10-01T08:00:00Z'))).toBe('2026-09')
    expect(monthToCloseOn(new Date('2026-01-01T08:00:00Z'))).toBe('2025-12')
  })

  it('closes nothing on any other day', () => {
    expect(monthToCloseOn(new Date('2026-10-02T08:00:00Z'))).toBeNull()
    expect(monthToCloseOn(new Date('2026-10-31T08:00:00Z'))).toBeNull()
  })

  it('reads the date in Vietnam, not UTC', () => {
    // 2026-09-30 19:00 UTC is already 2026-10-01 02:00 in Vietnam.
    expect(monthToCloseOn(new Date('2026-09-30T19:00:00Z'))).toBe('2026-09')
    // 2026-10-01 16:00 UTC is 2026-10-01 23:00 in Vietnam: still the 1st.
    expect(monthToCloseOn(new Date('2026-10-01T16:00:00Z'))).toBe('2026-09')
    // 2026-10-01 17:30 UTC is 2026-10-02 00:30 in Vietnam: past it.
    expect(monthToCloseOn(new Date('2026-10-01T17:30:00Z'))).toBeNull()
  })
})

describe('waitForMetaBillingSync', () => {
  it('returns as soon as the job reaches a terminal status', async () => {
    const statuses = ['RUNNING', 'RUNNING', 'COMPLETED']
    let call = 0
    const result = await waitForMetaBillingSync({
      getJob: async () => job(statuses[Math.min(call++, statuses.length - 1)]),
      sleep: async () => {},
      now: () => 0,
    })
    expect(result).toEqual({ status: 'COMPLETED', timedOut: false })
    expect(call).toBe(3)
  })

  it('gives up after the timeout instead of blocking the whole run', async () => {
    let clock = 0
    const result = await waitForMetaBillingSync({
      getJob: async () => job('RUNNING'),
      sleep: async () => { clock += 5_000 },
      now: () => clock,
      timeoutMs: 20_000,
    })
    expect(result).toEqual({ status: 'RUNNING', timedOut: true })
  })

  it('treats a missing job as nothing to wait for', async () => {
    const result = await waitForMetaBillingSync({ getJob: async () => null, sleep: async () => {}, now: () => 0 })
    expect(result.timedOut).toBe(false)
  })
})
