import { describe, it, expect } from 'vitest'
import { classifyProduct, productLaunchDate, type AdInput, type ProductInput } from './presumptions'
import { DEFAULT_STORE_RULES, parseStoreRules } from './store-rules'

const NOW = new Date('2026-10-28T00:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)
const FS = DEFAULT_STORE_RULES['familystore.com']

function ad(startDaysAgo: number, extra: Partial<AdInput> = {}): AdInput {
  return { id: `a${startDaysAgo}${Math.random()}`, isActive: true, startDate: daysAgo(startDaysAgo), endDate: null,
    collationCount: 1, firstCollationCount: 1, everActive: true, observationCount: 1, ...extra }
}
function prod(extra: Partial<ProductInput> = {}): ProductInput {
  return { title: 'Mug', tags: [], publishedAt: daysAgo(200), firstSeenAt: daysAgo(200), bsRank: null, bsPrevRank: null, ads: [], ...extra }
}

describe('classifyProduct — generic rules', () => {
  it('returns null without any signal', () => {
    expect(classifyProduct(prod(), null, NOW)).toBeNull()
  })
  it('best-seller top 100 is sales, top 20 is strong sales', () => {
    expect(classifyProduct(prod({ bsRank: 80 }), null, NOW)?.level).toBe('SALES')
    expect(classifyProduct(prod({ bsRank: 5 }), null, NOW)?.level).toBe('SALES_STRONG')
  })
  it('a climb of 30+ ranks into the top 150 is sales', () => {
    expect(classifyProduct(prod({ bsRank: 140, bsPrevRank: 200 }), null, NOW)?.rules).toContain('BS_CLIMB')
    expect(classifyProduct(prod({ bsRank: 180, bsPrevRank: 240 }), null, NOW)).toBeNull()
  })
  it('an ad alive 10+ days is sales', () => {
    expect(classifyProduct(prod({ ads: [ad(12)] }), null, NOW)?.level).toBe('SALES')
    expect(classifyProduct(prod({ ads: [ad(3)] }), null, NOW)).toBeNull()
  })
  it('a fresh ad next to an older ad is sales', () => {
    const r = classifyProduct(prod({ ads: [ad(2), ad(9, { isActive: false, endDate: daysAgo(5) })] }), null, NOW)
    expect(r?.rules).toContain('AD_NEW_ON_OLD')
  })
  it('3 active ads scale, 6 scale strong; inactive ads do not count', () => {
    expect(classifyProduct(prod({ ads: [ad(2), ad(3), ad(4)] }), null, NOW)?.level).toBe('SCALE')
    expect(classifyProduct(prod({ ads: [ad(2), ad(3), ad(4), ad(5), ad(6), ad(6)] }), null, NOW)?.level).toBe('SCALE_STRONG')
    const off = ad(4, { isActive: false })
    expect(classifyProduct(prod({ ads: [ad(2), ad(3), off] }), null, NOW)).toBeNull()
  })
  it('an ad alive 45+ days is scale', () => {
    expect(classifyProduct(prod({ ads: [ad(50)] }), null, NOW)?.level).toBe('SCALE')
  })
  it('growing ad copies with 2+ active ads is scale', () => {
    const grow = ad(3, { collationCount: 5, firstCollationCount: 2, observationCount: 3 })
    expect(classifyProduct(prod({ ads: [grow, ad(4)] }), null, NOW)?.rules).toContain('ADS_GROWING')
  })
  it('a product 30 days old or younger that scales is new-new scale', () => {
    const r = classifyProduct(prod({ publishedAt: daysAgo(12), ads: [ad(2), ad(3), ad(4)] }), null, NOW)
    expect(r?.level).toBe('NEW_NEW_SCALE')
    expect(classifyProduct(prod({ publishedAt: daysAgo(12), bsRank: 3 }), null, NOW)?.level).toBe('SALES_STRONG')
  })
})

describe('classifyProduct — store tag rules (familystore)', () => {
  it('summer20 is strong sales, hot is strong scale', () => {
    expect(classifyProduct(prod({ tags: ['summer20'] }), FS, NOW)?.level).toBe('SALES_STRONG')
    expect(classifyProduct(prod({ tags: ['hot'] }), FS, NOW)?.level).toBe('SCALE_STRONG')
  })
  it('summer30 needs a live ad; summer20 needs two to scale', () => {
    expect(classifyProduct(prod({ tags: ['summer30'] }), FS, NOW)).toBeNull()
    expect(classifyProduct(prod({ tags: ['summer30'], ads: [ad(1)] }), FS, NOW)?.level).toBe('SALES')
    expect(classifyProduct(prod({ tags: ['summer20'], ads: [ad(1), ad(2)] }), FS, NOW)?.level).toBe('SCALE')
  })
  it('the design code date wins over publishedAt', () => {
    const p = prod({ tags: ['CT6101522YTR', 'hot'], publishedAt: daysAgo(400) })
    expect(productLaunchDate(p, FS).toISOString().slice(0, 10)).toBe('2026-10-15')
    expect(classifyProduct(p, FS, NOW)?.level).toBe('NEW_NEW_SCALE')
  })
  it('killed designs are skipped', () => {
    expect(classifyProduct(prod({ title: 'Delete | Mug', tags: ['hot'] }), FS, NOW)).toBeNull()
  })
})

describe('parseStoreRules', () => {
  it('falls back to the defaults on empty or broken JSON', () => {
    expect(parseStoreRules(null)).toBe(DEFAULT_STORE_RULES)
    expect(parseStoreRules('{nope')).toBe(DEFAULT_STORE_RULES)
  })
  it('normalises domains and drops invalid regexes', () => {
    const m = parseStoreRules(JSON.stringify({ 'https://www.Foo.com/': { salesStrongTags: ['a', ''], codeTagRegex: '(' } }))
    expect(m['foo.com'].salesStrongTags).toEqual(['a'])
    expect(m['foo.com'].codeTagRegex).toBeNull()
  })
})
