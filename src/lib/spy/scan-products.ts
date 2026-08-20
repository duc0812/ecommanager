import { normalizeStoreUrl, mapShopifyProduct, type ParsedSpyProduct, type ShopifyRawProduct } from '@/lib/spy/shopify'

export async function fetchStoreProducts(domain: string): Promise<{ products: ParsedSpyProduct[]; totalScanned: number }> {
  const origin = normalizeStoreUrl(domain)
  const endpoint = `${origin}/products.json?limit=250&page=1`
  const res = await fetch(endpoint, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'user-agent': 'EcomManagerSpy/1.0' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`Store returned ${res.status} ${res.statusText ?? ''}`.trim())
  const payload = await res.json()
  const raw: ShopifyRawProduct[] = Array.isArray(payload?.products) ? payload.products : Array.isArray(payload) ? payload : []
  return { products: raw.map(p => mapShopifyProduct(p, origin)), totalScanned: raw.length }
}
