export const SHOPIFY_PAYOUT_START_DATE = '2026-02-02'

export function payoutStartFor(store: { payoutStartDate: string | null }): string {
  return store.payoutStartDate || SHOPIFY_PAYOUT_START_DATE
}

// The first payout date worth keeping: the later of what a caller asked for and the store's own start.
export function payoutDateMinFor(store: { payoutStartDate: string | null }, requestedDateMin?: string): string {
  const start = payoutStartFor(store)
  return requestedDateMin && requestedDateMin > start ? requestedDateMin : start
}

// Payout filter across stores: each store counts from its own start date.
export function payoutDateWhereForStores(
  stores: Array<{ id: string; payoutStartDate: string | null }>,
  range: { dateMin?: string; dateMax?: string } = {},
) {
  return {
    OR: stores.map(store => ({
      storeId: store.id,
      date: { gte: payoutDateMinFor(store, range.dateMin), ...(range.dateMax ? { lte: range.dateMax } : {}) },
    })),
  }
}
