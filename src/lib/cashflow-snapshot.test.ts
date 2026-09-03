import { describe, expect, it } from 'vitest'
import { monthEndDateKey, listPeriodMonths, previousMonth, monthlyProfit } from './cashflow-snapshot'

describe('monthEndDateKey', () => {
  it('returns last calendar day of month', () => {
    expect(monthEndDateKey('2026-07', 'America/Denver')).toBe('2026-07-31')
    expect(monthEndDateKey('2026-02', 'America/Denver')).toBe('2026-02-28')
  })
})

describe('listPeriodMonths', () => {
  it('lists months from project start month through target inclusive', () => {
    expect(listPeriodMonths(new Date('2026-02-12T00:00:00Z'), '2026-05', 'America/Denver'))
      .toEqual(['2026-02', '2026-03', '2026-04', '2026-05'])
  })
})

describe('previousMonth', () => {
  it('rolls back across year', () => {
    expect(previousMonth('2026-01')).toBe('2025-12')
    expect(previousMonth('2026-08')).toBe('2026-07')
  })
})

describe('monthlyProfit', () => {
  it('is the delta vs previous, or the value itself for first month', () => {
    expect(monthlyProfit(3000, 1100)).toBe(1900)
    expect(monthlyProfit(1100, null)).toBe(1100)
  })
})
