export type ExpectedCashflowInput = {
  actualCashflow: number
  shopifyBalance: number | null
  inTransitPayout: number | null
  pendingInvoiceCharge: number | null
}

function round2(value: number) {
  return Math.round(value * 100) / 100
}

// Cashflow Dự kiến: the period's cash, plus the money Shopify still holds for us, minus the
// Meta charge that has not hit the card yet. Order revenue is deliberately NOT an input —
// the balance and the in-transit payouts already are the cash on its way in, so adding an
// estimate of "orders not yet in balance" on top counted the same money twice. A null stock
// term counts as 0: a month that closed before any snapshot recorded its balance falls back
// to its own cash figure instead of borrowing today's.
export function expectedPeriodCashflow(input: ExpectedCashflowInput): number {
  return round2(
    input.actualCashflow
    + (input.shopifyBalance ?? 0)
    + (input.inTransitPayout ?? 0)
    - (input.pendingInvoiceCharge ?? 0),
  )
}
