import { describe, expect, it } from 'vitest'
import { convertMetaAmountToUsd, normalizeMetaCurrency, sumMetaAmountsUsd } from './meta-currency'
import { rateForDate, convertMetaAmountToUsdDated, sumMetaAmountsUsdDated } from './meta-currency'

describe('Meta currency conversion', () => {
  it('normalizes currency codes and defaults an empty value to USD', () => {
    expect(normalizeMetaCurrency(' vnd ')).toBe('VND')
    expect(normalizeMetaCurrency(null)).toBe('USD')
  })

  it('keeps USD amounts unchanged', () => {
    expect(convertMetaAmountToUsd(19.99, 'USD')).toBe(19.99)
  })

  it('converts VND to USD using VND per 1 USD', () => {
    expect(convertMetaAmountToUsd(255000, 'VND', 25500)).toBe(10)
  })

  it('does not guess when a non-USD rate is missing', () => {
    expect(convertMetaAmountToUsd(255000, 'VND')).toBeNull()
    expect(convertMetaAmountToUsd(255000, 'VND', 0)).toBeNull()
  })

  it('sums converted rows and reports accounts missing a rate', () => {
    const result = sumMetaAmountsUsd([
      { adAccountId: 'usd', amount: 5, currency: 'USD' },
      { adAccountId: 'vnd', amount: 255000, currency: 'VND' },
      { adAccountId: 'missing', amount: 100000, currency: 'VND' },
    ], new Map([['vnd', 25500]]))

    expect(result.totalUsd).toBe(15)
    expect(result.missingAccountIds).toEqual(['missing'])
  })
})

const sched = [{ effectiveDate: '2026-06-22', rate: 26000 }, { effectiveDate: '2026-07-22', rate: 25500 }]
describe('rateForDate', () => {
  it('picks the latest entry <= date', () => {
    expect(rateForDate(sched, '2026-06-22')).toBe(26000)
    expect(rateForDate(sched, '2026-07-01')).toBe(26000)
    expect(rateForDate(sched, '2026-07-22')).toBe(25500)
    expect(rateForDate(sched, '2026-08-01')).toBe(25500)
  })
  it('uses earliest rate before the first entry', () => { expect(rateForDate(sched, '2026-06-10')).toBe(26000) })
  it('returns null for an empty schedule', () => { expect(rateForDate([], '2026-06-10')).toBeNull() })
})
describe('convertMetaAmountToUsdDated', () => {
  it('USD passes through', () => { expect(convertMetaAmountToUsdDated(19.99, 'USD', '2026-07-01', sched)).toBe(19.99) })
  it('VND uses the dated rate', () => { expect(convertMetaAmountToUsdDated(255000, 'VND', '2026-07-22', sched)).toBe(10) })
  it('null when no rate', () => { expect(convertMetaAmountToUsdDated(255000, 'VND', '2026-07-01', [])).toBeNull() })
})
describe('sumMetaAmountsUsdDated', () => {
  it('sums per-row by date and counts missing', () => {
    const r = sumMetaAmountsUsdDated([
      { amount: 255000, currency: 'VND', billingDate: '2026-07-22' },
      { amount: 5, currency: 'USD', billingDate: '2026-07-22' },
    ], sched)
    expect(r.totalUsd).toBe(15)
    expect(r.missingCount).toBe(0)
  })
})
