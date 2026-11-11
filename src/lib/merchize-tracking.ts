import type { MerchizeTracking } from '@/lib/merchize'

export type MerchizeTrackingLine = { shopifyLineId: string; sku: string | null; catalogSkus: string[]; qty: number }
const normalized = (value: string | null) => value?.trim().toUpperCase() ?? ''

export function matchMerchizeTracking(lines: MerchizeTrackingLine[], parcels: MerchizeTracking[]): { byLine: Map<string, MerchizeTracking>; ambiguous: boolean } {
  const byLine = new Map<string, MerchizeTracking>()
  if (!parcels.length) return { byLine, ambiguous: false }
  const hasItems = parcels.some(p => p.items.some(i => i.sku || i.catalogSku))
  if (!hasItems) {
    if (lines.length > 1 && new Set(parcels.map(p => p.number)).size > 1) return { byLine, ambiguous: true }
    for (const line of lines) byLine.set(line.shopifyLineId, parcels[0])
    return { byLine, ambiguous: false }
  }

  const matches = new Map<string, MerchizeTracking[]>()
  const blocked = new Set<string>()
  let ambiguous = false
  for (const parcel of parcels) {
    for (const item of parcel.items) {
      const skuMatches = item.sku ? lines.filter(l => normalized(l.sku) === normalized(item.sku)) : []
      const catalogMatches = item.catalogSku ? lines.filter(l => l.catalogSkus.some(s => normalized(s) === normalized(item.catalogSku))) : []
      const candidates = skuMatches.length === 1 ? skuMatches : skuMatches.length > 1 && item.catalogSku ? skuMatches.filter(l => catalogMatches.includes(l)) : catalogMatches
      if (candidates.length !== 1) { ambiguous = true; for (const l of candidates) blocked.add(l.shopifyLineId); continue }
      const line = candidates[0]
      // A Shipment represents the whole Shopify line; a partially shipped quantity cannot fulfill that whole line.
      if (item.quantity !== null && item.quantity < line.qty) { blocked.add(line.shopifyLineId); ambiguous = true; continue }
      matches.set(line.shopifyLineId, [...(matches.get(line.shopifyLineId) ?? []), parcel])
    }
  }
  for (const line of lines) {
    const found = matches.get(line.shopifyLineId) ?? []
    if (blocked.has(line.shopifyLineId) || new Set(found.map(p => p.number)).size > 1) { ambiguous = true; continue }
    if (found.length) byLine.set(line.shopifyLineId, found[0])
  }
  return { byLine, ambiguous }
}
