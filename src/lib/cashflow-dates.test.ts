import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getPeriodRange } from './cashflow-dates'

describe('getPeriodRange', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T18:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('this-month runs from the 1st to today in the store timezone', () => {
    const r = getPeriodRange('this-month', 'America/New_York')
    expect(r.fromKey).toBe('2026-09-01')
    expect(r.toKey).toBe('2026-09-06')
    expect(r.from.toISOString()).toBe('2026-09-01T04:00:00.000Z')
    expect(r.to.toISOString()).toBe('2026-09-07T03:59:59.999Z')
  })

  it('today is a single day', () => {
    const r = getPeriodRange('today', 'UTC')
    expect(r.fromKey).toBe('2026-09-06')
    expect(r.toKey).toBe('2026-09-06')
  })

  it('this-week starts on Monday', () => {
    const r = getPeriodRange('this-week', 'UTC')
    expect(r.fromKey).toBe('2026-08-31')
    expect(r.toKey).toBe('2026-09-06')
  })

  it('last-7 and last-30 are inclusive rolling windows ending today', () => {
    expect(getPeriodRange('last-7', 'UTC').fromKey).toBe('2026-08-31')
    expect(getPeriodRange('last-30', 'UTC').fromKey).toBe('2026-08-08')
    expect(getPeriodRange('last-30', 'UTC').toKey).toBe('2026-09-06')
  })

  it('custom uses the given keys and falls back to this-month when incomplete', () => {
    const r = getPeriodRange('custom', 'UTC', '2026-07-01', '2026-07-15')
    expect(r.fromKey).toBe('2026-07-01')
    expect(r.toKey).toBe('2026-07-15')
    expect(getPeriodRange('custom', 'UTC', '2026-07-01', null).fromKey).toBe('2026-09-01')
  })
})
