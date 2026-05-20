export type VariantCondition = {
  optionName: string
  value?: string
  anyOf?: string[]
}

export type ProductBaseSupplierMappingData = {
  preferenceRank: number
  supplierProductId: string
}

export type ProductBaseOverrideData = {
  attributeCombo: string
  supplierProductId: string
}

export type ProductBaseData = {
  id: string
  shopifyProductType: string
  variantConditions: string
  supplierMappings: ProductBaseSupplierMappingData[]
  overrides: ProductBaseOverrideData[]
}

export type VariantManualMappingData = {
  shopifyVariantId: string
  supplierProductId: string
}

export type ResolveResult = {
  supplierProductId: string | null
  resolvedVia: 'variant_manual' | 'product_base_override' | 'product_base_rank' | 'unresolved'
}

function normalize(v: string): string {
  return v.toLowerCase().trim()
}

export function matchesProductBase(
  shopifyProductType: string,
  variantOptions: Record<string, string>,
  base: ProductBaseData,
): boolean {
  if (normalize(shopifyProductType) !== normalize(base.shopifyProductType)) return false
  let conditions: VariantCondition[]
  try {
    conditions = JSON.parse(base.variantConditions)
  } catch {
    return false
  }
  const normalizedOptions: Record<string, string> = {}
  for (const [k, v] of Object.entries(variantOptions)) {
    normalizedOptions[normalize(k)] = normalize(v)
  }
  return conditions.every(cond => {
    const optVal = normalizedOptions[normalize(cond.optionName)]
    if (optVal === undefined) return false
    if (cond.value !== undefined) return optVal === normalize(cond.value)
    if (cond.anyOf !== undefined) return cond.anyOf.map(normalize).includes(optVal)
    return false
  })
}

export function matchesAttributeCombo(
  combo: Record<string, string>,
  variantOptions: Record<string, string>,
): boolean {
  const normalizedOptions: Record<string, string> = {}
  for (const [k, v] of Object.entries(variantOptions)) {
    normalizedOptions[normalize(k)] = normalize(v)
  }
  return Object.entries(combo).every(([k, v]) => {
    const optVal = normalizedOptions[normalize(k)]
    return optVal === normalize(v)
  })
}

export function resolveByProductBase(
  shopifyVariantId: string | null,
  shopifyProductType: string | null,
  variantOptions: Record<string, string>,
  productBases: ProductBaseData[],
  manualMappings: VariantManualMappingData[],
): ResolveResult {
  if (shopifyVariantId) {
    const manual = manualMappings.find(m => m.shopifyVariantId === shopifyVariantId)
    if (manual) return { supplierProductId: manual.supplierProductId, resolvedVia: 'variant_manual' }
  }

  if (!shopifyProductType) return { supplierProductId: null, resolvedVia: 'unresolved' }

  // First, find a ProductBase that matches the productType (regardless of variant conditions)
  const baseByType = productBases.find(b => normalize(shopifyProductType) === normalize(b.shopifyProductType))

  // Check overrides against the matched base
  if (baseByType) {
    for (const override of baseByType.overrides) {
      let combo: Record<string, string>
      try {
        combo = JSON.parse(override.attributeCombo)
      } catch {
        continue
      }
      if (matchesAttributeCombo(combo, variantOptions)) {
        return { supplierProductId: override.supplierProductId, resolvedVia: 'product_base_override' }
      }
    }
  }

  // If no override matched, look for a base that matches both type and conditions
  const base = productBases.find(b => matchesProductBase(shopifyProductType, variantOptions, b))
  if (!base) return { supplierProductId: null, resolvedVia: 'unresolved' }

  const sorted = [...base.supplierMappings].sort((a, b) => a.preferenceRank - b.preferenceRank)
  if (sorted.length > 0) {
    return { supplierProductId: sorted[0].supplierProductId, resolvedVia: 'product_base_rank' }
  }

  return { supplierProductId: null, resolvedVia: 'unresolved' }
}
