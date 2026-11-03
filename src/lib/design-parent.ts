export function suggestParentCode(sku: string | null | undefined): string {
  const s = (sku ?? '').trim()
  if (!s) return ''
  const dash = s.indexOf('-')
  return (dash === -1 ? s : s.slice(0, dash)).trim()
}

// A design-library entry. `sku` is the user-entered match key; `matchMode` decides how it
// is applied to an order line's SKU:
//   VARIANT → exact match (line.sku === entry.sku)
//   PARENT  → prefix match (line.sku starts with entry.sku), so every size/style reuses it
export type DesignEntry = {
  sku: string
  supplierId: string
  matchMode: string
  designLink: string | null
  designType: string
}

export function matchDesignEntry(
  sku: string | null | undefined,
  supplierId: string | null | undefined,
  entries: DesignEntry[],
): DesignEntry | null {
  const s = (sku ?? '').toLowerCase().trim()
  if (!s || !supplierId) return null

  // Exact VARIANT match wins (most specific). A given design is registered as either
  // PARENT or VARIANT, so in practice these do not overlap — exact-first is just a safe rule.
  const exact = entries.find(e =>
    e.supplierId === supplierId &&
    (e.matchMode ?? 'VARIANT').toUpperCase() === 'VARIANT' &&
    (e.sku ?? '').toLowerCase().trim() === s,
  )
  if (exact) return exact

  // PARENT prefix match; longest key wins to avoid a shorter code shadowing a longer one.
  let best: DesignEntry | null = null
  for (const e of entries) {
    if (e.supplierId !== supplierId) continue
    if ((e.matchMode ?? '').toUpperCase() !== 'PARENT') continue
    const key = (e.sku ?? '').toLowerCase().trim()
    if (!key || !s.startsWith(key)) continue
    if (!best || key.length > (best.sku ?? '').toLowerCase().trim().length) best = e
  }
  return best
}

// A SKU with no size in it (TN2605261712-Blue) prints different pieces per size, and the factory follows the link on the
// order. Such a SKU keeps one extra row per supplier size, sku = "<sku> @<supplier sku>". Once it has any, a size with no
// row matches nothing, so the line goes to the people instead of taking the row of the whole colour.
export function matchSizedDesignEntry(
  sku: string | null | undefined,
  supplierSku: string | null | undefined,
  supplierId: string | null | undefined,
  entries: DesignEntry[],
): DesignEntry | null {
  const prefix = `${(sku ?? '').toLowerCase().trim()} @`
  const sized = entries.filter(e => e.supplierId === supplierId && (e.sku ?? '').toLowerCase().trim().startsWith(prefix))
  if (sized.length === 0) return matchDesignEntry(sku, supplierId, entries)
  const key = prefix + (supplierSku ?? '').toLowerCase().trim()
  return sized.find(e => (e.sku ?? '').toLowerCase().trim() === key) ?? null
}
