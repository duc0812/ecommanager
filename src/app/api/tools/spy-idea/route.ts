import { NextRequest, NextResponse } from 'next/server'
import { normalizeStoreUrl, parseDate, stripHtml, tagsToArray, productUrl, priceSummary } from '@/lib/spy/shopify'

type ShopifyVariant = {
  id?: number
  price?: string
  compare_at_price?: string | null
  available?: boolean
}

type ShopifyImage = {
  src?: string
}

type ShopifyProduct = {
  id?: number
  title?: string
  handle?: string
  body_html?: string
  vendor?: string
  product_type?: string
  tags?: string | string[]
  created_at?: string
  published_at?: string | null
  updated_at?: string
  variants?: ShopifyVariant[]
  images?: ShopifyImage[]
}

type SpyProduct = {
  id?: number
  title: string
  handle: string
  url: string
  image: string | null
  listedAt: string | null
  dateSource: string | null
  createdAt: string | null
  publishedAt: string | null
  updatedAt: string | null
  vendor: string | null
  productType: string | null
  tags: string[]
  tagsPreview: string[]
  variantCount: number
  availableVariantCount: number
  price: string | null
  description: string
  cacheKey: string
}

type DomainCache = {
  expiresAt: number
  seenKeys: Set<string>
  products: Map<string, SpyProduct>
}

