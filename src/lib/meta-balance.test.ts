import { describe, expect, it } from 'vitest'
import { buildAccountBalanceUpdate, metaBalanceToMajor } from './meta-balance'

describe('metaBalanceToMajor', () => {
  it('divides 2-decimal currencies by 100', () => {
    expect(metaBalanceToMajor('1050', 'USD')).toBe(10.5)
    expect(metaBalanceToMajor('0', 'USD')).toBe(0)
  })
  it('keeps zero-decimal currencies as-is', () => {
    expect(metaBalanceToMajor('263274537', 'VND')).toBe(263274537)
    expect(metaBalanceToMajor('5000', 'JPY')).toBe(5000)
  })
  it('normalizes currency casing/whitespace', () => {
    expect(metaBalanceToMajor('1050', ' usd ')).toBe(10.5)
  })
  it('returns null for missing/invalid input', () => {
    expect(metaBalanceToMajor(null, 'USD')).toBeNull()
    expect(metaBalanceToMajor(undefined, 'USD')).toBeNull()
    expect(metaBalanceToMajor('abc', 'USD')).toBeNull()
    expect(metaBalanceToMajor('', 'USD')).toBeNull()
  })
})

describe('buildAccountBalanceUpdate', () => {
  const now = new Date('2026-09-04T00:00:00Z')
  it('parses balance and stamps currency + syncedAt', () => {
    const r = buildAccountBalanceUpdate({ balance: '263274537', currency: 'VND' }, 'VND', now)
    expect(r).toEqual({ balance: 263274537, balanceCurrency: 'VND', balanceSyncedAt: now })
  })
  it('prefers account currency arg over json currency', () => {
    const r = buildAccountBalanceUpdate({ balance: '1050' }, 'USD', now)
    expect(r).toEqual({ balance: 10.5, balanceCurrency: 'USD', balanceSyncedAt: now })
  })
  it('returns null balance when field absent', () => {
    const r = buildAccountBalanceUpdate({}, 'USD', now)
    expect(r).toEqual({ balance: null, balanceCurrency: 'USD', balanceSyncedAt: now })
  })
})
