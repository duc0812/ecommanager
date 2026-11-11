export type ProductionSource = {
  variantTitle: string | null; variantOptions: string | null; resolvedSupplierSku: string | null
  customAttributesJson: string | null; customallFieldsJson: string | null
}
export type ProductionOverride = {
  version: 1; supplierProductId: string; supplierId: string; supplierSku: string
  variantTitle: string; variantOptions: Record<string, string>; customName: string | null
  baseCost: number; shipFirst: number; shipAdditional: number; importTax: number
  source: ProductionSource
  history: { at: string; byId: string; byName: string; reason: string; from: string; to: string }[]
}

export function productionOverride(raw: string | null | undefined): ProductionOverride | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw)
    return p?.version === 1 && typeof p.supplierProductId === 'string' && typeof p.supplierSku === 'string'
      && typeof p.supplierId === 'string' && typeof p.variantTitle === 'string' && p.variantOptions && p.source && Array.isArray(p.history) ? p : null
  } catch { return null }
}

export function variantOptions(raw: string | null | undefined): Record<string, string> {
  try {
    const p = JSON.parse(raw || '{}')
    return p && typeof p === 'object' && !Array.isArray(p)
      ? Object.fromEntries(Object.entries(p).filter((e): e is [string, string] => typeof e[1] === 'string')) : {}
  } catch { return {} }
}

const nameKey = (key: string) => /^(custom name|custom name\/text|custom name\/text yes or no|custom name yes or no|your name|name|enter name|enter your name|custom text)$/.test(key.toLowerCase().replace(/^_+/, '').replace(/[:?]+/g, '').trim())

export function productionFields(raw: string | null, name: string | null, includeName = true): string | null {
  if (name === null) return raw
  let pairs: { key: string; value: string }[] = []
  try { const p = JSON.parse(raw || '[]'); if (Array.isArray(p)) pairs = p.filter(x => x && typeof x.key === 'string' && typeof x.value === 'string') } catch {}
  pairs = pairs.filter(x => !nameKey(x.key))
  if (includeName) pairs.unshift({ key: 'Custom Name', value: name || 'No' })
  return JSON.stringify(pairs)
}

/** Effective production values are materialized on the line so all supplier channels use the same values. */
export function applyProductionOverride<T extends { variantTitle?: string | null; variantOptions?: string | null; customAttributesJson?: string | null; customallFieldsJson?: string | null }>(line: T, p: ProductionOverride | null) {
  if (!p) return line
  return {
    ...line, variantTitle: p.variantTitle, variantOptions: JSON.stringify(p.variantOptions),
    resolvedSupplierId: p.supplierId, resolvedSupplierSku: p.supplierSku,
    resolvedBaseCost: p.baseCost, resolvedShipFirst: p.shipFirst, resolvedShipAdditional: p.shipAdditional, resolvedImportTax: p.importTax,
    customAttributesJson: productionFields(line.customAttributesJson ?? null, p.customName),
    customallFieldsJson: productionFields(line.customallFieldsJson ?? null, p.customName, false),
    ...(p.customName !== null ? { customized: !!p.customName } : {}),
  }
}
