import { describe, expect, it } from 'vitest'
import { findBaseOverlaps } from '@/lib/mapping-conflicts'

const base = (id: string, name: string, type: string, conds: any[]) => ({
  id, name, shopifyProductType: type, variantConditions: JSON.stringify(conds),
})

describe('findBaseOverlaps', () => {
  it('reports nothing when bases share an option and split its values — the correct pattern', () => {
    // Real shape of "2D Cothing": 5 bases, one Style value each, zero conflicts in production.
    const bases = [
      base('a', '2D Clothing Hoodie', '2D Cothing', [{ optionName: 'Style', anyOf: ['Hoodie'] }]),
      base('b', '2D Clothing Zip Hoodie', '2D Cothing', [{ optionName: 'Style', anyOf: ['Zip Hoodie'] }]),
      base('c', '2D Clothing tshirt', '2D Cothing', [{ optionName: 'Style', anyOf: ['T-Shirt'] }]),
    ]
    expect(findBaseOverlaps(bases)).toEqual([])
  })

  it('flags two bases keyed on different options — a line carrying both always matches both', () => {
    // Real shape of "3D Clothing" after 14/09.
    const bases = [
      base('a', '3D Pullover Hoodie', '3D Clothing', [{ optionName: 'Type', anyOf: ['Hoodie'] }]),
      base('b', '3D Clothing', '3D Clothing', [{ optionName: 'Size', anyOf: ['S', 'M', 'L'] }]),
    ]
    const out = findBaseOverlaps(bases)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ shopifyProductType: '3D Clothing', reason: 'different_options' })
    expect(out[0].baseNames.sort()).toEqual(['3D Clothing', '3D Pullover Hoodie'])
  })

  it('flags a base with no conditions, which matches every line of its product type', () => {
    // Real shape of "Baseball Jersey": an empty-condition base beside a Size-keyed one.
    const bases = [
      base('a', 'Baseball Jersey', 'Baseball Jersey', []),
      base('b', 'Baseball Jersey Kid', 'Baseball Jersey', [{ optionName: 'Size', anyOf: ['Kid 6Y'] }]),
    ]
    const out = findBaseOverlaps(bases)
    expect(out).toHaveLength(1)
    expect(out[0].reason).toBe('no_conditions')
  })

  it('flags same option with overlapping values', () => {
    const bases = [
      base('a', 'Adult', 'Tee', [{ optionName: 'Size', anyOf: ['L', 'XL'] }]),
      base('b', 'Big', 'Tee', [{ optionName: 'Size', anyOf: ['XL', '2XL'] }]),
    ]
    const out = findBaseOverlaps(bases)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ reason: 'overlapping_values' })
    expect(out[0].sharedValues).toEqual(['XL'])
  })

  it('treats a trailing "s" as the same value, matching how the resolver compares', () => {
    const bases = [
      base('a', 'Sweat', 'Tee', [{ optionName: 'Type', anyOf: ['Sweatshirt'] }]),
      base('b', 'Sweats', 'Tee', [{ optionName: 'Type', anyOf: ['Sweatshirts'] }]),
    ]
    expect(findBaseOverlaps(bases)).toHaveLength(1)
  })

  it('never compares bases of different product types', () => {
    const bases = [
      base('a', 'A', 'Tee', [{ optionName: 'Size', anyOf: ['L'] }]),
      base('b', 'B', 'Mug', [{ optionName: 'Size', anyOf: ['L'] }]),
    ]
    expect(findBaseOverlaps(bases)).toEqual([])
  })

  it('ignores case and surrounding spaces in the product type, as the resolver does', () => {
    const bases = [
      base('a', 'A', '3D Clothing', [{ optionName: 'Type', anyOf: ['Hoodie'] }]),
      base('b', 'B', '3d clothing ', [{ optionName: 'Size', anyOf: ['L'] }]),
    ]
    expect(findBaseOverlaps(bases)).toHaveLength(1)
  })

  it('reports each pair once, not twice', () => {
    const bases = [
      base('a', 'A', 'Tee', []),
      base('b', 'B', 'Tee', []),
      base('c', 'C', 'Tee', []),
    ]
    expect(findBaseOverlaps(bases)).toHaveLength(3)
  })
})
