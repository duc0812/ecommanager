import { prisma } from '@/lib/db'
import { dateOnly } from '@/lib/cashflow-dates'
import { convertMetaAmountToUsdDated, normalizeMetaCurrency } from '@/lib/meta-currency'
import { getMetaRateSchedule } from '@/lib/meta-exchange-rates'
import { PAID_META_STATUSES } from '@/lib/meta-fee'
import {
  WATCH_DAYS,
  assessAccountReserve,
  inferThreshold,
  sumReserveByCard,
  type CardReserve,
  type ReserveAssessment,
  type ThresholdSource,
} from '@/lib/meta-reserve'

const THRESHOLD_WINDOW_DAYS = 60

export type ReserveAccountRow = ReserveAssessment & {
  projectId: string | null
  balanceCurrency: string | null
  budgetSyncedAt: Date | null
  spendToday: number | null
  thresholdOccurrences: number | null
  thresholdLastSeen: string | null
}

export type ReserveCard = CardReserve & { totalUsd: number | null }

export type ReserveOverview = {
  accounts: ReserveAccountRow[]
  cards: ReserveCard[]
  totalReserveUsd: number
  horizonDays: number
  today: string
  generatedAt: string
}

function round2(value: number) {
  return Math.round(value * 100) / 100
}

export async function buildReserveOverview(
  { now = new Date(), horizonDays = WATCH_DAYS }: { now?: Date; horizonDays?: number } = {},
): Promise<ReserveOverview> {
  const today = dateOnly(now)
  const [accounts, schedule] = await Promise.all([
    prisma.metaAdAccount.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        accountId: true,
        accountName: true,
        currency: true,
        projectId: true,
        balance: true,
        balanceCurrency: true,
        balanceSyncedAt: true,
        accountStatus: true,
        fundingCardLast4: true,
        fundingCardLabel: true,
        billingThreshold: true,
        thresholdCurrency: true,
        thresholdSource: true,
        budgetRemaining: true,
        plannedDailySpend: true,
        spendToday: true,
        activeCampaignCount: true,
        budgetSyncedAt: true,
        excludedFromCashflow: true,
      },
    }),
    getMetaRateSchedule(),
  ])

  const billings = accounts.length === 0 ? [] : await prisma.metaBilling.findMany({
    where: {
      adAccountId: { in: accounts.map(account => account.id) },
      status: { in: PAID_META_STATUSES },
      billingDate: { lte: today },
    },
    select: { adAccountId: true, amount: true, currency: true, billingDate: true },
  })
  const billingsByAccount = new Map<string, typeof billings>()
  for (const row of billings) {
    const rows = billingsByAccount.get(row.adAccountId) ?? []
    rows.push(row)
    billingsByAccount.set(row.adAccountId, rows)
  }

  const rows: ReserveAccountRow[] = accounts.map(account => {
    const currency = normalizeMetaCurrency(account.currency)
    const manual = account.thresholdSource === 'MANUAL' && account.billingThreshold !== null
    const inferred = manual
      ? null
      : inferThreshold(billingsByAccount.get(account.id) ?? [], {
        today,
        currency,
        windowDays: THRESHOLD_WINDOW_DAYS,
      })
    const threshold = manual ? account.billingThreshold : inferred?.amount ?? null
    const thresholdSource: ThresholdSource | null = manual ? 'MANUAL' : inferred ? 'INFERRED' : null

    const assessment = assessAccountReserve({
      id: account.id,
      accountId: account.accountId,
      accountName: account.accountName,
      currency,
      balance: account.balance,
      balanceSyncedAt: account.balanceSyncedAt,
      budgetRemaining: account.budgetRemaining,
      plannedDailySpend: account.plannedDailySpend,
      activeCampaignCount: account.activeCampaignCount,
      accountStatus: account.accountStatus,
      threshold,
      thresholdSource,
      fundingCardLast4: account.fundingCardLast4,
      excluded: account.excludedFromCashflow,
    }, { now, watchDays: horizonDays })

    return {
      ...assessment,
      projectId: account.projectId,
      balanceCurrency: account.balanceCurrency,
      budgetSyncedAt: account.budgetSyncedAt,
      spendToday: account.spendToday,
      thresholdOccurrences: inferred?.occurrences ?? null,
      thresholdLastSeen: inferred?.lastSeen ?? null,
    }
  })

  const cards: ReserveCard[] = sumReserveByCard(rows, { horizonDays }).map(card => {
    let totalUsd: number | null = 0
    for (const total of card.totals) {
      const usd = convertMetaAmountToUsdDated(total.amount, total.currency, today, schedule)
      if (usd === null) {
        totalUsd = null
        break
      }
      totalUsd += usd
    }
    return { ...card, totalUsd: totalUsd === null ? null : round2(totalUsd) }
  })

  return {
    accounts: rows,
    cards,
    totalReserveUsd: round2(cards.reduce((sum, card) => sum + (card.totalUsd ?? 0), 0)),
    horizonDays,
    today,
    generatedAt: now.toISOString(),
  }
}
