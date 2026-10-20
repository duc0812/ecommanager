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

export type ProductProfileOverride = {
  combo: Record<string, string>
  supplierProductId: string
}

export type ProductProfileResolveData = {
  supplierProductId: string | null
  overrides: ProductProfileOverride[]
}

export type ResolveResult = {
  supplierProductId: string | null
  resolvedVia:
    | 'variant_manual'
    | 'product_profile_override'
    | 'product_profile'
    | 'product_base_override'
    | 'product_base_rank'
    | 'unresolved'
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

/** Reserved key of a product-profile override combo: the destination country, not a variant option. */
export const SHIP_TO_KEY = 'Ship to'

/**
 * `US`, `US,CA` or `!US` against the order's ISO2 destination. An unknown destination matches neither
 * form, so a line whose order has no address falls through to the next rule.
 */
export function matchesShipTo(rule: string, shipTo: string | null | undefined): boolean {
  const dest = (shipTo ?? '').trim().toUpperCase()
  if (!dest) return false
  const negate = rule.trim().startsWith('!')
  const codes = rule.trim().replace(/^!/, '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean)
  if (codes.length === 0) return false
  return negate ? !codes.includes(dest) : codes.includes(dest)
}

/** A profile override: every variant option in the combo matches, and `Ship to`, when present, matches the destination. */
export function matchesProfileCombo(combo: Record<string, string>, variantOptions: Record<string, string>, shipTo?: string | null): boolean {
  const options: Record<string, string> = {}
  for (const [k, v] of Object.entries(combo)) {
    if (normalize(k) === normalize(SHIP_TO_KEY)) {
      if (!matchesShipTo(v, shipTo)) return false
    } else {
      options[k] = v
    }
  }
  return matchesAttributeCombo(options, variantOptions)
}

export function profileKey(storeId: string, shopifyProductId: string): string {
  return `${storeId}|${shopifyProductId}`
}

export function parseProfileOverrides(json: string | null | undefined): ProductProfileOverride[] {
  if (!json) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ProductProfileOverride[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const { combo, supplierProductId } = item as { combo?: unknown; supplierProductId?: unknown }
    if (typeof supplierProductId !== 'string' || !supplierProductId) continue
    if (!combo || typeof combo !== 'object' || Array.isArray(combo)) continue
    const entries = Object.entries(combo as Record<string, unknown>)
    // An empty combo would match every line, so it is dropped rather than pinning the whole product.
    if (entries.length === 0 || entries.some(([, v]) => typeof v !== 'string')) continue
    out.push({ combo: Object.fromEntries(entries) as Record<string, string>, supplierProductId })
  }
  return out
}

export function supplierParentKey(product: {
  supplierId: string
  productName: string | null
  productType: string | null
  baseSku: string | null
}): string {
  return [
    product.supplierId,
    product.productName ?? '',
    product.productType ?? '',
    product.baseSku ?? '',
  ].join('|')
}

type SizeSiblingProduct = {
  id: string
  supplierId: string
  productName: string | null
  productType: string | null
  baseSku: string | null
  variant1Value: string | null
  variant2Value: string | null
}

// Manual and override results pin an exact supplier product; every other result names a parent
// product whose size sibling for this line has to be found.
export function swapToSizeSibling<P extends SizeSiblingProduct>(
  supplierProductId: string | null,
  selectedOptions: Record<string, string>,
  resolvedVia: ResolveResult['resolvedVia'],
  rawSupplierProductById: Map<string, P>,
  supplierProductsByParent: Map<string, P[]>,
): string | null {
  if (!supplierProductId) return null
  if (
    resolvedVia === 'variant_manual' ||
    resolvedVia === 'product_base_override' ||
    resolvedVia === 'product_profile_override'
  ) {
    return supplierProductId
  }
  const mapped = rawSupplierProductById.get(supplierProductId)
  if (!mapped) return supplierProductId
  const optionValues = Object.entries(selectedOptions)
    .filter(([key]) => normalize(key) === 'size')
    .map(([, value]) => normalize(value))
    .filter(Boolean)
  if (optionValues.length === 0) return supplierProductId
  const siblings = supplierProductsByParent.get(supplierParentKey(mapped)) ?? []
  const exact = siblings.find(p =>
    optionValues.includes(normalize(p.variant1Value ?? '')) ||
    optionValues.includes(normalize(p.variant2Value ?? ''))
  )
  return exact?.id ?? null
}

export function resolveByProductBase(
  shopifyVariantId: string | null,
  shopifyProductType: string | null,
  variantOptions: Record<string, string>,
  productBases: ProductBaseData[],
  manualMappings: VariantManualMappingData[],
  profile?: ProductProfileResolveData | null,
  shipTo?: string | null,
): ResolveResult {
  if (shopifyVariantId) {
    const manual = manualMappings.find(m => m.shopifyVariantId === shopifyVariantId)
    if (manual) return { supplierProductId: manual.supplierProductId, resolvedVia: 'variant_manual' }
  }

  if (profile) {
    const override = profile.overrides.find(o => matchesProfileCombo(o.combo, variantOptions, shipTo))
    if (override) return { supplierProductId: override.supplierProductId, resolvedVia: 'product_profile_override' }
    if (profile.supplierProductId) {
      return { supplierProductId: profile.supplierProductId, resolvedVia: 'product_profile' }
    }
  }

  if (!shopifyProductType) {
    // Require productType unless a manual variant mapping or a product profile resolved it.
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
