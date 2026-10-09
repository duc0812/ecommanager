import type { OverrideRow, ProfileOverride, SupplierProductOption } from './types'

export function toOverrideRows(overrides: ProfileOverride[]): OverrideRow[] {
  return overrides.map(o => {
    const [first, ...rest] = Object.entries(o.combo)
    return { option: first?.[0] ?? '', value: first?.[1] ?? '', extra: Object.fromEntries(rest), supplierProductId: o.supplierProductId }
  })
}

export function overrideRowsToPayload(rows: OverrideRow[]): { ok: true; overrides: ProfileOverride[] } | { ok: false; error: string } {
  const out: ProfileOverride[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const option = r.option.trim(), value = r.value.trim()
    if (!option && !value && !r.supplierProductId && Object.keys(r.extra).length === 0) continue
    if (!option || !value) return { ok: false, error: `Ghi đè dòng ${i + 1}: cần cả tên option và giá trị` }
    if (!r.supplierProductId) return { ok: false, error: `Ghi đè dòng ${i + 1}: chọn sản phẩm xưởng` }
    out.push({ combo: { [option]: value, ...r.extra }, supplierProductId: r.supplierProductId })
  }
  return { ok: true, overrides: out }
}

export function referencedSupplierIds(products: SupplierProductOption[], ids: string[]): Set<string> {
  const byId = new Map(products.map(p => [p.id, p.supplierId]))
  const out = new Set<string>()
  for (const id of ids) {
    const s = byId.get(id)
    if (s) out.add(s)
  }
  return out
}

export function supplierProductLabel(p: SupplierProductOption): string {
  const variant = [p.variant1Value, p.variant2Value].filter(Boolean).join(' / ')
  const parts = [p.sku, p.productName, variant].filter(Boolean)
  const cost = typeof p.baseCost === 'number' ? ` · $${p.baseCost.toFixed(2)}` : ''
  return `${parts.join(' · ')}${cost}`
}

export function groupBySupplier(products: SupplierProductOption[]): { supplierId: string; label: string; items: SupplierProductOption[] }[] {
  const groups = new Map<string, { supplierId: string; label: string; items: SupplierProductOption[] }>()
  for (const p of products) {
    let g = groups.get(p.supplierId)
    if (!g) {
      g = { supplierId: p.supplierId, label: `${p.supplier.name} (${p.supplier.code})`, items: [] }
      groups.set(p.supplierId, g)
    }
    g.items.push(p)
  }
  return Array.from(groups.values())
}

export function shopLabel(shop: string): string {
  return shop.replace(/\.myshopify\.com$/i, '')
}
