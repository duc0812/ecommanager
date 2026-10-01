import { describe, expect, it } from 'vitest'
import { expectedPeriodCashflow } from './cashflow-expected'

// Cashflow Dự kiến = the period's cash, plus what Shopify still owes, minus the Meta debt.
// No "orders not yet in balance" term: the balance and the in-transit payouts already ARE
// the money on its way in, so adding an estimate of it counted the same cash twice.
const ALL_TIME = {
  actualCashflow: 5395.6,
  shopifyBalance: 1386.53,
  inTransitPayout: 5241.25,
  pendingInvoiceCharge: 1002.18,
}

describe('expectedPeriodCashflow', () => {
  it('adds the money Shopify still holds and takes off the unbilled Meta debt', () => {
    expect(expectedPeriodCashflow(ALL_TIME)).toBe(11021.2)
  })

  it('never adds an estimate of orders not yet settled', () => {
    // Order revenue is deliberately not an input: that was the double count.
    expect(expectedPeriodCashflow({ ...ALL_TIME, actualCashflow: 0 })).toBe(5625.6)
  })

  it('falls back to the period cash alone when the balance is unknown', () => {
    // A month that closed before any snapshot recorded its balance: the stock terms drop out
    // instead of borrowing today's figures.
    expect(expectedPeriodCashflow({
      actualCashflow: 2292.71,
      shopifyBalance: null,
      inTransitPayout: null,
      pendingInvoiceCharge: null,
    })).toBe(2292.71)
  })

  it('reads a closed month from the balance its own snapshot recorded', () => {
    expect(expectedPeriodCashflow({
      actualCashflow: 5944.92,
      shopifyBalance: 1386.53,
      inTransitPayout: 5241.25,
      pendingInvoiceCharge: 1002.18,
    })).toBe(11570.52)
  })
})
