import { parseKeywords, nicheMatches } from '@/lib/spy/niche'
import { productLinesOnly } from '@/lib/order-lines'
import { convertMetaAmountToUsdDated, normalizeMetaCurrency, type DatedRate } from '@/lib/meta-currency'
import { addDays } from '@/lib/cashflow-dates'

export type NicheInput = { id: string; name: string; keywords: string; active: boolean; sortOrder: number }
export type OverrideInput = { campaignId: string; nicheId: string }
export type AccountInput = { id: string; accountId: string; accountName: string | null; currency: string | null }
export type CampaignSpendInput = {
  adAccountId: string
  campaignId: string
  campaignName: string
  date: string
  spend: number
  impressions: number
  clicks: number
  currency: string | null
}
export type OrderLineInput = { sku: string | null; productTitle: string; shopifyProductType: string | null; unitPrice: number; qty: number }
export type OrderInput = { id: string; refundedAmount: number; lines: OrderLineInput[] }

export type NichePerformanceInput = {
  period: { from: string; to: string; timeZone: string }
  niches: NicheInput[]
  overrides: OverrideInput[]
  accounts: AccountInput[]
  campaignSpends: CampaignSpendInput[]
  orders: OrderInput[]
  schedule: DatedRate[]
}

export type CampaignRow = {
  campaignId: string
  campaignName: string
  accountId: string
  accountName: string | null
  spend: number
  spendOriginal: number
  currency: string
  impressions: number
  clicks: number
  cpm: number | null
  ctr: number | null
  lastActiveDate: string | null
  isActive: boolean
}

export type NicheRow = {
  nicheId: string
  name: string
  spend: number
  revenue: number
  roas: number | null
  orders: number
  aov: number
  campaignCount: number
  activeCampaignCount: number
  campaigns: CampaignRow[]
}

export type NichePerformanceResult = {
  period: { from: string; to: string; timeZone: string }
  totals: { spend: number; revenue: number; roas: number | null; orders: number }
  niches: NicheRow[]
  unassigned: { spend: number; revenue: number; campaigns: CampaignRow[] }
  missingExchangeRateAccounts: Array<{ accountId: string; accountName: string | null; currency: string }>
}

const ACTIVE_WINDOW_DAYS = 3

type CampaignAgg = CampaignRow & { latestDate: string; nicheId: string | null }

function roas(revenue: number, spend: number) {
  return spend > 0 ? revenue / spend : null
}

