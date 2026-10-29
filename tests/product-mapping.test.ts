import { describe, expect, it } from 'vitest'
import {
  matchesProductBase,
  matchesAttributeCombo,
  parseProfileOverrides,
  resolveByProductBase,
  supplierParentKey,
  swapToSizeSibling,
  type ProductProfileResolveData,
  type ProductBaseData,
  type VariantManualMappingData,
  buildTypeAliases,
  typeKey,
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

  it('matches when condition uses value (exact match)', () => {
    const base: ProductBaseData = {
      id: 'pb_val',
      shopifyProductType: 'Exact Type',
      variantConditions: JSON.stringify([{ optionName: 'Style', value: 'Hoodie' }]),
      supplierMappings: [],
      overrides: [],
    }
    expect(matchesProductBase('Exact Type', { Style: 'Hoodie' }, base)).toBe(true)
    expect(matchesProductBase('Exact Type', { Style: 'Tshirt' }, base)).toBe(false)
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

describe('resolveByProductBase with a product profile', () => {
  const profile: ProductProfileResolveData = {
    supplierProductId: 'sp_profile',
    overrides: [{ combo: { Size: '6XL' }, supplierProductId: 'sp_profile_6xl' }],
  }
  const line = { Style: 'Tshirt', Size: 'S' }

  it('variant_manual beats the profile', () => {
    const manual: VariantManualMappingData[] = [{ shopifyVariantId: 'v1', supplierProductId: 'sp_manual' }]
    const r = resolveByProductBase('v1', '3D Clothing', { Style: 'Tshirt', Size: '6XL' }, [tshirt3d], manual, profile)
    expect(r).toEqual({ supplierProductId: 'sp_manual', resolvedVia: 'variant_manual' })
  })

  it('a profile override beats the profile default and the base override', () => {
    const r = resolveByProductBase(null, '3D Clothing', { Style: 'Tshirt', Size: '6XL' }, [tshirt3d], [], profile)
    expect(r).toEqual({ supplierProductId: 'sp_profile_6xl', resolvedVia: 'product_profile_override' })
  })

  it('the profile default beats a matching product base', () => {
    const r = resolveByProductBase(null, '3D Clothing', line, [tshirt3d], [], profile)
    expect(r).toEqual({ supplierProductId: 'sp_profile', resolvedVia: 'product_profile' })
  })

  it('a profile without a supplier falls through to the bases', () => {
    const r = resolveByProductBase(null, '3D Clothing', line, [tshirt3d], [], { supplierProductId: null, overrides: [] })
    expect(r).toEqual({ supplierProductId: 'sp_a', resolvedVia: 'product_base_rank' })
  })

  it('a profile override still applies when the profile has no default supplier', () => {
    const r = resolveByProductBase(null, '3D Clothing', { Size: '6xl' }, [tshirt3d], [], { supplierProductId: null, overrides: profile.overrides })
    expect(r.resolvedVia).toBe('product_profile_override')
  })

  it('resolves through the profile when the line has no productType', () => {
    const r = resolveByProductBase(null, null, line, [tshirt3d], [], profile)
    expect(r).toEqual({ supplierProductId: 'sp_profile', resolvedVia: 'product_profile' })
  })

  it('stays unresolved without a productType when there is no profile', () => {
    expect(resolveByProductBase(null, null, line, [tshirt3d], [], null).resolvedVia).toBe('unresolved')
  })

  it('stays unresolved when the profile has no supplier, no matching override and the line has no productType', () => {
    const r = resolveByProductBase(null, null, { Size: 'M' }, [tshirt3d], [], { supplierProductId: null, overrides: profile.overrides })
    expect(r).toEqual({ supplierProductId: null, resolvedVia: 'unresolved' })
  })

  it('ignores the profile when none is given', () => {
    expect(resolveByProductBase(null, '3D Clothing', line, [tshirt3d], []).resolvedVia).toBe('product_base_rank')
  })
})

describe('parseProfileOverrides', () => {
  it('parses valid entries', () => {
    expect(parseProfileOverrides('[{"combo":{"Size":"XL"},"supplierProductId":"sp1"}]'))
      .toEqual([{ combo: { Size: 'XL' }, supplierProductId: 'sp1' }])
  })

  it('returns [] for bad JSON, non-arrays and null', () => {
    expect(parseProfileOverrides('{not json')).toEqual([])
    expect(parseProfileOverrides('{"a":1}')).toEqual([])
    expect(parseProfileOverrides(null)).toEqual([])
  })

  it('drops malformed entries, including an empty combo that would match every line', () => {
    const json = JSON.stringify([
      { combo: {}, supplierProductId: 'sp0' },
      { combo: { Size: 1 }, supplierProductId: 'sp1' },
      { combo: { Size: 'M' } },
      null,
      { combo: { Size: 'L' }, supplierProductId: 'sp2' },
    ])
    expect(parseProfileOverrides(json)).toEqual([{ combo: { Size: 'L' }, supplierProductId: 'sp2' }])
  })
})

describe('swapToSizeSibling', () => {
  const mk = (id: string, size: string) => ({
    id,
    supplierId: 's1',
    productName: 'Tee',
    productType: 'Shirt',
    baseSku: 'TEE',
    variant1Value: size,
    variant2Value: null as string | null,
  })
  const parent = [mk('sp_s', 'S'), mk('sp_m', 'M'), mk('sp_xl', 'XL')]
  const byId = new Map(parent.map(p => [p.id, p]))
  const byParent = new Map([[supplierParentKey(parent[0]), parent]])

  it('swaps a profile result to the size sibling', () => {
    expect(swapToSizeSibling('sp_s', { Size: 'XL' }, 'product_profile', byId, byParent)).toBe('sp_xl')
  })

  it('swaps a product_base_rank result as before', () => {
    expect(swapToSizeSibling('sp_s', { size: 'm' }, 'product_base_rank', byId, byParent)).toBe('sp_m')
  })

  it('returns null when no sibling carries the size', () => {
    expect(swapToSizeSibling('sp_s', { Size: '6XL' }, 'product_profile', byId, byParent)).toBeNull()
  })

  it('leaves exact-pin results alone', () => {
    for (const via of ['variant_manual', 'product_base_override', 'product_profile_override'] as const) {
      expect(swapToSizeSibling('sp_s', { Size: 'XL' }, via, byId, byParent)).toBe('sp_s')
    }
  })

  it('keeps the supplier product when the line has no size option', () => {
    expect(swapToSizeSibling('sp_s', { Style: 'Tee' }, 'product_profile', byId, byParent)).toBe('sp_s')
  })

  it('returns null for a null supplier product', () => {
    expect(swapToSizeSibling(null, { Size: 'S' }, 'product_profile', byId, byParent)).toBeNull()
  })
})

describe('swapToSizeSibling on colour-keyed SKUs', () => {
  const mk = (id: string, size: string, colour: string) => ({
    id,
    supplierId: 'mz',
    productName: 'Classic Unisex T-Shirt Gildan 5000',
    productType: 'T-Shirt',
    baseSku: '5000US',
    variant1Value: size,
    variant2Name: 'Color' as string | null,
    variant2Value: colour as string | null,
  })
  const parent = [mk('blk_s', 'S', 'Black'), mk('blk_l', 'L', 'Black'), mk('lb_s', 'S', 'Light Blue'), mk('lb_l', 'L', 'Light Blue')]
  const byId = new Map(parent.map(p => [p.id, p]))
  const byParent = new Map([[supplierParentKey(parent[0]), parent]])

  it('swaps a profile override pin to the colour and size of the line', () => {
    expect(swapToSizeSibling('blk_s', { Style: 'Tshirt', Size: 'L', Color: 'Light Blue' }, 'product_profile_override', byId, byParent)).toBe('lb_l')
  })

  it('swaps base-rank results on colour too', () => {
    expect(swapToSizeSibling('blk_s', { size: 'l', colour: 'black' }, 'product_base_rank', byId, byParent)).toBe('blk_l')
  })

  it('keeps the pinned colour when the line has no colour option', () => {
    expect(swapToSizeSibling('lb_s', { Size: 'L' }, 'product_base_override', byId, byParent)).toBe('lb_l')
  })

  it('returns null when the supplier has no SKU for that colour', () => {
    expect(swapToSizeSibling('blk_s', { Size: 'L', Color: 'Maroon' }, 'product_profile_override', byId, byParent)).toBeNull()
  })

  it('still leaves a manual variant pin alone', () => {
    expect(swapToSizeSibling('blk_s', { Size: 'L', Color: 'Light Blue' }, 'variant_manual', byId, byParent)).toBe('blk_s')
  })
})

describe('standard product types (aliases)', () => {
  const aliases = buildTypeAliases([
    { name: 'AOP Apparel', aliases: '["3D Clothing", "3D Clothingg", "AOP Shirttt"]' },
    { name: 'Crew Socks', aliases: ['Crew Socks', 'Socks'] },
  ])
  const base = (id: string, type: string, cond: object[], sp: string): ProductBaseData => ({
    id, shopifyProductType: type, variantConditions: JSON.stringify(cond), supplierMappings: [{ preferenceRank: 1, supplierProductId: sp }], overrides: [],
  })

  it('maps every spelling to the standard name, and an unknown type to itself', () => {
    expect(typeKey('3D Clothingg', aliases)).toBe('aop apparel')
    expect(typeKey(' AOP  Apparel ', aliases)).toBe('aop apparel')
    expect(typeKey('Socks', aliases)).toBe('crew socks')
    expect(typeKey('Tote Bag', aliases)).toBe('tote bag')
    expect(typeKey('3D Clothingg')).toBe('3d clothingg')
  })

  it('a base saved under an old spelling answers a line with the new type, and the other way round', () => {
    const bases = [base('b1', '3D Clothingg', [{ optionName: 'Style', value: 'Hoodie' }], 'sp-hoodie')]
    expect(resolveByProductBase(null, 'AOP Apparel', { Style: 'Hoodie' }, bases, [], null, null, aliases).supplierProductId).toBe('sp-hoodie')
    expect(resolveByProductBase(null, '3D Clothing', { Style: 'Hoodie' }, bases, [], null, null, aliases).supplierProductId).toBe('sp-hoodie')
    expect(resolveByProductBase(null, 'AOP Apparel', { Style: 'Hoodie' }, bases, [], null, null).supplierProductId).toBeNull()
  })

  it('without aliases nothing changes', () => {
    const bases = [base('b1', 'Crew Socks', [], 'sp-socks')]
    expect(resolveByProductBase(null, 'crew socks', {}, bases, [], null, null).supplierProductId).toBe('sp-socks')
    expect(resolveByProductBase(null, 'Socks', {}, bases, [], null, null).supplierProductId).toBeNull()
    expect(resolveByProductBase(null, 'Socks', {}, bases, [], null, null, aliases).supplierProductId).toBe('sp-socks')
  })

  it('two spellings merged into one type surface as ambiguous when both match', () => {
    const bases = [base('b1', '3D Clothing', [{ optionName: 'Style', value: 'Tshirt' }], 'sp-a'), base('b2', 'AOP Shirttt', [{ optionName: 'Style', value: 'Tshirt' }], 'sp-b')]
    const r = resolveByProductBase(null, 'AOP Apparel', { Style: 'Tshirt' }, bases, [], null, null, aliases)
    expect(r.supplierProductId).toBe('sp-a')
    expect(r.ambiguousBaseIds).toEqual(['b1', 'b2'])
  })
})
