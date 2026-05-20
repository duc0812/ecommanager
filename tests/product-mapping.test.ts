import { describe, expect, it } from 'vitest'
import {
  matchesProductBase,
  matchesAttributeCombo,
  resolveByProductBase,
  type ProductBaseData,
  type VariantManualMappingData,
} from '@/lib/product-mapping'

const tshirt3d: ProductBaseData = {
  id: 'pb1',
  shopifyProductType: '3D Clothing',
  variantConditions: JSON.stringify([
    { optionName: 'Style', anyOf: ['Tshirt'] },
    { optionName: 'Size', anyOf: ['S', 'M', 'L', 'XL'] },
  ]),
  supplierMappings: [
    { preferenceRank: 1, supplierProductId: 'sp_a' },
    { preferenceRank: 2, supplierProductId: 'sp_b' },
  ],
  overrides: [
    { attributeCombo: JSON.stringify({ Size: '6XL' }), supplierProductId: 'sp_b_oversized' },
  ],
}

describe('matchesProductBase', () => {
  it('returns true when all conditions match', () => {
    expect(matchesProductBase('3D Clothing', { Style: 'Tshirt', Size: 'S' }, tshirt3d)).toBe(true)
  })

  it('returns false when productType does not match', () => {
    expect(matchesProductBase('2D Clothing', { Style: 'Tshirt', Size: 'S' }, tshirt3d)).toBe(false)
  })

  it('returns false when a condition value is not in anyOf', () => {
    expect(matchesProductBase('3D Clothing', { Style: 'Tshirt', Size: '3XL' }, tshirt3d)).toBe(false)
  })

  it('returns false when a required option is missing from variantOptions', () => {
    expect(matchesProductBase('3D Clothing', { Style: 'Tshirt' }, tshirt3d)).toBe(false)
  })

  it('is case-insensitive for productType and values', () => {
    expect(matchesProductBase('3d clothing', { style: 'tshirt', size: 'M' }, tshirt3d)).toBe(true)
  })
})

describe('matchesAttributeCombo', () => {
  it('returns true when all combo keys match variantOptions', () => {
    expect(matchesAttributeCombo({ Size: '6XL' }, { Style: 'Tshirt', Size: '6XL' })).toBe(true)
  })

  it('returns false when a combo value does not match', () => {
    expect(matchesAttributeCombo({ Size: '6XL' }, { Style: 'Tshirt', Size: 'XL' })).toBe(false)
  })
})

describe('resolveByProductBase', () => {
  it('returns variant_manual when VariantManualMapping exists', () => {
    const manualMappings: VariantManualMappingData[] = [
      { shopifyVariantId: 'var_123', supplierProductId: 'sp_manual' },
    ]
    const result = resolveByProductBase('var_123', '3D Clothing', { Style: 'Tshirt', Size: 'S' }, [], manualMappings)
    expect(result).toEqual({ supplierProductId: 'sp_manual', resolvedVia: 'variant_manual' })
  })

  it('returns product_base_override when attributeCombo matches', () => {
    const result = resolveByProductBase(null, '3D Clothing', { Style: 'Tshirt', Size: '6XL' }, [tshirt3d], [])
    expect(result).toEqual({ supplierProductId: 'sp_b_oversized', resolvedVia: 'product_base_override' })
  })

  it('returns product_base_rank when no override matches', () => {
    const result = resolveByProductBase(null, '3D Clothing', { Style: 'Tshirt', Size: 'S' }, [tshirt3d], [])
    expect(result).toEqual({ supplierProductId: 'sp_a', resolvedVia: 'product_base_rank' })
  })

  it('returns unresolved when no ProductBase matches', () => {
    const result = resolveByProductBase(null, 'Unknown Type', { Style: 'Mug' }, [tshirt3d], [])
    expect(result).toEqual({ supplierProductId: null, resolvedVia: 'unresolved' })
  })

  it('variant_manual takes priority over product_base_override', () => {
    const manualMappings: VariantManualMappingData[] = [
      { shopifyVariantId: 'var_456', supplierProductId: 'sp_manual_override' },
    ]
    const result = resolveByProductBase('var_456', '3D Clothing', { Style: 'Tshirt', Size: '6XL' }, [tshirt3d], manualMappings)
    expect(result).toEqual({ supplierProductId: 'sp_manual_override', resolvedVia: 'variant_manual' })
  })
})
