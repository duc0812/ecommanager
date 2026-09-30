import { addDays } from '@/lib/cashflow-dates'
import { metaBalanceToMajor } from '@/lib/meta-balance'
import { normalizeMetaCurrency } from '@/lib/meta-currency'

// Meta charges the card when the unbilled balance reaches the account's billing threshold.
// Graph API v22.0 exposes neither the threshold nor the next bill date (the `adspaymentcycles`
// edge and every `*threshold*` field return 400), so the threshold is inferred from the
// repeated charge amounts in billing history, or entered by hand.
const CLUSTER_TOLERANCE = 0.01
const DEFAULT_WINDOW_DAYS = 60
const MIN_OCCURRENCES = 2
const UNSETTLED_ACCOUNT_STATUSES = new Set([2, 3, 9])

export const WATCH_DAYS = 3
export const STALE_DAYS = 2

export type ReserveLevel = 'OK' | 'WATCH' | 'URGENT' | 'UNKNOWN'
export type ThresholdSource = 'MANUAL' | 'INFERRED'

export type ReserveBilling = { billingDate: string; amount: number; currency: string }
export type InferredThreshold = { amount: number; currency: string; occurrences: number; lastSeen: string }

function round2(value: number) {
  return Math.round(value * 100) / 100
}

export function inferThreshold(
  billings: ReserveBilling[],
  { today, currency, windowDays = DEFAULT_WINDOW_DAYS }: { today: string; currency: string; windowDays?: number },
): InferredThreshold | null {
  const code = normalizeMetaCurrency(currency)
  const since = addDays(today, -windowDays)
  const rows = billings
    .filter(row =>
      normalizeMetaCurrency(row.currency) === code
      && row.billingDate >= since
      && row.billingDate <= today
      && Number.isFinite(row.amount)
      && row.amount > 0)
    .sort((a, b) => b.amount - a.amount)

  const clusters: { amount: number; occurrences: number; lastSeen: string }[] = []
  for (const row of rows) {
    const current = clusters[clusters.length - 1]
    if (current && (current.amount - row.amount) / current.amount <= CLUSTER_TOLERANCE) {
      current.occurrences += 1
      if (row.billingDate > current.lastSeen) current.lastSeen = row.billingDate
      continue
    }
    clusters.push({ amount: row.amount, occurrences: 1, lastSeen: row.billingDate })
  }

  const candidates = clusters.filter(cluster => cluster.occurrences >= MIN_OCCURRENCES)
  if (candidates.length === 0) return null
  // Meta raises the threshold as an account matures, so the newest cluster is the live one.
  candidates.sort((a, b) =>
    b.lastSeen.localeCompare(a.lastSeen)
    || b.occurrences - a.occurrences
    || b.amount - a.amount)

  const best = candidates[0]
  return { amount: best.amount, currency: code, occurrences: best.occurrences, lastSeen: best.lastSeen }
}

export type BudgetEntity = {
  id?: string
  campaign_id?: string
  effective_status?: string
  daily_budget?: string | number | null
  lifetime_budget?: string | number | null
  budget_remaining?: string | number | null
  stop_time?: string | null
}

export type BudgetSummary = {
  budgetRemaining: number
  plannedDailySpend: number
  spendToday: number
  activeCampaignCount: number
}

