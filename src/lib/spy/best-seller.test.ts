import { describe, it, expect } from 'vitest'
import { rankDelta } from './best-seller'

describe('rankDelta', () => {
  it('returns null when prevRank is missing (NEW)', () => {
    expect(rankDelta(3, null)).toBeNull()
    expect(rankDelta(3, undefined)).toBeNull()
  })
  it('is positive when the product climbed (rank got smaller)', () => {
    expect(rankDelta(3, 5)).toBe(2)
  })
  it('is negative when the product dropped', () => {
    expect(rankDelta(5, 3)).toBe(-2)
  })
  it('is 0 when unchanged', () => {
    expect(rankDelta(4, 4)).toBe(0)
  })
})
