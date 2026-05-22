import { describe, expect, it } from 'vitest'
import { resolveByProductBase } from '@/lib/product-mapping'

const productBases = [
  {
    id: 'base-3d-tshirt',
    shopifyProductType: '3D Clothing',
    variantConditions: JSON.stringify([{ optionName: 'Type', anyOf: ['Tshirt'] }]),
    supplierMappings: [{ preferenceRank: 1, supplierProductId: 'supplier-product-tshirt' }],
    overrides: [],
  },
]

describe('resolveByProductBase', () => {
  it('does not fallback to product base rank when product type is missing', () => {
    const result = resolveByProductBase(
      null,
      null,
      { Type: 'Tshirt', Size: 'L' },
      productBases,
      [],
    )

    expect(result).toEqual({ supplierProductId: null, resolvedVia: 'unresolved' })
  })

  it('still allows manual variant mapping when product type is missing', () => {
    const result = resolveByProductBase(
      'variant-1',
      null,
      { Type: 'Tshirt', Size: 'L' },
      productBases,
      [{ shopifyVariantId: 'variant-1', supplierProductId: 'manual-supplier-product' }],
    )

    expect(result).toEqual({ supplierProductId: 'manual-supplier-product', resolvedVia: 'variant_manual' })
  })
})
