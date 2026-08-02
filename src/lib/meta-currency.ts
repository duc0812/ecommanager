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
