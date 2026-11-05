/** One SKU in a supplier's own catalogue. `skuName` is what its API wants on an order. */
export type SkuOption = { skuName: string; skuCode: string | null; productName: string | null }

function tokens(text: string | null | undefined): string[] {
  return (text ?? '').toLowerCase()
    .replace(/\binch(es)?\b/g, 'in')
    .replace(/(\d)\s+(in|oz|cm|mm)\b/g, '$1$2')
    .split(/[^a-z0-9.]+/)
    .filter(Boolean)
}

const MIN_NAME_MATCH = 0.6

/** A first guess for the "SKU API" of a tool SKU; null when nothing clearly wins, so a person picks instead. */
export function suggestSku(product: { sku: string; productName: string | null; variant1Value: string | null }, skus: SkuOption[]): string | null {
  const code = product.sku.trim().toLowerCase()
  const exact = skus.find(s => s.skuCode?.toLowerCase() === code || s.skuName.toLowerCase() === code)
  if (exact) return exact.skuName
  const name = tokens(product.productName)
  const size = tokens(product.variant1Value)
  if (name.length === 0) return null
  const scored = skus.flatMap(s => {
    const have = new Set(tokens(`${s.skuName} ${s.productName ?? ''} ${s.skuCode ?? ''}`))
    if (!size.every(t => have.has(t))) return []
    const score = name.filter(t => have.has(t)).length / name.length
    return score >= MIN_NAME_MATCH ? [{ skuName: s.skuName, score }] : []
  })
  const best = Math.max(0, ...scored.map(s => s.score))
  const top = scored.filter(s => s.score === best)
  return top.length === 1 ? top[0].skuName : null
}
