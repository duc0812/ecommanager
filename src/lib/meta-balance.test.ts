import { describe, expect, it } from 'vitest'
import { metaBalanceToMajor } from './meta-balance'

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
