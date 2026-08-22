import { normalizeStoreUrl, mapShopifyProduct, type ParsedSpyProduct, type ShopifyRawProduct } from '@/lib/spy/shopify'

const HANDLE_PRIORITY = ['best-selling', 'best-sellers', 'best-seller', 'bestsellers', 'bestseller', 'best-selling-products']

export function pickBestSellerHandle(collections: { handle: string; title?: string | null }[]): string | null {
  const byHandle = new Map(collections.map(c => [String(c.handle ?? '').toLowerCase(), c.handle]))
  for (const h of HANDLE_PRIORITY) { const hit = byHandle.get(h); if (hit) return hit }
  for (const c of collections) {
    const s = `${c.handle ?? ''} ${c.title ?? ''}`.toLowerCase()
    if (s.includes('best') && s.includes('sell')) return c.handle
  }
  return null
}

async function getJson(url: string): Promise<{ status: number; data: any }> {
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'user-agent': 'EcomManagerSpy/1.0' },
    signal: AbortSignal.timeout(20000),
  })
  if (res.status === 404) return { status: 404, data: null }
  if (!res.ok) throw new Error(`Store returned ${res.status} ${res.statusText ?? ''}`.trim())
  return { status: res.status, data: await res.json() }
}

export async function fetchStoreBestSellers(domain: string): Promise<{ products: ParsedSpyProduct[]; totalScanned: number; handle: string | null }> {
  const origin = normalizeStoreUrl(domain)
  const col = await getJson(`${origin}/collections.json?limit=250`)
  const collections: { handle: string; title?: string | null }[] = Array.isArray(col.data?.collections) ? col.data.collections : []
  if (collections.length === 0) return { products: [], totalScanned: 0, handle: null }
  const handle = pickBestSellerHandle(collections)
  if (!handle) return { products: [], totalScanned: 0, handle: null }
  const prod = await getJson(`${origin}/collections/${handle}/products.json?limit=250`)
  const raw: ShopifyRawProduct[] = Array.isArray(prod.data?.products) ? prod.data.products : []
  return { products: raw.map(p => mapShopifyProduct(p, origin)), totalScanned: raw.length, handle }
}
