import { describe, expect, it } from 'vitest'
import { monthEndDateKey, listPeriodMonths, previousMonth, monthlyProfit, effectiveExpectedCashflow, snapshotCloseDateKey } from './cashflow-snapshot'

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

describe('effectiveExpectedCashflow', () => {
  it('prefers a hand-entered figure over the computed one', () => {
    // Months that closed before any balance was recorded compute too low, so the owner
    // corrects them by hand; a backfill recomputes the other column and leaves this one.
    expect(effectiveExpectedCashflow({ expectedCashflow: -549.33, expectedCashflowManual: 6300 })).toBe(6300)
  })

  it('falls back to the computed figure', () => {
    expect(effectiveExpectedCashflow({ expectedCashflow: 8052.5, expectedCashflowManual: null })).toBe(8052.5)
  })

  it('stays unknown when neither exists', () => {
    expect(effectiveExpectedCashflow({ expectedCashflow: null, expectedCashflowManual: null })).toBeNull()
  })

  it('accepts a corrected zero rather than treating it as absent', () => {
    expect(effectiveExpectedCashflow({ expectedCashflow: 100, expectedCashflowManual: 0 })).toBe(0)
  })

  it('feeds the month profit, so a correction moves the delta', () => {
    const august = effectiveExpectedCashflow({ expectedCashflow: -549.33, expectedCashflowManual: 6300 })
    const september = effectiveExpectedCashflow({ expectedCashflow: 8052.5, expectedCashflowManual: null })
    expect(monthlyProfit(september, august)).toBe(1752.5)
  })
})

describe('snapshotCloseDateKey', () => {
  it('names the day the month was closed, which is the 1st after it', () => {
    // The owner thinks in close dates: "snapshot 1/9" is the August row.
    expect(snapshotCloseDateKey('2026-08')).toBe('2026-09-01')
    expect(snapshotCloseDateKey('2026-12')).toBe('2027-01-01')
  })
})
