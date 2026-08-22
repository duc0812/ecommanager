import { describe, it, expect } from 'vitest'
import { isUnlimited, vnDay, SCAN_DAILY_LIMIT } from './scan-quota'

describe('isUnlimited', () => {
  it('admins are unlimited', () => { expect(isUnlimited('SUPERADMIN')).toBe(true); expect(isUnlimited('ADMIN')).toBe(true) })
  it('sellers/support are limited', () => { expect(isUnlimited('SELLER')).toBe(false); expect(isUnlimited('SUPPORT')).toBe(false) })
})
describe('vnDay', () => {
  it('formats YYYY-MM-DD', () => { expect(vnDay(new Date('2026-08-22T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/) })
  it('uses Asia/Ho_Chi_Minh (UTC+7) — 18:00Z is next day', () => {
    expect(vnDay(new Date('2026-08-22T18:00:00Z'))).toBe('2026-08-23')
  })
  it('default limit is 2', () => { expect(SCAN_DAILY_LIMIT).toBe(2) })
})
