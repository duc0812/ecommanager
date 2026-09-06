import { describe, it, expect } from 'vitest'
import { computeNichePerformance, type NichePerformanceInput } from './niche-performance'

const period = { from: '2026-09-01', to: '2026-09-10', timeZone: 'UTC' }
const usdAccount = { id: 'acc-usd', accountId: 'act_1', accountName: 'Remi04', currency: 'USD' }
const vndAccount = { id: 'acc-vnd', accountId: 'act_2', accountName: 'Remi08', currency: 'VND' }
const schedule = [{ effectiveDate: '2026-01-01', rate: 25000 }]

const jeep = { id: 'n-jeep', name: 'Jeep', keywords: '["jeep"]', active: true, sortOrder: 0 }
const pomo = { id: 'n-pomo', name: 'PoMo', keywords: '["pomo"]', active: true, sortOrder: 1 }
const honey = { id: 'n-honey', name: 'Honey Bear', keywords: '["honey bear"]', active: true, sortOrder: 2 }

function spend(over: Partial<NichePerformanceInput['campaignSpends'][number]>) {
  return { adAccountId: 'acc-usd', campaignId: 'c1', campaignName: 'x', date: '2026-09-05', spend: 0, impressions: 0, clicks: 0, currency: 'USD', ...over }
}

function line(productTitle: string, unitPrice: number, qty = 1, extra: Partial<{ sku: string | null; shopifyProductType: string | null }> = {}) {
  return { sku: 'SKU-1', productTitle, unitPrice, qty, shopifyProductType: 'T shirt', ...extra }
}

function base(over: Partial<NichePerformanceInput> = {}): NichePerformanceInput {
  return { period, niches: [jeep, pomo, honey], overrides: [], accounts: [usdAccount, vndAccount], campaignSpends: [], orders: [], schedule, ...over }
}

