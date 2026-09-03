import { describe, it, expect } from 'vitest'
import { suggestParentCode, matchDesignEntry, type DesignEntry } from './design-parent'

const e = (over: Partial<DesignEntry> = {}): DesignEntry => ({
  sku: 'DN15041511', supplierId: 'supA', matchMode: 'PARENT', designLink: 'L', designType: 'NON_CUSTOM', ...over,
})

describe('suggestParentCode', () => {
  it('takes text before the first dash', () => {
    expect(suggestParentCode('SW15051601-3XL')).toBe('SW15051601')
    expect(suggestParentCode('DN1408261642-ACCENT-MUG-15OZ, RED')).toBe('DN1408261642')
  })
  it('returns whole sku when no dash', () => {
    expect(suggestParentCode('823558')).toBe('823558')
  })
  it('empty for null/empty', () => {
    expect(suggestParentCode(null)).toBe('')
    expect(suggestParentCode('')).toBe('')
  })
})

describe('matchDesignEntry', () => {
  it('PARENT matches by prefix (any size/style reuses)', () => {
    expect(matchDesignEntry('DN15041511-TS', 'supA', [e({ matchMode: 'PARENT', sku: 'DN15041511' })])?.sku).toBe('DN15041511')
  })
  it('VARIANT matches only the exact sku', () => {
    expect(matchDesignEntry('DN15041511-TS', 'supA', [e({ matchMode: 'VARIANT', sku: 'DN15041511-TS' })])?.sku).toBe('DN15041511-TS')
    expect(matchDesignEntry('DN15041511-TL', 'supA', [e({ matchMode: 'VARIANT', sku: 'DN15041511-TS' })])).toBeNull()
  })
  it('VARIANT does not prefix-match', () => {
    expect(matchDesignEntry('DN15041511-TS', 'supA', [e({ matchMode: 'VARIANT', sku: 'DN15041511' })])).toBeNull()
  })
  it('is case-insensitive and supplier-scoped', () => {
    expect(matchDesignEntry('dn15041511-ts', 'supA', [e({ matchMode: 'PARENT', sku: 'DN15041511' })])?.sku).toBe('DN15041511')
    expect(matchDesignEntry('DN15041511-TS', 'supB', [e({ matchMode: 'PARENT', sku: 'DN15041511', supplierId: 'supA' })])).toBeNull()
  })
  it('exact VARIANT wins over a PARENT prefix', () => {
    const entries = [e({ matchMode: 'PARENT', sku: 'DN15041511' }), e({ matchMode: 'VARIANT', sku: 'DN15041511-TS' })]
    expect(matchDesignEntry('DN15041511-TS', 'supA', entries)?.matchMode).toBe('VARIANT')
  })
  it('longest PARENT prefix wins', () => {
    const entries = [e({ matchMode: 'PARENT', sku: 'DN15' }), e({ matchMode: 'PARENT', sku: 'DN15041511' })]
    expect(matchDesignEntry('DN15041511-TS', 'supA', entries)?.sku).toBe('DN15041511')
  })
  it('null on empty inputs', () => {
    expect(matchDesignEntry(null, 'supA', [e()])).toBeNull()
    expect(matchDesignEntry('DN15041511-TS', null, [e()])).toBeNull()
  })
})
