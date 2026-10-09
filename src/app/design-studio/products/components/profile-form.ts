import type { LayerFit, LayerMapEntry } from '../../components/types'
import type { LayerRow, OverrideRow, ProfileOverride, SupplierProductOption } from './types'

export const FITS: LayerFit[] = ['shrink', 'wrap', 'none']

const norm = (s: string) => s.toLowerCase().trim()

export function toLayerRows(layerMap: LayerMapEntry[], observedFields: string[]): LayerRow[] {
  const observed = new Set(observedFields.map(norm))
  const rows: LayerRow[] = layerMap.map(e => ({
    field: e.field, observed: observed.has(norm(e.field)), layer: e.layer, font: e.font ?? '',
    maxChars: e.maxChars ? String(e.maxChars) : '', fit: e.fit,
  }))
  const mapped = new Set(layerMap.map(e => norm(e.field)))
  for (const f of observedFields) {
    if (mapped.has(norm(f))) continue
    rows.push({ field: f, observed: true, layer: '', font: '', maxChars: '', fit: 'shrink' })
  }
  return rows
}

export function layerRowsToMap(rows: LayerRow[]): { ok: true; layerMap: LayerMapEntry[] } | { ok: false; error: string } {
  const out: LayerMapEntry[] = []
  const seen = new Set<string>()
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const field = r.field.trim(), layer = r.layer.trim()
    if (!layer && (r.observed || !field)) continue
    if (!field) return { ok: false, error: `Bảng layer dòng ${i + 1}: thiếu tên trường` }
    if (!layer) return { ok: false, error: `Bảng layer dòng ${i + 1} (${field}): thiếu layer` }
    if (seen.has(norm(field))) return { ok: false, error: `Bảng layer có trường trùng: ${field}` }
    seen.add(norm(field))
    let maxChars: number | undefined
    if (r.maxChars.trim()) {
      const n = Number(r.maxChars)
      if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `Bảng layer dòng ${i + 1} (${field}): max ký tự phải là số nguyên dương` }
      maxChars = n
    }
    out.push({ field, layer, ...(r.font.trim() ? { font: r.font.trim() } : {}), ...(maxChars ? { maxChars } : {}), fit: r.fit })
  }
  return { ok: true, layerMap: out }
}

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

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
}

export function shopLabel(shop: string): string {
  return shop.replace(/\.myshopify\.com$/i, '')
}
