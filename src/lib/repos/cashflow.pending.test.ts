import { describe, expect, it } from 'vitest'
import { sumPendingInvoiceChargeUsd } from './cashflow'

const sched = [{ effectiveDate: '2026-01-01', rate: 25500 }]

describe('sumPendingInvoiceChargeUsd', () => {
  it('sums USD balances directly', () => {
    expect(sumPendingInvoiceChargeUsd(
      [{ balance: 100, balanceCurrency: 'USD', excludedFromCashflow: false }, { balance: 50, balanceCurrency: 'USD', excludedFromCashflow: false }],
      '2026-08-31', sched,
    )).toBe(150)
  })
  it('converts VND balance via schedule', () => {
    expect(sumPendingInvoiceChargeUsd(
      [{ balance: 255000, balanceCurrency: 'VND', excludedFromCashflow: false }], '2026-08-31', sched,
    )).toBe(10)
  })
  it('skips null balances and missing-rate accounts', () => {
    expect(sumPendingInvoiceChargeUsd(
      [{ balance: null, balanceCurrency: 'USD', excludedFromCashflow: false }, { balance: 255000, balanceCurrency: 'VND', excludedFromCashflow: false }],
      '2026-08-31', [],
    )).toBe(0)
  })
  it('skips accounts excluded from cashflow (Meta cannot collect on them)', () => {
    expect(sumPendingInvoiceChargeUsd(
      [
        { balance: 100, balanceCurrency: 'USD', excludedFromCashflow: false },
        { balance: 364.55, balanceCurrency: 'USD', excludedFromCashflow: true },
      ],
      '2026-08-31', sched,
    )).toBe(100)
  })
})
