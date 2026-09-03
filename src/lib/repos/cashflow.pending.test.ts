import { describe, expect, it } from 'vitest'
import { sumPendingInvoiceChargeUsd } from './cashflow'

const sched = [{ effectiveDate: '2026-01-01', rate: 25500 }]

describe('sumPendingInvoiceChargeUsd', () => {
  it('sums USD balances directly', () => {
    expect(sumPendingInvoiceChargeUsd(
      [{ balance: 100, balanceCurrency: 'USD' }, { balance: 50, balanceCurrency: 'USD' }],
      '2026-08-31', sched,
    )).toBe(150)
  })
  it('converts VND balance via schedule', () => {
    expect(sumPendingInvoiceChargeUsd(
      [{ balance: 255000, balanceCurrency: 'VND' }], '2026-08-31', sched,
    )).toBe(10)
  })
  it('skips null balances and missing-rate accounts', () => {
    expect(sumPendingInvoiceChargeUsd(
      [{ balance: null, balanceCurrency: 'USD' }, { balance: 255000, balanceCurrency: 'VND' }],
      '2026-08-31', [],
    )).toBe(0)
  })
})