function daysUntil(stopTime: string, today: string) {
  const stopKey = stopTime.slice(0, 10)
  const diff = Math.round(
    (Date.parse(`${stopKey}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  )
  return Number.isFinite(diff) ? Math.max(1, diff) : 1
}

export function summarizeBudgets({
  campaigns,
  adsets,
  currency,
  today,
}: {
  campaigns: BudgetEntity[]
  adsets: BudgetEntity[]
  currency: string
  today: string
}): BudgetSummary {
  const major = (raw: unknown) => metaBalanceToMajor(raw, currency)
  const isActive = (entity: BudgetEntity) => entity.effective_status === 'ACTIVE'
  const activeCampaigns = campaigns.filter(isActive)

  let budgetRemaining = 0
  let plannedDailySpend = 0
  let spendToday = 0

  const add = (entity: BudgetEntity) => {
    const daily = major(entity.daily_budget) ?? 0
    const lifetime = major(entity.lifetime_budget) ?? 0
    const remaining = major(entity.budget_remaining)
    if (daily > 0) {
      budgetRemaining += remaining ?? daily
      plannedDailySpend += daily
      // Meta takes today's spend straight out of budget_remaining, so the gap IS today's spend.
      if (remaining !== null) spendToday += Math.max(0, daily - remaining)
      return true
    }
    if (lifetime > 0) {
      const left = remaining ?? lifetime
      budgetRemaining += left
      plannedDailySpend += left / (entity.stop_time ? daysUntil(entity.stop_time, today) : 1)
      return true
    }
    return false
  }

  for (const campaign of activeCampaigns) {
    if (add(campaign)) continue
    // Budget lives on the ad sets (ABO), so read them instead of counting the campaign as zero.
    for (const adset of adsets) {
      if (adset.campaign_id !== campaign.id || !isActive(adset)) continue
      add(adset)
    }
  }

  return {
    budgetRemaining: round2(budgetRemaining),
    plannedDailySpend: round2(plannedDailySpend),
    spendToday: round2(spendToday),
    activeCampaignCount: activeCampaigns.length,
  }
}

export type ReserveAccountInput = {
  id: string
  accountId: string
  accountName: string | null
  currency: string
  balance: number | null
  balanceSyncedAt: Date | null
  budgetRemaining: number | null
  plannedDailySpend: number | null
  activeCampaignCount: number | null
  accountStatus: number | null
  threshold: number | null
  thresholdSource: ThresholdSource | null
  fundingCardLast4: string | null
  // Dead accounts Meta can no longer collect on: still shown, never counted as money to prepare.
  excluded: boolean
}

export type ReserveAssessment = ReserveAccountInput & {
  projectedBalance: number | null
  headroom: number | null
  daysToCharge: number | null
  chargeAmount: number | null
  willCross: boolean
  staleDays: number | null
  level: ReserveLevel
  reasons: string[]
}

export function assessAccountReserve(
  account: ReserveAccountInput,
  { now, watchDays = WATCH_DAYS }: { today?: string; now: Date; watchDays?: number },
): ReserveAssessment {
  const reasons: string[] = []
  const staleDays = account.balanceSyncedAt
    ? Math.max(0, Math.floor((now.getTime() - account.balanceSyncedAt.getTime()) / 86_400_000))
    : null
  if (staleDays === null || staleDays >= STALE_DAYS) reasons.push('STALE_DATA')

  const unsettled = account.accountStatus !== null && UNSETTLED_ACCOUNT_STATUSES.has(account.accountStatus)
  if (unsettled) reasons.push('UNSETTLED')
  if (account.threshold === null) reasons.push('NO_THRESHOLD')
  if (account.balance === null) reasons.push('NO_BALANCE')

  const dailySpend = account.plannedDailySpend ?? 0
  if (dailySpend <= 0) reasons.push('NO_ACTIVE_SPEND')

  const headroom = account.threshold === null || account.balance === null
    ? null
    : round2(Math.max(0, account.threshold - account.balance))
  const projectedBalance = account.balance === null
    ? null
    : round2(account.balance + (account.budgetRemaining ?? 0))
  const alreadyOver = account.threshold !== null && account.balance !== null && account.balance >= account.threshold
  const willCross = account.threshold !== null && projectedBalance !== null && projectedBalance >= account.threshold
  const daysToCharge = headroom === null || dailySpend <= 0 ? null : round2(headroom / dailySpend)

  // Once the balance is past the threshold, or Meta could not settle it, the card must cover
  // the whole unpaid balance - not just one threshold's worth.
  const chargeAmount = account.balance !== null && (unsettled || alreadyOver)
    ? round2(Math.max(account.balance, account.threshold ?? 0))
    : account.threshold

  if (alreadyOver) reasons.push('ALREADY_OVER')
  else if (willCross) reasons.push('WILL_CROSS')
  else if (daysToCharge !== null && daysToCharge <= watchDays) reasons.push('DUE_SOON')

  let level: ReserveLevel
  if (unsettled) level = 'URGENT'
  else if (account.threshold === null || account.balance === null) level = 'UNKNOWN'
  else if (alreadyOver || willCross) level = 'URGENT'
  else if (daysToCharge !== null && daysToCharge <= watchDays) level = 'WATCH'
  else level = 'OK'

  return {
    ...account,
    projectedBalance,
    headroom,
    daysToCharge,
    chargeAmount,
    willCross,
    staleDays,
    level,
    reasons,
  }
}

export type CardReserve = {
  cardLast4: string | null
  level: ReserveLevel
  accountIds: string[]
  totals: { currency: string; amount: number }[]
}

const LEVEL_RANK: Record<ReserveLevel, number> = { URGENT: 3, WATCH: 2, UNKNOWN: 1, OK: 0 }

export function sumReserveByCard(
  assessments: ReserveAssessment[],
  { horizonDays = WATCH_DAYS }: { horizonDays?: number } = {},
): CardReserve[] {
  const due = assessments.filter(row =>
    !row.excluded
    && row.chargeAmount !== null
    && (row.level === 'URGENT' || (row.daysToCharge !== null && row.daysToCharge <= horizonDays)))

  const groups = new Map<string, CardReserve & { totalsByCurrency: Map<string, number> }>()
  for (const row of due) {
    const key = row.fundingCardLast4 ?? ''
    let group = groups.get(key)
    if (!group) {
      group = {
        cardLast4: row.fundingCardLast4 ?? null,
        level: 'OK',
        accountIds: [],
        totals: [],
        totalsByCurrency: new Map(),
      }
      groups.set(key, group)
    }
    group.accountIds.push(row.accountId)
    if (LEVEL_RANK[row.level] > LEVEL_RANK[group.level]) group.level = row.level
    const currency = normalizeMetaCurrency(row.currency)
    group.totalsByCurrency.set(currency, (group.totalsByCurrency.get(currency) ?? 0) + (row.chargeAmount ?? 0))
  }

  return Array.from(groups.values())
    .map(({ totalsByCurrency, ...group }) => ({
      ...group,
      totals: Array.from(totalsByCurrency.entries())
        .map(([currency, amount]) => ({ currency, amount: round2(amount) }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    }))
    .sort((a, b) => {
      if (a.cardLast4 === null) return b.cardLast4 === null ? 0 : 1
      if (b.cardLast4 === null) return -1
      return a.cardLast4.localeCompare(b.cardLast4)
    })
}