type SpyCacheStore = {
  domains: Map<string, DomainCache>
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_DOMAINS = 10

const spyCache: SpyCacheStore = (globalThis as typeof globalThis & { __spyIdeaCache?: SpyCacheStore }).__spyIdeaCache ?? {
  domains: new Map(),
}

;(globalThis as typeof globalThis & { __spyIdeaCache?: SpyCacheStore }).__spyIdeaCache = spyCache

function productCacheKey(product: ShopifyProduct, origin: string) {
  if (product.id) return `id:${product.id}`
  if (product.handle) return `handle:${product.handle}`
  return `url:${productUrl(origin, product.handle)}`
}

function getValidDomainCache(origin: string, now: Date) {
  const existing = spyCache.domains.get(origin)
  if (existing && existing.expiresAt > now.getTime()) {
    if (!existing.products) existing.products = new Map<string, SpyProduct>()
    return existing
  }

  const fresh = { expiresAt: now.getTime() + CACHE_TTL_MS, seenKeys: new Set<string>(), products: new Map<string, SpyProduct>() }
  spyCache.domains.set(origin, fresh)
  return fresh
}

function parseDomains(body: { domains?: unknown; domain?: unknown }): string[] {
  const rawDomains: string[] = Array.isArray(body.domains)
    ? body.domains.map(value => String(value ?? '').trim())
    : String(body.domain ?? '')
        .split(/\r?\n|,/)
        .map((value: string) => value.trim())

  return Array.from(new Set(rawDomains.filter(Boolean))).slice(0, MAX_DOMAINS)
}

async function scanDomain(rawDomain: string) {
  const now = new Date()
  const origin = normalizeStoreUrl(rawDomain)
  const endpoint = `${origin}/products.json?limit=250&page=1`

  try {
    const response = await fetch(endpoint, {
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'user-agent': 'EcomManagerSpyIdea/1.0',
      },
      signal: AbortSignal.timeout(20000),
    })

    if (!response.ok) {
      return {
        domain: origin,
        endpoint,
        fetchedAt: now.toISOString(),
        totalScanned: 0,
        recentCount: 0,
        newCount: 0,
        cachedOldCount: 0,
        since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        cacheExpiresAt: null,
        products: [] as SpyProduct[],
        cachedProducts: [] as SpyProduct[],
        error: `Store returned ${response.status} ${response.statusText}`,
      }
    }

    const payload = await response.json()
    const products: ShopifyProduct[] = Array.isArray(payload?.products)
      ? payload.products
      : Array.isArray(payload)
        ? payload
        : []

    const since = new Date(now)
    since.setDate(now.getDate() - 7)

    const recentProducts: SpyProduct[] = products
      .map(product => {
        const publishedAt = parseDate(product.published_at)
        const createdAt = parseDate(product.created_at)
        const listedAt = publishedAt ?? createdAt
        const variants = product.variants ?? []
        const tags = tagsToArray(product.tags)
        const handle = product.handle || ''

        return {
          id: product.id,
          title: product.title || 'Untitled product',
          handle,
          url: productUrl(origin, handle),
          image: product.images?.[0]?.src || null,
          listedAt: listedAt?.toISOString() || null,
          dateSource: publishedAt ? 'published_at' : createdAt ? 'created_at' : null,
          createdAt: createdAt?.toISOString() || null,
          publishedAt: publishedAt?.toISOString() || null,
          updatedAt: parseDate(product.updated_at)?.toISOString() || null,
          vendor: product.vendor || null,
          productType: product.product_type || null,
          tags,
          tagsPreview: tags.slice(0, 8),
          variantCount: variants.length,
          availableVariantCount: variants.filter(variant => variant.available !== false).length,
          price: (() => { const ps = priceSummary(variants); return ps ? (ps.min === ps.max ? ps.min.toFixed(2) : `${ps.min.toFixed(2)} - ${ps.max.toFixed(2)}`) : null })(),
          description: stripHtml(product.body_html).slice(0, 220),
          cacheKey: productCacheKey(product, origin),
        }
      })
      .filter(product => {
        if (!product.listedAt) return false
        const listedAt = new Date(product.listedAt)
        return listedAt >= since && listedAt <= now
      })
      .sort((a, b) => Number(new Date(b.listedAt ?? 0)) - Number(new Date(a.listedAt ?? 0)))

    const cache = getValidDomainCache(origin, now)
    const newProducts = recentProducts.filter(product => !cache.seenKeys.has(product.cacheKey))
    recentProducts.forEach(product => {
      cache.seenKeys.add(product.cacheKey)
      cache.products.set(product.cacheKey, product)
    })
    cache.expiresAt = now.getTime() + CACHE_TTL_MS
    const cachedProducts = Array.from(cache.products.values())
      .filter(product => {
        if (!product.listedAt) return false
        const listedAt = new Date(product.listedAt)
        return listedAt >= since && listedAt <= now
      })
      .sort((a, b) => Number(new Date(b.listedAt ?? 0)) - Number(new Date(a.listedAt ?? 0)))

    return {
      domain: origin,
      endpoint,
      fetchedAt: now.toISOString(),
      totalScanned: products.length,
      recentCount: recentProducts.length,
      newCount: newProducts.length,
      cachedOldCount: recentProducts.length - newProducts.length,
      since: since.toISOString(),
      cacheExpiresAt: new Date(cache.expiresAt).toISOString(),
      products: newProducts,
      cachedProducts,
      error: null,
    }
  } catch (error) {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    return {
      domain: rawDomain,
      endpoint,
      fetchedAt: now.toISOString(),
      totalScanned: 0,
      recentCount: 0,
      newCount: 0,
      cachedOldCount: 0,
      since: since.toISOString(),
      cacheExpiresAt: null,
      products: [] as SpyProduct[],
      cachedProducts: [] as SpyProduct[],
      error: error instanceof Error ? error.message : 'Could not scan this store',
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const domains = parseDomains(body)
    if (domains.length === 0) {
      return NextResponse.json({ error: 'At least one domain is required' }, { status: 400 })
    }

    const results = []
    for (const domain of domains) {
      results.push(await scanDomain(domain))
    }

    const totalScanned = results.reduce((sum, result) => sum + result.totalScanned, 0)
    const recentCount = results.reduce((sum, result) => sum + result.recentCount, 0)
    const newCount = results.reduce((sum, result) => sum + result.newCount, 0)
    const cachedOldCount = results.reduce((sum, result) => sum + result.cachedOldCount, 0)

    return NextResponse.json({
      fetchedAt: new Date().toISOString(),
      domainCount: results.length,
      totalScanned,
      recentCount,
      newCount,
      cachedOldCount,
      results,
      products: results.flatMap(result => result.products),
      cachedProducts: results.flatMap(result => result.cachedProducts),
      domain: results[0]?.domain,
      endpoint: results[0]?.endpoint,
      since: results[0]?.since,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not scan this store'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
