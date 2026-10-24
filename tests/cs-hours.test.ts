import { describe, it, expect } from 'vitest'
import { businessMode, effectiveMode } from '@/lib/cs/hours'

const s = { businessHoursStart: 8, businessHoursEnd: 17, weekendIsAfterHours: true }

describe('businessMode (Asia/Ho_Chi_Minh)', () => {
  it('weekday 10:00 VN is business hours', () => expect(businessMode(new Date('2026-10-26T03:00:00Z'), s)).toBe('BUSINESS'))
  it('weekday 08:00 VN sharp is business hours', () => expect(businessMode(new Date('2026-10-26T01:00:00Z'), s)).toBe('BUSINESS'))
  it('weekday 07:59 VN is after hours', () => expect(businessMode(new Date('2026-10-26T00:59:00Z'), s)).toBe('AFTER_HOURS'))
  it('weekday 17:00 VN sharp is after hours', () => expect(businessMode(new Date('2026-10-26T10:00:00Z'), s)).toBe('AFTER_HOURS'))
  it('weekday 22:00 VN is after hours', () => expect(businessMode(new Date('2026-10-26T15:00:00Z'), s)).toBe('AFTER_HOURS'))
  it('Saturday 10:00 VN is after hours when weekends are off', () => expect(businessMode(new Date('2026-10-24T03:00:00Z'), s)).toBe('AFTER_HOURS'))
  it('Saturday 10:00 VN is business hours when weekends count as work days', () => expect(businessMode(new Date('2026-10-24T03:00:00Z'), { ...s, weekendIsAfterHours: false })).toBe('BUSINESS'))
  it('Sunday 10:00 VN is after hours when weekends are off', () => expect(businessMode(new Date('2026-10-25T03:00:00Z'), s)).toBe('AFTER_HOURS'))
})

describe('effectiveMode', () => {
  it('is BUSINESS at night when the after-hours switch is off', () => expect(effectiveMode(new Date('2026-10-26T15:00:00Z'), { ...s, afterHoursAutoReply: false })).toBe('BUSINESS'))
  it('is AFTER_HOURS at night when the switch is on', () => expect(effectiveMode(new Date('2026-10-26T15:00:00Z'), { ...s, afterHoursAutoReply: true })).toBe('AFTER_HOURS'))
  it('is BUSINESS in the day even with the switch on', () => expect(effectiveMode(new Date('2026-10-26T03:00:00Z'), { ...s, afterHoursAutoReply: true })).toBe('BUSINESS'))
})
