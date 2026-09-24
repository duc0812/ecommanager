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

// Real shape of #LIT3929: productType "3D Clothing" carries several styles. The Type-keyed
// bases are mutually exclusive; a later base keyed only on Size sits across all of them and
// carries the per-size overrides.
const hoodieBase = {
  id: 'base-3d-hoodie',
  shopifyProductType: '3D Clothing',
  variantConditions: JSON.stringify([{ optionName: 'Type', anyOf: ['Hoodie'] }]),
  supplierMappings: [{ preferenceRank: 1, supplierProductId: 'sp-hoodie-GAF' }],
  overrides: [],
}
const sizeOnlyBase = {
  id: 'base-3d-catchall',
  shopifyProductType: '3D Clothing',
  variantConditions: JSON.stringify([{ optionName: 'Size', anyOf: ['S', 'M', 'L'] }]),
  supplierMappings: [{ preferenceRank: 1, supplierProductId: 'sp-tshirt-BTX' }],
  overrides: [{ attributeCombo: JSON.stringify({ Size: 'L' }), supplierProductId: 'sp-tshirt-BTX-L' }],
}

describe('an override only speaks for the base that owns it', () => {
  const line = { Type: 'Hoodie', Size: 'L' }

  // A Tshirt base owning a bare {Size:'L'} override used to answer for a Hoodie line, because
  // overrides were scanned before anyone checked whether the owning base applied at all.
  const tshirtBaseWithSizeOverride = {
    id: 'base-3d-tshirt-2',
    shopifyProductType: '3D Clothing',
    variantConditions: JSON.stringify([{ optionName: 'Type', anyOf: ['Tshirt'] }]),
    supplierMappings: [{ preferenceRank: 1, supplierProductId: 'sp-tshirt-BTX' }],
    overrides: [{ attributeCombo: JSON.stringify({ Size: 'L' }), supplierProductId: 'sp-tshirt-BTX-L' }],
  }

  it('ignores an override whose own base does not match the line', () => {
    const r = resolveByProductBase(null, '3D Clothing', line, [tshirtBaseWithSizeOverride, hoodieBase], [])
    expect(r.supplierProductId).toBe('sp-hoodie-GAF')
    expect(r.resolvedVia).toBe('product_base_rank')
    expect(r.ambiguousBaseIds).toBeUndefined()
  })

  it('reports every base that matched, so an overlap is visible instead of silent', () => {
    const r = resolveByProductBase(null, '3D Clothing', line, [sizeOnlyBase, hoodieBase], [])
    expect(r.ambiguousBaseIds).toEqual(expect.arrayContaining(['base-3d-catchall', 'base-3d-hoodie']))
    expect(r.ambiguousBaseIds).toHaveLength(2)
  })

  it('leaves ambiguousBaseIds unset when exactly one base matches', () => {
    const r = resolveByProductBase(null, '3D Clothing', { Type: 'Hoodie', Size: 'XXL' }, [sizeOnlyBase, hoodieBase], [])
    expect(r.ambiguousBaseIds).toBeUndefined()
  })

  // Two bases keyed on different options both match a line that carries both options. The
  // resolver cannot invent a winner — it flags the overlap so the configuration gets fixed.
  it('flags the overlap when two matching bases disagree and neither owns an override', () => {
    const r = resolveByProductBase(null, '3D Clothing', { Type: 'Hoodie', Size: 'M' }, [sizeOnlyBase, hoodieBase], [])
    expect(r.resolvedVia).toBe('product_base_rank')
    expect(r.ambiguousBaseIds).toHaveLength(2)
  })

  it('still applies an override when its own base matches the line', () => {
    const r = resolveByProductBase(null, '3D Clothing', { Size: 'L' }, [sizeOnlyBase], [])
    expect(r).toMatchObject({ supplierProductId: 'sp-tshirt-BTX-L', resolvedVia: 'product_base_override' })
  })

  it('a manual variant mapping still outranks every base', () => {
    const r = resolveByProductBase('v9', '3D Clothing', line, [sizeOnlyBase, hoodieBase],
      [{ shopifyVariantId: 'v9', supplierProductId: 'sp-manual' }])
    expect(r).toEqual({ supplierProductId: 'sp-manual', resolvedVia: 'variant_manual' })
  })

  it('is unresolved when no base matches, rather than borrowing a stranger override', () => {
    const r = resolveByProductBase(null, '3D Clothing', { Type: 'Tank Top', Size: 'XXL' }, [sizeOnlyBase, hoodieBase], [])
    expect(r.supplierProductId).toBeNull()
    expect(r.resolvedVia).toBe('unresolved')
  })
})

describe('a "Special Case" may name a value outside its base, but still only for its own base', () => {
  // Base covers S–XL; the 6XL exception is deliberately outside that range.
  const tshirtBase = {
    id: 'base-tshirt',
    shopifyProductType: '3D Clothing',
    variantConditions: JSON.stringify([
      { optionName: 'Type', anyOf: ['Tshirt'] },
      { optionName: 'Size', anyOf: ['S', 'M', 'L', 'XL'] },
    ]),
    supplierMappings: [{ preferenceRank: 1, supplierProductId: 'sp-tshirt' }],
    overrides: [{ attributeCombo: JSON.stringify({ Size: '6XL' }), supplierProductId: 'sp-tshirt-oversized' }],
  }

  it('applies to a line of its own base even though the size is out of range', () => {
    const r = resolveByProductBase(null, '3D Clothing', { Type: 'Tshirt', Size: '6XL' }, [tshirtBase], [])
    expect(r).toMatchObject({ supplierProductId: 'sp-tshirt-oversized', resolvedVia: 'product_base_override' })
  })

  it('does not reach a hoodie line, which belongs to a different base', () => {
    const r = resolveByProductBase(null, '3D Clothing', { Type: 'Hoodie', Size: '6XL' }, [tshirtBase, hoodieBase], [])
    expect(r.supplierProductId).toBe('sp-hoodie-GAF')
  })

  it('does not fire when the line carries no Type at all', () => {
    const r = resolveByProductBase(null, '3D Clothing', { Size: '6XL' }, [tshirtBase], [])
    expect(r.resolvedVia).toBe('unresolved')
  })
})