describe('computeNichePerformance', () => {
  it('matches campaign names and product titles case-insensitively', () => {
    const r = computeNichePerformance(base({
      campaignSpends: [spend({ campaignId: 'c1', campaignName: 'Remi04 POMO new arrival', spend: 100, impressions: 1000, clicks: 50 })],
      orders: [{ id: 'o1', refundedAmount: 0, lines: [line('PoMo Celebrate 30 Years Jersey', 40, 2)] }],
    }))
    const p = r.niches.find(n => n.nicheId === 'n-pomo')!
    expect(p.spend).toBeCloseTo(100)
    expect(p.revenue).toBeCloseTo(80)
    expect(p.roas).toBeCloseTo(0.8)
    expect(p.orders).toBe(1)
    expect(p.aov).toBeCloseTo(80)
    expect(p.campaignCount).toBe(1)
    expect(p.campaigns[0]).toMatchObject({ campaignId: 'c1', accountName: 'Remi04', cpm: 100, ctr: 0.05 })
    expect(r.unassigned.spend).toBe(0)
    expect(r.unassigned.revenue).toBe(0)
  })

  it('override beats keyword even when the name matches another niche', () => {
    const r = computeNichePerformance(base({
      overrides: [{ campaignId: 'c1', nicheId: 'n-honey' }],
      campaignSpends: [spend({ campaignId: 'c1', campaignName: 'Jeep mug', spend: 10 })],
    }))
    expect(r.niches.find(n => n.nicheId === 'n-honey')!.spend).toBeCloseTo(10)
    expect(r.niches.find(n => n.nicheId === 'n-jeep')!.spend).toBe(0)
  })

  it('first active niche by sortOrder wins when two niches match', () => {
    const both = { id: 'n-both', name: 'Both', keywords: '["jeep"]', active: true, sortOrder: -1 }
    const r = computeNichePerformance(base({
      niches: [jeep, both],
      campaignSpends: [spend({ campaignId: 'c1', campaignName: 'jeep shirt', spend: 5 })],
    }))
    expect(r.niches.find(n => n.nicheId === 'n-both')!.spend).toBeCloseTo(5)
    expect(r.niches.find(n => n.nicheId === 'n-jeep')!.spend).toBe(0)
  })

  it('inactive niches are ignored and their campaigns/lines go to unassigned', () => {
    const r = computeNichePerformance(base({
      niches: [{ ...jeep, active: false }],
      overrides: [{ campaignId: 'c2', nicheId: 'n-jeep' }],
      campaignSpends: [
        spend({ campaignId: 'c1', campaignName: 'jeep shirt', spend: 5 }),
        spend({ campaignId: 'c2', campaignName: 'other', spend: 7 }),
      ],
      orders: [{ id: 'o1', refundedAmount: 0, lines: [line('Jeep Girl Hoodie', 60)] }],
    }))
    expect(r.niches).toHaveLength(0)
    expect(r.unassigned.spend).toBeCloseTo(12)
    expect(r.unassigned.revenue).toBeCloseTo(60)
    expect(r.unassigned.campaigns).toHaveLength(2)
  })

  it('mixed-niche order: refund allocated pro-rata, order counted once per niche', () => {
    const r = computeNichePerformance(base({
      orders: [{ id: 'o1', refundedAmount: 30, lines: [line('Jeep Hoodie', 60), line('PoMo Jersey', 40), line('Jeep Mug', 20, 2)] }],
    }))
    const j = r.niches.find(n => n.nicheId === 'n-jeep')!
    const p = r.niches.find(n => n.nicheId === 'n-pomo')!
    expect(j.revenue).toBeCloseTo(100 - 30 * (100 / 140))
    expect(p.revenue).toBeCloseTo(40 - 30 * (40 / 140))
    expect(j.orders).toBe(1)
    expect(p.orders).toBe(1)
    expect(r.totals.orders).toBe(1)
    expect(r.totals.revenue).toBeCloseTo(110)
  })

  it('excludes non-product lines (Tip, Shipping protection, Custom Text)', () => {
    const r = computeNichePerformance(base({
      orders: [{
        id: 'o1', refundedAmount: 0, lines: [
          line('Jeep Hoodie', 60),
          line('Tip', 5, 1, { sku: null, shopifyProductType: null }),
          line('Shipping protection', 3, 1, { sku: null, shopifyProductType: 'Kaching Cart Upsell Toggle' }),
          line('Custom Text', 4, 1, { sku: null, shopifyProductType: 'Custom Text' }),
        ],
      }],
    }))
    expect(r.niches.find(n => n.nicheId === 'n-jeep')!.revenue).toBeCloseTo(60)
    expect(r.unassigned.revenue).toBe(0)
    expect(r.totals.revenue).toBeCloseTo(60)
  })

  it('converts VND with the dated schedule and keeps the original amount', () => {
    const r = computeNichePerformance(base({
      campaignSpends: [spend({ adAccountId: 'acc-vnd', campaignId: 'c9', campaignName: 'Honey Bear video', spend: 2_500_000, currency: 'VND' })],
    }))
    const h = r.niches.find(n => n.nicheId === 'n-honey')!
    expect(h.spend).toBeCloseTo(100, 1)
    expect(h.campaigns[0]).toMatchObject({ spendOriginal: 2_500_000, currency: 'VND', accountName: 'Remi08' })
    expect(r.missingExchangeRateAccounts).toEqual([])
  })

  it('missing exchange rate contributes 0 spend and lists the account', () => {
    const r = computeNichePerformance(base({
      schedule: [],
      campaignSpends: [spend({ adAccountId: 'acc-vnd', campaignId: 'c9', campaignName: 'Honey Bear video', spend: 2_500_000, currency: 'VND' })],
    }))
    expect(r.niches.find(n => n.nicheId === 'n-honey')!.spend).toBe(0)
    expect(r.missingExchangeRateAccounts).toEqual([{ accountId: 'act_2', accountName: 'Remi08', currency: 'VND' }])
  })

  it('a campaign with impressions but zero spend still appears', () => {
    const r = computeNichePerformance(base({
      campaignSpends: [spend({ campaignId: 'c1', campaignName: 'jeep test', spend: 0, impressions: 10 })],
    }))
    const j = r.niches.find(n => n.nicheId === 'n-jeep')!
    expect(j.campaigns).toHaveLength(1)
    expect(j.campaigns[0].spend).toBe(0)
    expect(j.campaigns[0].lastActiveDate).toBeNull()
    expect(j.campaigns[0].isActive).toBe(false)
    expect(j.roas).toBeNull()
  })

  it('derives lastActiveDate, isActive (spend within last 3 days of the range) and latest campaignName', () => {
    const r = computeNichePerformance(base({
      campaignSpends: [
        spend({ campaignId: 'c1', campaignName: 'jeep old name', date: '2026-09-02', spend: 5 }),
        spend({ campaignId: 'c1', campaignName: 'jeep new name', date: '2026-09-08', spend: 5 }),
        spend({ campaignId: 'c2', campaignName: 'jeep paused', date: '2026-09-03', spend: 5 }),
      ],
    }))
    const j = r.niches.find(n => n.nicheId === 'n-jeep')!
    const c1 = j.campaigns.find(c => c.campaignId === 'c1')!
    const c2 = j.campaigns.find(c => c.campaignId === 'c2')!
    expect(c1).toMatchObject({ campaignName: 'jeep new name', lastActiveDate: '2026-09-08', isActive: true, spend: 10 })
    expect(c2).toMatchObject({ lastActiveDate: '2026-09-03', isActive: false })
    expect(j.campaignCount).toBe(2)
    expect(j.activeCampaignCount).toBe(1)
  })

  it('totals equal the sum of niche and unassigned values; niches sorted by spend desc', () => {
    const r = computeNichePerformance(base({
      campaignSpends: [
        spend({ campaignId: 'c1', campaignName: 'jeep', spend: 10 }),
        spend({ campaignId: 'c2', campaignName: 'pomo', spend: 30 }),
        spend({ campaignId: 'c3', campaignName: 'mystery', spend: 2 }),
      ],
      orders: [
        { id: 'o1', refundedAmount: 0, lines: [line('Jeep Hoodie', 50)] },
        { id: 'o2', refundedAmount: 0, lines: [line('Unknown thing', 9)] },
      ],
    }))
    expect(r.niches.map(n => n.name)).toEqual(['PoMo', 'Jeep', 'Honey Bear'])
    expect(r.totals.spend).toBeCloseTo(42)
    expect(r.totals.revenue).toBeCloseTo(59)
    expect(r.totals.roas).toBeCloseTo(59 / 42)
    expect(r.totals.orders).toBe(2)
    expect(r.unassigned.spend).toBeCloseTo(2)
    expect(r.unassigned.revenue).toBeCloseTo(9)
  })
})
