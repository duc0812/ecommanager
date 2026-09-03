import { describe, it, expect } from 'vitest'
import { pickParent } from './design-library'

describe('pickParent', () => {
  it('uses explicit parentCode when set', () => {
    expect(pickParent({ parentCode: 'DN15041511', sku: 'DN15041511-TS' })).toBe('DN15041511')
  })
  it('falls back to suggestion from sku', () => {
    expect(pickParent({ parentCode: null, sku: 'DN15041511-TS' })).toBe('DN15041511')
  })
})
