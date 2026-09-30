import { describe, expect, it } from 'vitest'
import { buildAccountMetaUpdate, fetchAccountReserve } from './meta-reserve-sync'

const NOW = new Date('2026-09-30T06:00:00Z')
const ACCOUNT = { accountId: 'act_31911697621754869', accessToken: 'tok', currency: 'USD' }

describe('buildAccountMetaUpdate', () => {
  it('reads balance, status and funding card out of the account payload', () => {
    const json = {
      balance: '26228',
      currency: 'USD',
      account_status: 3,
      funding_source_details: { id: '99', display_string: 'VISA *7619', type: 1 },
    }
    expect(buildAccountMetaUpdate(json, 'USD', NOW)).toEqual({
      balance: 262.28,
      balanceCurrency: 'USD',
      balanceSyncedAt: NOW,
      accountStatus: 3,
      fundingCardLast4: '7619',
      fundingCardLabel: 'VISA',
    })
  })

  it('leaves card and status null when Meta omits them', () => {
    expect(buildAccountMetaUpdate({ balance: '0', currency: 'USD' }, 'USD', NOW)).toEqual({
      balance: 0,
      balanceCurrency: 'USD',
      balanceSyncedAt: NOW,
      accountStatus: null,
      fundingCardLast4: null,
      fundingCardLabel: null,
    })
  })
})

describe('fetchAccountReserve', () => {
  it('sums campaign budgets without asking for ad sets', async () => {
    const urls: string[] = []
    const fetchJson = async (url: string) => {
      urls.push(url)
      if (url.includes('/campaigns')) {
        return {
          data: [
            { id: 'c1', effective_status: 'ACTIVE', daily_budget: '500', budget_remaining: '500' },
            { id: 'c2', effective_status: 'ACTIVE', daily_budget: '3500', budget_remaining: '3500' },
          ],
        }
      }
      return { balance: '26228', currency: 'USD', account_status: 1, funding_source_details: { display_string: 'VISA *7619' } }
    }

    const result = await fetchAccountReserve(ACCOUNT, { today: '2026-09-30', now: NOW, fetchJson })

    expect(result.update).toMatchObject({
      balance: 262.28,
      accountStatus: 1,
      fundingCardLast4: '7619',
      budgetRemaining: 40,
      plannedDailySpend: 40,
      activeCampaignCount: 2,
      budgetSyncedAt: NOW,
    })
    expect(urls.some(url => url.includes('/adsets'))).toBe(false)
  })

  it('falls back to ad set budgets when a campaign carries none', async () => {
    const urls: string[] = []
    const fetchJson = async (url: string) => {
      urls.push(url)
      if (url.includes('/campaigns')) return { data: [{ id: 'c1', effective_status: 'ACTIVE' }] }
      if (url.includes('/adsets')) {
        return {
          data: [
            { id: 'a1', campaign_id: 'c1', effective_status: 'ACTIVE', daily_budget: '1000', budget_remaining: '1000' },
            { id: 'a2', campaign_id: 'c1', effective_status: 'PAUSED', daily_budget: '9000', budget_remaining: '9000' },
          ],
        }
      }
      return { balance: '0', currency: 'USD', account_status: 1 }
    }

    const result = await fetchAccountReserve(ACCOUNT, { today: '2026-09-30', now: NOW, fetchJson })

    expect(urls.some(url => url.includes('/adsets'))).toBe(true)
    expect(result.update).toMatchObject({ budgetRemaining: 10, plannedDailySpend: 10, activeCampaignCount: 1 })
  })

  it('follows paging to the last page of campaigns', async () => {
    const fetchJson = async (url: string) => {
      if (url === 'https://graph.facebook.com/page2') {
        return { data: [{ id: 'c2', effective_status: 'ACTIVE', daily_budget: '500', budget_remaining: '500' }] }
      }
      if (url.includes('/campaigns')) {
        return {
          data: [{ id: 'c1', effective_status: 'ACTIVE', daily_budget: '500', budget_remaining: '500' }],
          paging: { next: 'https://graph.facebook.com/page2' },
        }
      }
      return { balance: '0', currency: 'USD' }
    }

    const result = await fetchAccountReserve(ACCOUNT, { today: '2026-09-30', now: NOW, fetchJson })
    expect(result.update.activeCampaignCount).toBe(2)
    expect(result.update.plannedDailySpend).toBe(10)
  })

  it('keeps the account currency when Meta reports budgets in a zero-decimal currency', async () => {
    const fetchJson = async (url: string) => {
      if (url.includes('/campaigns')) {
        return { data: [{ id: 'c1', effective_status: 'ACTIVE', daily_budget: '500000', budget_remaining: '500000' }] }
      }
      return { balance: '11126077', currency: 'VND', account_status: 1 }
    }

    const result = await fetchAccountReserve(
      { ...ACCOUNT, currency: 'VND' },
      { today: '2026-09-30', now: NOW, fetchJson },
    )
    expect(result.update.balance).toBe(11_126_077)
    expect(result.update.plannedDailySpend).toBe(500_000)
    expect(Object.keys(result.update)).not.toContain('billingThreshold')
  })
})
