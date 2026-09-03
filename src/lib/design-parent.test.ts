import { describe, it, expect } from 'vitest'
import { suggestParentCode, matchParentEntry, type ParentEntry } from './design-parent'

const e = (parentCode: string, over: Partial<ParentEntry> = {}): ParentEntry => ({
  parentCode, supplierId: 'supA', designLink: 'L', designType: 'NON_CUSTOM', ...over,
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

describe('matchParentEntry', () => {
  it('matches when parentCode is a prefix of the sku (case-insensitive), same supplier', () => {
    const m = matchParentEntry('SW15051601-3XL', 'supA', [e('sw15051601')])
    expect(m?.parentCode).toBe('sw15051601')
  })
  it('does not match a different supplier', () => {
    expect(matchParentEntry('SW15051601-3XL', 'supB', [e('SW15051601', { supplierId: 'supA' })])).toBeNull()
  })
  it('prefers the longest matching parentCode', () => {
    const m = matchParentEntry('DN15041511-TS', 'supA', [e('DN15'), e('DN15041511')])
    expect(m?.parentCode).toBe('DN15041511')
  })
  it('null when nothing matches or inputs empty', () => {
    expect(matchParentEntry('ABC-1', 'supA', [e('ZZZ')])).toBeNull()
    expect(matchParentEntry(null, 'supA', [e('ABC')])).toBeNull()
    expect(matchParentEntry('ABC-1', null, [e('ABC')])).toBeNull()
  })
})
