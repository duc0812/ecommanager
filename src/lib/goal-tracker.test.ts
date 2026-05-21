import { describe, it, expect } from 'vitest'
import { calcGoalMetrics } from './goal-tracker'

describe('calcGoalMetrics', () => {
  it('calculates avgDaily and projected correctly', () => {
    const result = calcGoalMetrics({
      totalRevenue: 10000,
      daysElapsed: 10,
      daysInMonth: 31,
      monthlyTarget: 30000,
      dailyTarget: 1000,
    })
    expect(result.avgDaily).toBe(1000)
    expect(result.daysRemaining).toBe(21)
    expect(result.projected).toBe(10000 + 1000 * 21)
    expect(result.shortfall).toBe(20000)
    expect(result.neededPerDay).toBeCloseTo(20000 / 21)
    expect(result.paceOk).toBe(true)
    expect(result.monthPct).toBeCloseTo(33.33, 1)
  })

  it('marks paceOk false when avgDaily is below dailyTarget', () => {
    const result = calcGoalMetrics({
      totalRevenue: 5000,
      daysElapsed: 10,
      daysInMonth: 31,
      monthlyTarget: 30000,
      dailyTarget: 1000,
    })
    expect(result.paceOk).toBe(false)
    expect(result.avgDaily).toBe(500)
  })

  it('caps monthPct at 100 when target exceeded', () => {
    const result = calcGoalMetrics({
      totalRevenue: 35000,
      daysElapsed: 25,
      daysInMonth: 31,
      monthlyTarget: 30000,
      dailyTarget: 1000,
    })
    expect(result.monthPct).toBe(100)
    expect(result.shortfall).toBe(0)
  })

  it('handles daysElapsed=0 without dividing by zero', () => {
    const result = calcGoalMetrics({
      totalRevenue: 0,
      daysElapsed: 0,
      daysInMonth: 31,
      monthlyTarget: 30000,
      dailyTarget: 1000,
    })
    expect(result.avgDaily).toBe(0)
    expect(result.projected).toBe(0)
  })

  it('sets neededPerDay to 0 when no days remaining', () => {
    const result = calcGoalMetrics({
      totalRevenue: 10000,
      daysElapsed: 31,
      daysInMonth: 31,
      monthlyTarget: 30000,
      dailyTarget: 1000,
    })
    expect(result.daysRemaining).toBe(0)
    expect(result.neededPerDay).toBe(0)
  })
})
