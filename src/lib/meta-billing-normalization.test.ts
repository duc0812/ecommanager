import { describe, expect, it } from 'vitest'
import {
  metaBillingDateInTimezone,
  metaCurrencyMinorUnitDigits,
  normalizeMetaActivityAmount,
} from './meta-billing-normalization'

describe('Meta billing normalization', () => {
  it('keeps VND activity amounts in whole dong', () => {
    expect(metaCurrencyMinorUnitDigits('VND')).toBe(0)
    expect(normalizeMetaActivityAmount(57_680, 'VND')).toBe(57_680)
    expect(normalizeMetaActivityAmount('101,910', 'VND')).toBe(101_910)
  })

  it('converts currencies that Meta reports in minor units', () => {
    expect(metaCurrencyMinorUnitDigits('USD')).toBe(2)
    expect(normalizeMetaActivityAmount(57_680, 'USD')).toBe(576.8)
  })

  it('uses the ad-account timezone for the billing date', () => {
    expect(metaBillingDateInTimezone('2026-06-19T04:28:19+0000', 'America/Los_Angeles')).toBe('2026-06-18')
    expect(metaBillingDateInTimezone('2026-06-19T04:28:19+0000', 'UTC')).toBe('2026-06-19')
  })
})
