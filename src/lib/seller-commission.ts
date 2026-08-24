// Seller commission on realized monthly cashflow.
//
// Model (all figures in USD):
//   R(M) = realized cashflow in month M (payouts received − meta billing − FX fee − costs).
//   C(M) = cumulative R over the seller's tenure.
//   B(M) = baseline to beat this month. Profit P(M) = C(M) − B(M).
//   HIT  (P ≥ KPI): commission = P × rate(P); next baseline = C(M).
//   MISS (P < KPI, incl. negative): commission = 0; next baseline = max(C(M), B(M)) + KPI
//        (raises the bar and adds the missed KPI — penalties compound over consecutive misses).
// Rate is applied to the WHOLE profit by bracket (not marginal).

export const KPI = 1000

const TIERS = [
  { min: 5000, rate: 0.20 },
  { min: 1500, rate: 0.15 },
  { min: 1000, rate: 0.10 },
]

export function commissionRate(profit: number): number {
  if (profit < KPI) return 0
  for (const t of TIERS) if (profit >= t.min) return t.rate
  return 0
}

export type MonthCommission = {
  month: string
  realized: number
  cumulative: number
  baseline: number
  profit: number
  met: boolean
  rate: number
  commission: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function computeSellerCommission(months: { month: string; realized: number }[]): { rows: MonthCommission[]; totalCommission: number } {
  let cumulative = 0
  let baseline = 0
  let total = 0
  const rows = months.map(m => {
    cumulative += m.realized
    const usedBaseline = baseline
    const profit = cumulative - usedBaseline
    const met = profit >= KPI
    const rate = met ? commissionRate(profit) : 0
    const commission = met ? round2(profit * rate) : 0
    baseline = met ? cumulative : Math.max(cumulative, baseline) + KPI
    total += commission
    return {
      month: m.month,
      realized: round2(m.realized),
      cumulative: round2(cumulative),
      baseline: round2(usedBaseline),
      profit: round2(profit),
      met,
      rate,
      commission,
    }
  })
  return { rows, totalCommission: round2(total) }
}
