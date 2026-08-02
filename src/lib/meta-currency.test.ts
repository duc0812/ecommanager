import { describe, expect, it } from 'vitest'
import { convertMetaAmountToUsd, normalizeMetaCurrency, sumMetaAmountsUsd } from './meta-currency'

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
