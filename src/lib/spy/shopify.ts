export type ShopifyVariant = { id?: number; price?: string; available?: boolean }
export type ShopifyImage = { src?: string }
export type ShopifyRawProduct = {
  id?: number; title?: string; handle?: string; body_html?: string
  vendor?: string; product_type?: string; tags?: string | string[]
  created_at?: string; published_at?: string | null; updated_at?: string
  variants?: ShopifyVariant[]; images?: ShopifyImage[]
}

export function normalizeStoreUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Domain is required')
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const parsed = new URL(withProtocol)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https domains are supported')
  const hostname = parsed.hostname.toLowerCase()
  if (
    hostname === 'localhost' || hostname.endsWith('.local') || hostname === '0.0.0.0' ||
    hostname.startsWith('127.') || hostname.startsWith('10.') || hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  ) throw new Error('Local or private network domains are not allowed')
  return `${parsed.protocol}//${parsed.host}`
}

export function normalizeDomain(value: string): string {
  return new URL(normalizeStoreUrl(value)).host.toLowerCase()
}

export function parseDate(value?: string | null): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function stripHtml(value?: string): string {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function tagsToArray(value?: string | string[]): string[] {
  if (Array.isArray(value)) return value.map(t => String(t).trim()).filter(Boolean)
  return String(value ?? '').split(',').map(t => t.trim()).filter(Boolean)
}

export function priceSummary(variants: ShopifyVariant[] = []): { min: number; max: number } | null {
  const prices = variants.map(v => Number(v.price)).filter(p => Number.isFinite(p))
  if (prices.length === 0) return null
  return { min: Math.min(...prices), max: Math.max(...prices) }
}

export function productUrl(origin: string, handle?: string): string {
  return handle ? `${origin}/products/${handle}` : origin
}

export function externalProductId(raw: ShopifyRawProduct): string {
  if (raw.id) return String(raw.id)
  if (raw.handle) return `handle:${raw.handle}`
  throw new Error('Product has neither id nor handle')
}
