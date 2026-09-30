import { describe, expect, it } from 'vitest'
import { assessAccountReserve, inferThreshold, summarizeBudgets, sumReserveByCard } from './meta-reserve'

const TODAY = '2026-09-30'

function bill(billingDate: string, amount: number, currency = 'USD') {
  return { billingDate, amount, currency }
}

describe('inferThreshold', () => {
  it('takes the biggest recent charge, not the most repeated one (Meta raises the threshold)', () => {
    // Real Remi10 history: the charge Meta takes climbs 224 -> 402 -> 656 -> 901.
    const rows = [
      bill('2026-09-27', 901.72),
      bill('2026-09-26', 655.25),
      bill('2026-09-24', 656.41),
      bill('2026-09-23', 402.38),
      bill('2026-09-22', 223.23),
      bill('2026-09-21', 224.92),
      bill('2026-09-20', 224.32),
      bill('2026-09-19', 548.04),
    ]
    const result = inferThreshold(rows, { today: TODAY, currency: 'USD' })
    expect(result?.amount).toBe(901.72)
    expect(result?.occurrences).toBe(1)
    expect(result?.lastSeen).toBe('2026-09-27')
  })

  it('ignores the partial charges Meta takes after a threshold charge', () => {
    // Real Remi03 history: 93-94 is the threshold; 29.32/19.55/11.17 are leftovers.
    const rows = [
      bill('2026-09-29', 29.32),
      bill('2026-09-29', 29.32),
      bill('2026-09-29', 19.55),
      bill('2026-09-29', 11.17),
      bill('2026-09-28', 94.45),
      bill('2026-09-25', 93.23),
      bill('2026-09-24', 93.19),
    ]
    const result = inferThreshold(rows, { today: TODAY, currency: 'USD' })
    expect(result?.amount).toBe(94.45)
  })

  it('counts how many charges sit at that level, as confidence', () => {
    const rows = [
      bill('2026-09-15', 279.39),
      bill('2026-09-13', 279.48),
      bill('2026-09-12', 279.41),
      bill('2026-09-10', 279.32),
      bill('2026-09-09', 279.56),
      bill('2026-09-14', 34.95),
    ]
    expect(inferThreshold(rows, { today: TODAY, currency: 'USD' })).toEqual({
      amount: 279.56,
      currency: 'USD',
      occurrences: 5,
      lastSeen: '2026-09-15',
    })
  })

  it('works on zero-decimal currencies', () => {
    const rows = [
      bill('2026-09-11', 14784598, 'VND'),
      bill('2026-09-10', 14805879, 'VND'),
      bill('2026-09-09', 14795656, 'VND'),
    ]
    const result = inferThreshold(rows, { today: TODAY, currency: 'VND' })
    expect(result?.amount).toBe(14805879)
    expect(result?.occurrences).toBe(3)
  })

  it('uses a single charge when that is the only history', () => {
    expect(inferThreshold([bill('2026-09-20', 548.04)], { today: TODAY, currency: 'USD' })?.amount).toBe(548.04)
  })

  it('ignores charges older than the window, however big', () => {
    const rows = [bill('2026-08-20', 5000), bill('2026-09-20', 100)]
    expect(inferThreshold(rows, { today: TODAY, currency: 'USD' })?.amount).toBe(100)
  })

  it('returns null when the window holds no charge at all', () => {
    expect(inferThreshold([bill('2026-06-01', 279.39)], { today: TODAY, currency: 'USD' })).toBeNull()
  })

  it('ignores charges in another currency', () => {
    const rows = [bill('2026-09-20', 500, 'VND'), bill('2026-09-18', 100, 'USD')]
    expect(inferThreshold(rows, { today: TODAY, currency: 'USD' })?.amount).toBe(100)
  })
})

