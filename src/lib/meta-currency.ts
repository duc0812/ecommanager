export type MetaMoney = {
  adAccountId: string
  amount: number
  currency: string | null
}

function roundUsd(amount: number) {
  return Math.round(amount * 100) / 100
}

export function normalizeMetaCurrency(currency: string | null | undefined) {
  return currency?.trim().toUpperCase() || 'USD'
}

/**
 * Convert an amount to USD using units of source currency per 1 USD.
 * Returns null instead of guessing when a non-USD account has no valid rate.
 */
export function convertMetaAmountToUsd(
  amount: number,
  currency: string | null | undefined,
  exchangeRate?: number | null,
) {
  if (!Number.isFinite(amount)) return null
  if (normalizeMetaCurrency(currency) === 'USD') return roundUsd(amount)
  if (!exchangeRate || !Number.isFinite(exchangeRate) || exchangeRate <= 0) return null
  return roundUsd(amount / exchangeRate)
}

export function sumMetaAmountsUsd(
  rows: MetaMoney[],
  exchangeRates: ReadonlyMap<string, number>,
) {
  let totalUsd = 0
  const missingAccountIds = new Set<string>()

  for (const row of rows) {
    const amountUsd = convertMetaAmountToUsd(
      row.amount,
      row.currency,
      exchangeRates.get(row.adAccountId),
    )
    if (amountUsd === null) {
      missingAccountIds.add(row.adAccountId)
      continue
    }
    totalUsd += amountUsd
  }

  return {
    totalUsd: roundUsd(totalUsd),
    missingAccountIds: Array.from(missingAccountIds),
  }
}

export type DatedRate = { effectiveDate: string; rate: number }

export function rateForDate(schedule: DatedRate[], date: string): number | null {
  if (schedule.length === 0) return null
  let chosen: number | null = null
  for (const e of schedule) {
    if (e.effectiveDate <= date) chosen = e.rate
    else break
  }
  return chosen ?? schedule[0].rate
}

export function convertMetaAmountToUsdDated(
  amount: number, currency: string | null | undefined, billingDate: string, schedule: DatedRate[],
): number | null {
  if (normalizeMetaCurrency(currency) === 'USD') return convertMetaAmountToUsd(amount, currency)
  return convertMetaAmountToUsd(amount, currency, rateForDate(schedule, billingDate))
}

export function sumMetaAmountsUsdDated(
  rows: { amount: number; currency: string | null; billingDate: string }[], schedule: DatedRate[],
): { totalUsd: number; missingCount: number } {
  let totalUsd = 0, missingCount = 0
  for (const r of rows) {
    const usd = convertMetaAmountToUsdDated(r.amount, r.currency, r.billingDate, schedule)
    if (usd === null) { missingCount++; continue }
    totalUsd += usd
  }
  return { totalUsd: roundUsd(totalUsd), missingCount }
}