export function computeNichePerformance(input: NichePerformanceInput): NichePerformanceResult {
  const activeNiches = input.niches
    .filter(n => n.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(n => ({ ...n, kws: parseKeywords(n.keywords) }))
  const activeIds = new Set(activeNiches.map(n => n.id))
  const overrideMap = new Map(input.overrides.filter(o => activeIds.has(o.nicheId)).map(o => [o.campaignId, o.nicheId]))
  const accountMap = new Map(input.accounts.map(a => [a.id, a]))
  const matchNiche = (text: string) => activeNiches.find(n => nicheMatches(text, n.kws))?.id ?? null

  const activeThreshold = addDays(input.period.to, -(ACTIVE_WINDOW_DAYS - 1))
  const campaigns = new Map<string, CampaignAgg>()
  const missingRate = new Map<string, AccountInput>()

  for (const s of input.campaignSpends) {
    const account = accountMap.get(s.adAccountId)
    const currency = normalizeMetaCurrency(account?.currency || s.currency)
    const usd = convertMetaAmountToUsdDated(s.spend, currency, s.date, input.schedule)
    if (usd === null && s.spend > 0) {
      if (account) {
        missingRate.set(account.id, account)
      } else {
        missingRate.set(s.adAccountId, { id: s.adAccountId, accountId: s.adAccountId, accountName: null, currency })
      }
    }

    let c = campaigns.get(s.campaignId)
    if (!c) {
      c = {
        campaignId: s.campaignId,
        campaignName: s.campaignName,
        accountId: account?.accountId ?? s.adAccountId,
        accountName: account?.accountName ?? null,
        spend: 0,
        spendOriginal: 0,
        currency,
        impressions: 0,
        clicks: 0,
        cpm: null,
        ctr: null,
        lastActiveDate: null,
        isActive: false,
        latestDate: '',
        nicheId: null,
      }
      campaigns.set(s.campaignId, c)
    }
    c.spend += usd ?? 0
    c.spendOriginal += s.spend
    c.impressions += s.impressions
    c.clicks += s.clicks
    if (s.date >= c.latestDate) {
      c.latestDate = s.date
      c.campaignName = s.campaignName
    }
    if (s.spend > 0 && (!c.lastActiveDate || s.date > c.lastActiveDate)) c.lastActiveDate = s.date
  }

  for (const c of Array.from(campaigns.values())) {
    c.nicheId = overrideMap.get(c.campaignId) ?? matchNiche(c.campaignName)
    c.cpm = c.impressions > 0 ? (c.spend / c.impressions) * 1000 : null
    c.ctr = c.impressions > 0 ? c.clicks / c.impressions : null
    c.isActive = c.lastActiveDate != null && c.lastActiveDate >= activeThreshold
  }

  const revenueByNiche = new Map<string, number>()
  const ordersByNiche = new Map<string, Set<string>>()
  let unassignedRevenue = 0
  const allOrders = new Set<string>()

  for (const order of input.orders) {
    const lines = productLinesOnly(order.lines)
    if (lines.length === 0) continue
    allOrders.add(order.id)
    const gross = lines.map(l => l.unitPrice * l.qty)
    const total = gross.reduce((a, b) => a + b, 0)
    const refund = Math.max(0, order.refundedAmount || 0)
    lines.forEach((l, i) => {
      const lineRefund = total > 0 ? (refund * gross[i]) / total : 0
      const net = Math.max(0, gross[i] - lineRefund)
      const nicheId = matchNiche(l.productTitle)
      if (!nicheId) {
        unassignedRevenue += net
        return
      }
      revenueByNiche.set(nicheId, (revenueByNiche.get(nicheId) ?? 0) + net)
      if (!ordersByNiche.has(nicheId)) ordersByNiche.set(nicheId, new Set())
      ordersByNiche.get(nicheId)!.add(order.id)
    })
  }

  const toRow = (agg: CampaignAgg): CampaignRow => {
    const { latestDate, nicheId, ...row } = agg
    void latestDate
    void nicheId
    return row
  }
  const bySpendDesc = (a: { spend: number }, b: { spend: number }) => b.spend - a.spend

  const campaignsList = Array.from(campaigns.values())
  const niches: NicheRow[] = activeNiches.map(n => {
    const rows = campaignsList.filter(c => c.nicheId === n.id).sort(bySpendDesc).map(toRow)
    const spend = rows.reduce((s, c) => s + c.spend, 0)
    const revenue = revenueByNiche.get(n.id) ?? 0
    const orders = ordersByNiche.get(n.id)?.size ?? 0
    return {
      nicheId: n.id,
      name: n.name,
      spend,
      revenue,
      roas: roas(revenue, spend),
      orders,
      aov: orders > 0 ? revenue / orders : 0,
      campaignCount: rows.length,
      activeCampaignCount: rows.filter(c => c.isActive).length,
      campaigns: rows,
    }
  }).sort(bySpendDesc)

  const unassignedCampaigns = campaignsList.filter(c => c.nicheId === null).sort(bySpendDesc).map(toRow)
  const unassignedSpend = unassignedCampaigns.reduce((s, c) => s + c.spend, 0)

  const totalSpend = niches.reduce((s, n) => s + n.spend, 0) + unassignedSpend
  const totalRevenue = niches.reduce((s, n) => s + n.revenue, 0) + unassignedRevenue

  return {
    period: input.period,
    totals: { spend: totalSpend, revenue: totalRevenue, roas: roas(totalRevenue, totalSpend), orders: allOrders.size },
    niches,
    unassigned: { spend: unassignedSpend, revenue: unassignedRevenue, campaigns: unassignedCampaigns },
    missingExchangeRateAccounts: Array.from(missingRate.values()).map(a => ({
      accountId: a.accountId,
      accountName: a.accountName,
      currency: normalizeMetaCurrency(a.currency),
    })),
  }
}