describe('summarizeBudgets', () => {
  it('sums active campaign daily budgets from minor units', () => {
    const campaigns = [
      { id: 'c1', effective_status: 'ACTIVE', daily_budget: '500', budget_remaining: '500' },
      { id: 'c2', effective_status: 'ACTIVE', daily_budget: '3500', budget_remaining: '3500' },
    ]
    expect(summarizeBudgets({ campaigns, adsets: [], currency: 'USD', today: TODAY })).toEqual({
      budgetRemaining: 40,
      plannedDailySpend: 40,
      spendToday: 0,
      activeCampaignCount: 2,
    })
  })

  it('keeps zero-decimal currency budgets unscaled', () => {
    const campaigns = [{ id: 'c1', effective_status: 'ACTIVE', daily_budget: '500000', budget_remaining: '500000' }]
    const result = summarizeBudgets({ campaigns, adsets: [], currency: 'VND', today: TODAY })
    expect(result.plannedDailySpend).toBe(500000)
  })

  it('ignores paused campaigns and paused ad sets', () => {
    const campaigns = [
      { id: 'c1', effective_status: 'PAUSED', daily_budget: '500', budget_remaining: '500' },
      { id: 'c2', effective_status: 'ACTIVE' },
    ]
    const adsets = [
      { id: 'a1', campaign_id: 'c2', effective_status: 'PAUSED', daily_budget: '900', budget_remaining: '900' },
      { id: 'a2', campaign_id: 'c2', effective_status: 'ACTIVE', daily_budget: '1000', budget_remaining: '1000' },
    ]
    expect(summarizeBudgets({ campaigns, adsets, currency: 'USD', today: TODAY })).toEqual({
      budgetRemaining: 10,
      plannedDailySpend: 10,
      spendToday: 0,
      activeCampaignCount: 1,
    })
  })

  it('reads today spend as the gap Meta already took out of budget_remaining', () => {
    const campaigns = [
      { id: 'c1', effective_status: 'ACTIVE', daily_budget: '1500', budget_remaining: '1373' },
      { id: 'c2', effective_status: 'ACTIVE', daily_budget: '5000', budget_remaining: '4733' },
      { id: 'c3', effective_status: 'ACTIVE', daily_budget: '500', budget_remaining: '500' },
    ]
    const result = summarizeBudgets({ campaigns, adsets: [], currency: 'USD', today: TODAY })
    expect(result.spendToday).toBe(3.94)
    expect(result.budgetRemaining).toBe(66.06)
    expect(result.plannedDailySpend).toBe(70)
  })

  it('never reports negative spend when budget_remaining exceeds the daily budget', () => {
    const campaigns = [{ id: 'c1', effective_status: 'ACTIVE', daily_budget: '500', budget_remaining: '600' }]
    expect(summarizeBudgets({ campaigns, adsets: [], currency: 'USD', today: TODAY }).spendToday).toBe(0)
  })

  it('spreads a lifetime budget over the days left, not all onto today', () => {
    const campaigns = [{
      id: 'c1',
      effective_status: 'ACTIVE',
      lifetime_budget: '30000',
      budget_remaining: '20000',
      stop_time: '2026-10-10T00:00:00+0000',
    }]
    const result = summarizeBudgets({ campaigns, adsets: [], currency: 'USD', today: TODAY })
    expect(result.budgetRemaining).toBe(200)
    expect(result.plannedDailySpend).toBe(20)
  })

  it('treats a lifetime budget with no stop time as spendable today', () => {
    const campaigns = [{ id: 'c1', effective_status: 'ACTIVE', lifetime_budget: '30000', budget_remaining: '20000' }]
    const result = summarizeBudgets({ campaigns, adsets: [], currency: 'USD', today: TODAY })
    expect(result.plannedDailySpend).toBe(200)
  })
})

describe('assessAccountReserve', () => {
  const base = {
    id: 'db1',
    accountId: 'act_1',
    accountName: 'Remi04',
    currency: 'USD',
    balance: 100,
    balanceSyncedAt: new Date('2026-09-30T06:00:00Z'),
    budgetRemaining: 40,
    plannedDailySpend: 40,
    activeCampaignCount: 6,
    accountStatus: 1,
    threshold: 500,
    thresholdSource: 'INFERRED' as const,
    fundingCardLast4: '7619',
    excluded: false,
  }

  it('is OK when the threshold is days away', () => {
    const r = assessAccountReserve(base, { today: TODAY, now: new Date('2026-09-30T06:00:00Z') })
    expect(r.level).toBe('OK')
    expect(r.headroom).toBe(400)
    expect(r.projectedBalance).toBe(140)
    expect(r.daysToCharge).toBe(10)
    expect(r.chargeAmount).toBe(500)
    expect(r.willCross).toBe(false)
  })

  it('warns when the charge lands inside the watch window', () => {
    const r = assessAccountReserve({ ...base, balance: 400 }, { today: TODAY, now: new Date('2026-09-30T06:00:00Z') })
    expect(r.level).toBe('WATCH')
    expect(r.daysToCharge).toBe(2.5)
    expect(r.reasons).toContain('DUE_SOON')
  })

  it('is urgent when remaining budget plus balance crosses the threshold', () => {
    const r = assessAccountReserve({ ...base, balance: 480 }, { today: TODAY, now: new Date('2026-09-30T06:00:00Z') })
    expect(r.level).toBe('URGENT')
    expect(r.willCross).toBe(true)
    expect(r.reasons).toContain('WILL_CROSS')
  })

  it('is urgent when the balance already passed the threshold', () => {
    const r = assessAccountReserve({ ...base, balance: 520 }, { today: TODAY, now: new Date('2026-09-30T06:00:00Z') })
    expect(r.level).toBe('URGENT')
    expect(r.headroom).toBe(0)
    expect(r.reasons).toContain('ALREADY_OVER')
  })

  it('is urgent for an unsettled account even with no balance', () => {
    const r = assessAccountReserve(
      { ...base, balance: 0, accountStatus: 3 },
      { today: TODAY, now: new Date('2026-09-30T06:00:00Z') },
    )
    expect(r.level).toBe('URGENT')
    expect(r.reasons).toContain('UNSETTLED')
  })

  it('needs the whole balance on the card once it passed the threshold', () => {
    const r = assessAccountReserve({ ...base, balance: 810.58 }, { today: TODAY, now: new Date('2026-09-30T06:00:00Z') })
    expect(r.chargeAmount).toBe(810.58)
  })

  it('needs the unpaid balance of an unsettled account that has no threshold', () => {
    const r = assessAccountReserve(
      { ...base, balance: 364.55, accountStatus: 3, threshold: null, thresholdSource: null },
      { today: TODAY, now: new Date('2026-09-30T06:00:00Z') },
    )
    expect(r.level).toBe('URGENT')
    expect(r.chargeAmount).toBe(364.55)
  })

  it('cannot judge an account with no threshold yet', () => {
    const r = assessAccountReserve(
      { ...base, threshold: null, thresholdSource: null },
      { today: TODAY, now: new Date('2026-09-30T06:00:00Z') },
    )
    expect(r.level).toBe('UNKNOWN')
    expect(r.reasons).toContain('NO_THRESHOLD')
    expect(r.daysToCharge).toBeNull()
  })

  it('has no forecast when nothing is scheduled to spend', () => {
    const r = assessAccountReserve(
      { ...base, budgetRemaining: 0, plannedDailySpend: 0, activeCampaignCount: 0 },
      { today: TODAY, now: new Date('2026-09-30T06:00:00Z') },
    )
    expect(r.level).toBe('OK')
    expect(r.daysToCharge).toBeNull()
    expect(r.reasons).toContain('NO_ACTIVE_SPEND')
  })

  it('flags a stale balance with its age in days', () => {
    const r = assessAccountReserve(
      { ...base, balanceSyncedAt: new Date('2026-09-21T23:43:30Z') },
      { today: TODAY, now: new Date('2026-09-30T06:00:00Z') },
    )
    expect(r.staleDays).toBe(8)
    expect(r.reasons).toContain('STALE_DATA')
  })
})

