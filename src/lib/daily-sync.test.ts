import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
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
