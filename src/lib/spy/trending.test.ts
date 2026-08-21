import { describe, it, expect } from 'vitest'
import { computeTrendingNiches } from './trending'

const now = new Date('2026-08-21T00:00:00Z')
const d = (iso: string) => new Date(iso)

describe('computeTrendingNiches', () => {
  it('counts current vs previous window and computes deltaPct', () => {
    const products = [
      // current window (Aug 14..21): 3 Shirt
      { productType: 'Shirt', firstSeenAt: d('2026-08-20T00:00:00Z'), store: { domain: 'a.com' } },
      { productType: 'Shirt', firstSeenAt: d('2026-08-19T00:00:00Z'), store: { domain: 'a.com' } },
      { productType: 'Shirt', firstSeenAt: d('2026-08-18T00:00:00Z'), store: { domain: 'b.com' } },
      // previous window (Aug 7..14): 2 Shirt
      { productType: 'Shirt', firstSeenAt: d('2026-08-10T00:00:00Z'), store: { domain: 'a.com' } },
      { productType: 'Shirt', firstSeenAt: d('2026-08-09T00:00:00Z'), store: { domain: 'a.com' } },
    ]
    const [shirt] = computeTrendingNiches(products, { now, windowDays: 7 })
    expect(shirt.niche).toBe('Shirt')
    expect(shirt.newCount).toBe(3)
    expect(shirt.prevCount).toBe(2)
    expect(shirt.deltaPct).toBe(50) // (3-2)/2 = 50%
    expect(shirt.topStores).toEqual(['a.com', 'b.com']) // a.com=2, b.com=1
  })

  it('deltaPct is 100 when previous window is empty but new exists', () => {
    const [n] = computeTrendingNiches([{ productType: 'Mug', firstSeenAt: d('2026-08-20T00:00:00Z') }], { now, windowDays: 7 })
    expect(n.deltaPct).toBe(100)
    expect(n.prevCount).toBe(0)
  })

  it('null productType becomes Uncategorized; only niches with newCount>0 returned; sorted desc', () => {
    const products = [
      { productType: null, firstSeenAt: d('2026-08-20T00:00:00Z') },
      { productType: 'Old', firstSeenAt: d('2026-08-09T00:00:00Z') }, // prev only → excluded
    ]
    const rows = computeTrendingNiches(products, { now, windowDays: 7 })
    expect(rows.map(r => r.niche)).toEqual(['Uncategorized'])
  })
})