describe('sumReserveByCard', () => {
  const mk = (over: Partial<ReturnType<typeof assessAccountReserve>>) => ({
    id: 'db1',
    accountId: 'act_1',
    accountName: 'A',
    currency: 'USD',
    fundingCardLast4: '7619',
    balance: 0,
    balanceSyncedAt: null,
    excluded: false,
    projectedBalance: 0,
    budgetRemaining: 0,
    plannedDailySpend: 0,
    activeCampaignCount: 0,
    accountStatus: 1,
    threshold: 500,
    thresholdSource: 'INFERRED' as const,
    headroom: 500,
    daysToCharge: null,
    chargeAmount: 500,
    willCross: false,
    staleDays: 0,
    level: 'OK' as const,
    reasons: [] as string[],
    ...over,
  })

  it('sums only the accounts due inside the horizon, split by card and currency', () => {
    const rows = [
      mk({ id: 'a', accountId: 'act_a', fundingCardLast4: '7619', level: 'URGENT', chargeAmount: 500, daysToCharge: 0 }),
      mk({ id: 'b', accountId: 'act_b', fundingCardLast4: '7619', currency: 'VND', level: 'WATCH', chargeAmount: 14805879, daysToCharge: 2 }),
      mk({ id: 'c', accountId: 'act_c', fundingCardLast4: '5462', level: 'WATCH', chargeAmount: 225, daysToCharge: 3 }),
      mk({ id: 'd', accountId: 'act_d', fundingCardLast4: '5462', level: 'OK', chargeAmount: 300, daysToCharge: 20 }),
    ]
    expect(sumReserveByCard(rows, { horizonDays: 3 })).toEqual([
      {
        cardLast4: '5462',
        level: 'WATCH',
        accountIds: ['act_c'],
        totals: [{ currency: 'USD', amount: 225 }],
      },
      {
        cardLast4: '7619',
        level: 'URGENT',
        accountIds: ['act_a', 'act_b'],
        totals: [{ currency: 'USD', amount: 500 }, { currency: 'VND', amount: 14805879 }],
      },
    ])
  })

  it('leaves excluded accounts out of the money to prepare', () => {
    const rows = [
      mk({ accountId: 'act_live', level: 'URGENT', chargeAmount: 500, daysToCharge: 0 }),
      mk({ accountId: 'act_dead', level: 'URGENT', chargeAmount: 364.55, daysToCharge: 0, excluded: true }),
    ]
    expect(sumReserveByCard(rows, { horizonDays: 3 })).toEqual([
      { cardLast4: '7619', level: 'URGENT', accountIds: ['act_live'], totals: [{ currency: 'USD', amount: 500 }] },
    ])
  })

  it('keeps accounts with an unknown card in their own group', () => {
    const rows = [mk({ accountId: 'act_x', fundingCardLast4: null, level: 'URGENT', chargeAmount: 100, daysToCharge: 0 })]
    expect(sumReserveByCard(rows, { horizonDays: 3 })).toEqual([
      { cardLast4: null, level: 'URGENT', accountIds: ['act_x'], totals: [{ currency: 'USD', amount: 100 }] },
    ])
  })

  it('returns no group when nothing is due inside the horizon', () => {
    const rows = [mk({ level: 'OK', daysToCharge: 30, chargeAmount: 500 })]
    expect(sumReserveByCard(rows, { horizonDays: 3 })).toEqual([])
  })
})
