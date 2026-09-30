import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import { buildReserveOverview } from '@/lib/meta-reserve-service'

const USD_ACCOUNT = 'res_usd'
const VND_ACCOUNT = 'res_vnd'
const BLANK_ACCOUNT = 'res_blank'
const EXCLUDED_ACCOUNT = 'res_excluded'
const IDS = [USD_ACCOUNT, VND_ACCOUNT, BLANK_ACCOUNT, EXCLUDED_ACCOUNT]
const NOW = new Date('2026-09-30T06:00:00Z')

async function billing(id: string, adAccountId: string, billingDate: string, amount: number, currency: string) {
  await prisma.metaBilling.create({
    data: { id, adAccountId, billingDate, amount, currency, status: 'PAID', paymentMethodLast4: '1111' },
  })
}

describe('buildReserveOverview', () => {
  beforeAll(async () => {
    await prisma.metaBilling.deleteMany({ where: { adAccountId: { in: IDS } } })
    await prisma.metaAdAccount.deleteMany({ where: { id: { in: IDS } } })
    await prisma.metaAdAccount.create({
      data: {
        id: USD_ACCOUNT,
        accountId: 'act_res_usd',
        accountName: 'Reserve USD',
        accessToken: 'x',
        currency: 'USD',
        balance: 150,
        balanceCurrency: 'USD',
        balanceSyncedAt: NOW,
        accountStatus: 1,
        fundingCardLast4: '5462',
        budgetRemaining: 40,
        plannedDailySpend: 40,
        activeCampaignCount: 4,
        budgetSyncedAt: NOW,
      },
    })
    await prisma.metaAdAccount.create({
      data: {
        id: VND_ACCOUNT,
        accountId: 'act_res_vnd',
        accountName: 'Reserve VND',
        accessToken: 'x',
        currency: 'VND',
        balance: 14_000_000,
        balanceCurrency: 'VND',
        balanceSyncedAt: NOW,
        accountStatus: 1,
        fundingCardLast4: '7619',
        budgetRemaining: 1_000_000,
        plannedDailySpend: 1_000_000,
        activeCampaignCount: 2,
        budgetSyncedAt: NOW,
        billingThreshold: 14_800_000,
        thresholdCurrency: 'VND',
        thresholdSource: 'MANUAL',
      },
    })
    await prisma.metaAdAccount.create({
      data: {
        id: BLANK_ACCOUNT,
        accountId: 'act_res_blank',
        accountName: 'Reserve Blank',
        accessToken: 'x',
        currency: 'USD',
        balance: 10,
        balanceCurrency: 'USD',
        balanceSyncedAt: NOW,
        accountStatus: 1,
      },
    })
    await prisma.metaAdAccount.create({
      data: {
        id: EXCLUDED_ACCOUNT,
        accountId: 'act_res_excluded',
        accountName: 'Reserve Excluded',
        accessToken: 'x',
        currency: 'USD',
        balance: 364.55,
        balanceCurrency: 'USD',
        balanceSyncedAt: NOW,
        accountStatus: 3,
        fundingCardLast4: '5462',
        billingThreshold: 250,
        thresholdCurrency: 'USD',
        thresholdSource: 'MANUAL',
        excludedFromCashflow: true,
      },
    })
    await billing('res_b1', USD_ACCOUNT, '2026-09-21', 224.92, 'USD')
    await billing('res_b2', USD_ACCOUNT, '2026-09-20', 224.32, 'USD')
    await billing('res_b3', USD_ACCOUNT, '2026-09-20', 223.40, 'USD')
    await billing('res_b4', VND_ACCOUNT, '2026-09-21', 22_000_000, 'VND')
    await billing('res_b5', VND_ACCOUNT, '2026-09-20', 22_010_000, 'VND')
    await prisma.metaExchangeRate.upsert({
      where: { effectiveDate: '2026-09-01' },
      create: { effectiveDate: '2026-09-01', rate: 25_000 },
      update: { rate: 25_000 },
    })
  })

  afterAll(async () => {
    await prisma.metaBilling.deleteMany({ where: { adAccountId: { in: IDS } } })
    await prisma.metaAdAccount.deleteMany({ where: { id: { in: IDS } } })
  })

  it('infers the threshold from repeated charges when none was entered', async () => {
    const result = await buildReserveOverview({ now: NOW })
    const account = result.accounts.find(row => row.id === USD_ACCOUNT)
    expect(account?.threshold).toBe(224.92)
    expect(account?.thresholdSource).toBe('INFERRED')
    expect(account?.thresholdOccurrences).toBe(3)
    expect(account?.level).toBe('WATCH')
    expect(account?.daysToCharge).toBe(1.87)
  })

  it('keeps a manually entered threshold instead of inferring one', async () => {
    const result = await buildReserveOverview({ now: NOW })
    const account = result.accounts.find(row => row.id === VND_ACCOUNT)
    expect(account?.threshold).toBe(14_800_000)
    expect(account?.thresholdSource).toBe('MANUAL')
    expect(account?.level).toBe('URGENT')
    expect(account?.reasons).toContain('WILL_CROSS')
  })

  it('cannot judge an account with no charge history and no manual threshold', async () => {
    const result = await buildReserveOverview({ now: NOW })
    const account = result.accounts.find(row => row.id === BLANK_ACCOUNT)
    expect(account?.threshold).toBeNull()
    expect(account?.level).toBe('UNKNOWN')
    expect(result.cards.every(card => !card.accountIds.includes('act_res_blank'))).toBe(true)
  })

  it('shows an excluded account but never counts it as money to prepare', async () => {
    const result = await buildReserveOverview({ now: NOW })
    const account = result.accounts.find(row => row.id === EXCLUDED_ACCOUNT)
    expect(account?.excluded).toBe(true)
    expect(account?.level).toBe('URGENT')
    expect(result.cards.every(card => !card.accountIds.includes('act_res_excluded'))).toBe(true)
    const usdCard = result.cards.find(card => card.cardLast4 === '5462')
    expect(usdCard?.totals).toEqual([{ currency: 'USD', amount: 224.92 }])
  })

  it('groups the money to prepare per card and converts it to USD', async () => {
    const result = await buildReserveOverview({ now: NOW })
    const usdCard = result.cards.find(card => card.cardLast4 === '5462')
    const vndCard = result.cards.find(card => card.cardLast4 === '7619')
    expect(usdCard).toMatchObject({
      level: 'WATCH',
      accountIds: ['act_res_usd'],
      totals: [{ currency: 'USD', amount: 224.92 }],
      totalUsd: 224.92,
    })
    expect(vndCard).toMatchObject({
      level: 'URGENT',
      accountIds: ['act_res_vnd'],
      totals: [{ currency: 'VND', amount: 14_800_000 }],
      totalUsd: 592,
    })
  })

  it('reports a total that matches the per-card USD amounts', async () => {
    const result = await buildReserveOverview({ now: NOW })
    const sum = result.cards.reduce((total, card) => total + (card.totalUsd ?? 0), 0)
    expect(result.totalReserveUsd).toBe(Math.round(sum * 100) / 100)
    expect(result.horizonDays).toBe(3)
  })
})
