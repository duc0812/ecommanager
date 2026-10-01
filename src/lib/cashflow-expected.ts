export type ExpectedCashflowInput = {
  actualCashflow: number
  totalPayout: number
  totalOrderNetRevenue: number
  shopifyBalance: number | null
  inTransitPayout: number | null
  pendingInvoiceCharge: number | null
}

export type ExpectedCashflow = {
  pendingPayout: number
  expectedCashflow: number
}

function round2(value: number) {
  return Math.round(value * 100) / 100
}

// The original dashboard metric, unchanged: what the period's cash becomes if every order in
// it pays out. A null stock term counts as 0 — a closed month without its own snapshot still
// gets a figure, without borrowing today's balance the way the old backfill did.
export function expectedPeriodCashflow(input: ExpectedCashflowInput): ExpectedCashflow {
  const balance = input.shopifyBalance ?? 0
  const inTransit = input.inTransitPayout ?? 0
  const metaDebt = input.pendingInvoiceCharge ?? 0
  const pendingPayout = Math.max(0, input.totalOrderNetRevenue - input.totalPayout - inTransit - balance)
  return {
    pendingPayout: round2(pendingPayout),
    expectedCashflow: round2(input.actualCashflow + balance + inTransit - metaDebt + pendingPayout),
  }
}
