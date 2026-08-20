import { describe, it, expect } from 'vitest'
import { isNewProduct, groupByNiche } from './signals'

describe('spy signals', () => {
  it('isNewProduct true within window', () => {
    const now = new Date('2026-08-20T00:00:00Z')
    expect(isNewProduct(new Date('2026-08-18T00:00:00Z'), now, 7)).toBe(true)
    expect(isNewProduct(new Date('2026-08-01T00:00:00Z'), now, 7)).toBe(false)
  })
  it('groupByNiche counts and sorts desc', () => {
    const g = groupByNiche([{ productType: 'Shirt' }, { productType: 'Shirt' }, { productType: null }])
    expect(g[0]).toEqual({ niche: 'Shirt', count: 2 })
    expect(g).toContainEqual({ niche: 'Uncategorized', count: 1 })
  })
})
