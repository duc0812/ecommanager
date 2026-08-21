import { describe, it, expect } from 'vitest'
import { AD_SCAN_CAP, isNewAd, activeDays, isLongRunning, isScaling, isStopped } from './ad-signals'

const now = new Date('2026-08-21T00:00:00Z')
describe('ad signals', () => {
  it('AD_SCAN_CAP is 200', () => { expect(AD_SCAN_CAP).toBe(200) })
  it('isNewAd within 7 days', () => {
    expect(isNewAd(new Date('2026-08-18T00:00:00Z'), now)).toBe(true)
    expect(isNewAd(new Date('2026-08-01T00:00:00Z'), now)).toBe(false)
    expect(isNewAd(null, now)).toBe(false)
  })
  it('activeDays counts to now when endDate null', () => {
    expect(activeDays(new Date('2026-08-11T00:00:00Z'), null, now)).toBe(10)
    expect(activeDays(null, null, now)).toBe(0)
  })
  it('isLongRunning requires active + >=21 days', () => {
    expect(isLongRunning({ isActive: true, startDate: new Date('2026-07-01T00:00:00Z'), endDate: null }, now)).toBe(true)
    expect(isLongRunning({ isActive: false, startDate: new Date('2026-07-01T00:00:00Z'), endDate: null }, now)).toBe(false)
    expect(isLongRunning({ isActive: true, startDate: new Date('2026-08-15T00:00:00Z'), endDate: null }, now)).toBe(false)
  })
  it('isScaling when latest collation > earliest', () => {
    expect(isScaling([{ collationCount: 2, observedAt: new Date('2026-08-01') }, { collationCount: 6, observedAt: new Date('2026-08-10') }])).toBe(true)
    expect(isScaling([{ collationCount: 5, observedAt: new Date('2026-08-01') }])).toBe(false)
  })
  it('isScaling returns false when earliest collationCount is null', () => {
    expect(isScaling([{ collationCount: null, observedAt: new Date('2026-08-01') }, { collationCount: 5, observedAt: new Date('2026-08-10') }])).toBe(false)
  })
  it('isStopped when was active then inactive', () => {
    expect(isStopped([{ isActive: true, observedAt: new Date('2026-08-01') }, { isActive: false, observedAt: new Date('2026-08-10') }])).toBe(true)
    expect(isStopped([{ isActive: true, observedAt: new Date('2026-08-10') }])).toBe(false)
  })
})
