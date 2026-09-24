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
  // Set only when several bases of the same productType matched this line. The winner is then
  // the first one given, which is a configuration problem, not a decision the resolver can make.
  ambiguousBaseIds?: string[]
}

function normalize(v: string): string {
  return v.toLowerCase().trim()
}

function normalizeComparableValue(v: string): string {
  const normalized = normalize(v)
  return normalized.endsWith('s') ? normalized.slice(0, -1) : normalized
}

function valueMatches(actual: string, expected: string): boolean {
  return normalizeComparableValue(actual) === normalizeComparableValue(expected)
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
    if (cond.value !== undefined) return valueMatches(optVal, cond.value)
    if (cond.anyOf !== undefined) return cond.anyOf.some(value => valueMatches(optVal, value))
    return false
  })
}

// An override may deliberately name a value outside its base's own range for the option it
// pins — a base covering S–XL with a "Size 6XL" exception. So the base is judged on its OTHER
// conditions only; those are what say whether this base speaks for this line at all.
export function matchesProductBaseIgnoring(
  shopifyProductType: string,
  variantOptions: Record<string, string>,
  base: ProductBaseData,
  ignoredOptionNames: Set<string>,
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
  return conditions
    .filter(cond => !ignoredOptionNames.has(normalize(cond.optionName)))
    .every(cond => {
      const optVal = normalizedOptions[normalize(cond.optionName)]
      if (optVal === undefined) return false
      if (cond.value !== undefined) return valueMatches(optVal, cond.value)
      if (cond.anyOf !== undefined) return cond.anyOf.some(value => valueMatches(optVal, value))
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

  if (!shopifyProductType) {
    // Require productType unless a manual variant mapping exists.
    return { supplierProductId: null, resolvedVia: 'unresolved' }
  }

  const sameType = productBases.filter(
    b => normalize(b.shopifyProductType) === normalize(shopifyProductType),
  )
  const matching = sameType.filter(b => matchesProductBase(shopifyProductType, variantOptions, b))
  const ambiguousBaseIds = matching.length > 1 ? matching.map(b => b.id) : undefined

  // An override only speaks for its own base. Scanning every base of the productType (as this
  // used to) let a base keyed on Type = Tshirt answer a Type = Hoodie line through a bare
  // { Size } override — #LIT3929 shipped a hoodie as a T-shirt.
  for (const base of sameType) {
    for (const override of base.overrides) {
      let combo: Record<string, string>
      try {
        combo = JSON.parse(override.attributeCombo)
      } catch {
        continue
      }
      if (!matchesAttributeCombo(combo, variantOptions)) continue
      const pinned = new Set(Object.keys(combo).map(normalize))
      if (!matchesProductBaseIgnoring(shopifyProductType, variantOptions, base, pinned)) continue
      return { supplierProductId: override.supplierProductId, resolvedVia: 'product_base_override', ambiguousBaseIds }
    }
  }

  if (matching.length === 0) return { supplierProductId: null, resolvedVia: 'unresolved' }

  const sorted = [...matching[0].supplierMappings].sort((a, b) => a.preferenceRank - b.preferenceRank)
  if (sorted.length > 0) {
    return { supplierProductId: sorted[0].supplierProductId, resolvedVia: 'product_base_rank', ambiguousBaseIds }
  }

  return { supplierProductId: null, resolvedVia: 'unresolved', ambiguousBaseIds }
}
