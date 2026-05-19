import { describe, it, expect } from 'vitest'
import { dayBoundaryUS, formatBothZones, US_EASTERN, US_PACIFIC } from '@/lib/timezone'

describe('dayBoundaryUS', () => {
  it('returns start and end of day in US Eastern as UTC instants', () => {
    const { startUtc, endUtc } = dayBoundaryUS('2026-05-19', US_EASTERN)
    expect(startUtc.toISOString()).toBe('2026-05-19T04:00:00.000Z')
    expect(endUtc.toISOString()).toBe('2026-05-20T03:59:59.999Z')
  })

  it('handles US Pacific (PT) — UTC-7 in May (PDT)', () => {
    const { startUtc, endUtc } = dayBoundaryUS('2026-05-19', US_PACIFIC)
    expect(startUtc.toISOString()).toBe('2026-05-19T07:00:00.000Z')
    expect(endUtc.toISOString()).toBe('2026-05-20T06:59:59.999Z')
  })
})

describe('formatBothZones', () => {
  it('returns VN and US strings for an instant', () => {
    const d = new Date('2026-05-19T00:06:00Z')
    const r = formatBothZones(d)
    expect(r.vn).toMatch(/2026-05-19 07:06/)
    expect(r.usEastern).toMatch(/2026-05-18 20:06/)
  })
})
