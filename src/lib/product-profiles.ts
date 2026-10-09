import { prisma } from '@/lib/db'
import { visibleCustomAttributes } from '@/lib/order-classify'
import { parseAttributes } from '@/lib/design-studio'
import { isLayerlessField } from '@/lib/layer-fields'

export { isLayerlessField }

export type LayerFit = 'shrink' | 'wrap' | 'none'
export const LAYER_FITS: LayerFit[] = ['shrink', 'wrap', 'none']
export type LayerMapEntry = { field: string; layer: string; font?: string; maxChars?: number; fit: LayerFit }

const PRODUCT_GID_PREFIX = 'gid://shopify/Product/'
export const OBSERVED_WINDOW_DAYS = 90
export const OBSERVED_LINE_LIMIT = 200

export function observationSince(now = Date.now()): Date {
  return new Date(now - OBSERVED_WINDOW_DAYS * 86400_000)
}

export function toRouteKey(storeId: string, shopifyProductId: string): string {
  const numeric = shopifyProductId.startsWith(PRODUCT_GID_PREFIX) ? shopifyProductId.slice(PRODUCT_GID_PREFIX.length) : shopifyProductId
  return `${storeId}~${numeric}`
}

export function fromRouteKey(key: string): { storeId: string; shopifyProductId: string } | null {
  const decoded = (() => { try { return decodeURIComponent(key) } catch { return key } })()
  const idx = decoded.lastIndexOf('~')
  if (idx <= 0) return null
  const storeId = decoded.slice(0, idx)
  const numeric = decoded.slice(idx + 1)
  if (!/^\d+$/.test(numeric) || !/^[A-Za-z0-9_-]+$/.test(storeId)) return null
  return { storeId, shopifyProductId: `${PRODUCT_GID_PREFIX}${numeric}` }
}

export function parseLayerMap(json: string | null | undefined): LayerMapEntry[] {
  if (!json) return []
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: LayerMapEntry[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const { field, layer, font, maxChars, fit } = e as Record<string, unknown>
    if (typeof field !== 'string' || !field.trim() || typeof layer !== 'string' || !layer.trim()) continue
    out.push({
      field, layer,
      ...(typeof font === 'string' && font ? { font } : {}),
      ...(typeof maxChars === 'number' && Number.isInteger(maxChars) && maxChars > 0 ? { maxChars } : {}),
      fit: LAYER_FITS.includes(fit as LayerFit) ? fit as LayerFit : 'none',
    })
  }
  return out
}

export function fieldsFromLines(lines: Array<{ customAttributesJson: string | null }>): string[] {
  const seen = new Map<string, string>()
  for (const l of lines) {
    for (const a of visibleCustomAttributes(parseAttributes(l.customAttributesJson))) {
      if (isLayerlessField(a.key)) continue
      const norm = a.key.toLowerCase().trim()
      if (!seen.has(norm)) seen.set(norm, a.key)
    }
  }
  return Array.from(seen.values())
}

export async function findProfile(storeId: string, shopifyProductId: string) {
  return prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } } })
}
