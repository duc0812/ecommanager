import { describe, expect, it } from 'vitest'
import { expectedPeriodCashflow } from './cashflow-expected'

// The original dashboard formulas, kept verbatim:
//   pendingPayout    = max(0, orderRevenue − payout − inTransit − balance)
//   expectedCashflow = actualCashflow + balance + inTransit − metaDebt + pendingPayout
const ALL_TIME = {
  actualCashflow: 5395.6,
  totalPayout: 115427.21,
  totalOrderNetRevenue: 123721.14,
  shopifyBalance: 4315.88,
  inTransitPayout: 2261.99,
  pendingInvoiceCharge: 1002.18,
}

describe('expectedPeriodCashflow', () => {
  it('reproduces the figures the dashboard showed before', () => {
    expect(expectedPeriodCashflow(ALL_TIME)).toEqual({
      pendingPayout: 1716.06,
      expectedCashflow: 12687.35,
    })
  })

  it('clamps the order gap at zero, as the original did', () => {
    // September: payouts received nearly match orders sold, so the gap goes negative.
    const r = expectedPeriodCashflow({
      actualCashflow: 5944.92,
      totalPayout: 45086,
      totalOrderNetRevenue: 45814.7,
      shopifyBalance: 4315.88,
      inTransitPayout: 2261.99,
      pendingInvoiceCharge: 1002.18,
    })
    expect(r.pendingPayout).toBe(0)
    expect(r.expectedCashflow).toBe(11520.61)
  })

  it('treats an unknown balance as zero so a closed month still gets a figure', () => {
    // A month whose own snapshot never recorded a balance: the stock terms drop out instead
    // of borrowing today's numbers, which is what corrupted seven months of snapshots.
    expect(expectedPeriodCashflow({
      actualCashflow: 2292.71,
      totalPayout: 32217.29,
      totalOrderNetRevenue: 33000,
      shopifyBalance: null,
      inTransitPayout: null,
      pendingInvoiceCharge: null,
    })).toEqual({
      pendingPayout: 782.71,
      expectedCashflow: 3075.42,
    })
  })
})
