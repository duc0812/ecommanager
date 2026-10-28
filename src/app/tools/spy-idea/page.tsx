'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import AdCard, { Ad } from '@/components/spy/AdCard'
import ProductCard, { Product } from '@/components/spy/ProductCard'
import { LEVEL_LABELS, type Level } from '@/lib/spy/presumption-levels'

type Presumed = Product & { level: Level }
type Area = 'ads' | 'products' | 'ideas'
type BestSellerItem = Product & { rank: number; prevRank: number | null; delta: number | null }
type BestSellerGroup = { store: { domain: string }; items: BestSellerItem[] }

const AD_VIEWS = [
  { key: 'all', label: 'All Ads' },
  { key: 'new', label: 'New Ads' },
  { key: 'launching', label: 'New Launching Ads' },
  { key: 'winning', label: 'Winning Ads (Long Ads)' },
]
const PRODUCT_VIEWS = [
  { key: 'new-add', label: 'New Product Add' },
  { key: 'best-seller', label: 'Best Seller' },
]
const LEVEL_VIEWS: { key: 'all' | Level; label: string }[] = [
  { key: 'all', label: 'Tất cả' },
  { key: 'NEW_NEW_SCALE', label: LEVEL_LABELS.NEW_NEW_SCALE },
  { key: 'SCALE_STRONG', label: LEVEL_LABELS.SCALE_STRONG },
  { key: 'SCALE', label: LEVEL_LABELS.SCALE },
  { key: 'SALES_STRONG', label: LEVEL_LABELS.SALES_STRONG },
  { key: 'SALES', label: LEVEL_LABELS.SALES },
]
const LEVEL_BADGE: Record<Level, string> = {
  NEW_NEW_SCALE: 'bg-[#B3261E] text-white',
  SCALE_STRONG: 'bg-[#C2410C] text-white',
  SCALE: 'bg-[#FCE9D9] text-[#9A3412]',
  SALES_STRONG: 'bg-[#3F3AC4] text-white',
  SALES: 'bg-[#EDEBFB] text-[#4B45C6]',
}
const AREA_TABS: { key: Area; label: string }[] = [
  { key: 'ads', label: 'Ad Library' },
  { key: 'products', label: 'Product Spy' },
  { key: 'ideas', label: 'Ideas' },
]
const AREA_META: Record<Area, { title: string; subtitle: string }> = {
  ads: { title: 'Ad Library', subtitle: 'Creatives from your tracked domains.' },
  products: { title: 'Product Spy', subtitle: 'New products and best sellers across your stores.' },
  ideas: { title: 'Ideas', subtitle: 'Sản phẩm các bên được giả định có sales, cập nhật mỗi sáng 8h.' },
}
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-5'

function formatDate(v: string) {
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}
function defaultView(a: Area) { return a === 'products' ? 'new-add' : 'all' }

export default function SpyIdeaPage() {
  const router = useRouter()
  const params = useSearchParams()

  const rawArea = params.get('area')
  const area: Area = (['ads', 'products', 'ideas'].includes(rawArea || '') ? rawArea : 'ads') as Area
  const view = params.get('view') || defaultView(area)
  const domain = params.get('domain')
  const niche = params.get('niche')
  const type = params.get('type')

  const [ads, setAds] = useState<Ad[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [presumed, setPresumed] = useState<Presumed[]>([])
  const [levelCounts, setLevelCounts] = useState<Record<string, number>>({})
  const [computedAt, setComputedAt] = useState<string | null>(null)
  const [bestSellers, setBestSellers] = useState<BestSellerGroup[]>([])
  const [limit, setLimit] = useState(200)
  const [adsFetched, setAdsFetched] = useState(0)
  const [productsFetched, setProductsFetched] = useState(0)

  function buildUrl(nextArea: Area, nextView: string, overrides?: { domain?: string | null; niche?: string | null; type?: string | null }) {
    const p = new URLSearchParams()
    p.set('area', nextArea)
    p.set('view', nextView)
    const d = overrides && 'domain' in overrides ? overrides.domain : domain
    const n = overrides && 'niche' in overrides ? overrides.niche : niche
    const t = overrides && 'type' in overrides ? overrides.type : type
    if (d) p.set('domain', d)
    if (n) p.set('niche', n)
    if (t) p.set('type', t)
    return `/tools/spy-idea?${p.toString()}`
  }

  function go(nextArea: Area, nextView?: string) {
    const v = nextView ?? defaultView(nextArea)
    router.replace(buildUrl(nextArea, v))
  }
  function pickView(v: string) { router.replace(buildUrl(area, v)) }

  const filterQuery = useCallback(() => {
    const q = new URLSearchParams()
    if (domain) q.set('domain', domain)
    if (niche) q.set('nicheId', niche)
    if (type) q.set('productTypeId', type)
    return q.toString()
  }, [domain, niche, type])

  useEffect(() => { setLimit(200) }, [area, view, filterQuery])

  useEffect(() => {
    if (area === 'ads') {
      fetch(`/api/spy/ads?filter=${view}&limit=${limit}&${filterQuery()}`).then(r => r.json()).then(d => { setAds(d.ads ?? []); setAdsFetched(d.fetched ?? (d.ads?.length ?? 0)) }).catch(() => {})
    } else if (area === 'products' && view === 'new-add') {
      fetch(`/api/spy/products?days=30&limit=${limit}&${filterQuery()}`).then(r => r.json()).then(d => { setProducts(d.products ?? []); setProductsFetched(d.fetched ?? (d.products?.length ?? 0)) }).catch(() => {})
    } else if (area === 'products' && view === 'best-seller') {
      const lim = domain ? 50 : 12
      fetch(`/api/spy/best-sellers?limit=${lim}&${filterQuery()}`).then(r => r.json()).then(d => setBestSellers(d.groups ?? [])).catch(() => {})
    } else if (area === 'ideas') {
      const lv = view !== 'all' ? `level=${view}&` : ''
      fetch(`/api/spy/presumptions?${lv}limit=${limit}&${filterQuery()}`).then(r => r.json())
        .then(d => { setPresumed(d.items ?? []); setLevelCounts(d.counts ?? {}); setComputedAt(d.computedAt ?? null) }).catch(() => {})
    }
  }, [area, view, filterQuery, limit, domain])

  const totalPresumed = Object.values(levelCounts).reduce((n, c) => n + c, 0)
  const subViews = area === 'ads' ? AD_VIEWS : area === 'products' ? PRODUCT_VIEWS
    : LEVEL_VIEWS.map(v => ({ key: v.key, label: `${v.label} · ${v.key === 'all' ? totalPresumed : (levelCounts[v.key] ?? 0)}` }))
  const presumedTotal = view === 'all' ? totalPresumed : (levelCounts[view] ?? 0)
  const meta = AREA_META[area]
  const resultLabel = area === 'ads'
    ? `${ads.length}${adsFetched >= limit ? '+' : ''} creatives`
    : area === 'products' && view === 'new-add'
      ? `${products.length}${productsFetched >= limit ? '+' : ''} products`
      : area === 'products'
        ? `${bestSellers.reduce((n, g) => n + g.items.length, 0)} products`
        : computedAt ? `Cập nhật ${formatDate(computedAt)}` : ''

  return (
    <div>
      <header className="sticky top-0 z-10 -mx-[36px] -mt-[28px] border-b border-[#E6E3DE] bg-[#F7F6F4]/90 px-[36px] pt-[26px] backdrop-blur-md">
        <h1 className="text-[30px] font-semibold leading-none tracking-[-0.03em] text-[#1B1A17]">{meta.title}</h1>
        <p className="mt-2 text-[13px] text-[#78716C]">{meta.subtitle}</p>
        <nav className="mt-[22px] flex gap-[28px]">
          {AREA_TABS.map(t => (
            <button key={t.key} onClick={() => go(t.key)}
              className={`relative pb-[12px] text-[13.5px] transition-colors ${area === t.key ? 'font-semibold text-[#1B1A17] shadow-[inset_0_-2px_0_0_#3F3AC4]' : 'font-medium text-[#8A847C] hover:text-[#1B1A17]'}`}>{t.label}</button>
          ))}
        </nav>
      </header>

      {subViews.length > 0 && (
        <div className="mt-[22px] flex flex-wrap items-center gap-2">
          {subViews.map(v => (
            <button key={v.key} onClick={() => pickView(v.key)}
              className={`h-[32px] rounded-full px-[14px] text-[12.5px] transition-colors ${view === v.key ? 'border border-[#1B1A17] bg-[#1B1A17] font-medium text-white' : 'border border-[#E6E3DE] bg-white text-[#6B655D] hover:bg-[#F2F1EE]'}`}>{v.label}</button>
          ))}
          {resultLabel && <div className="ml-auto font-[family-name:var(--font-plex-mono)] font-medium text-[11px] tracking-[0.04em] text-[#78716C]">{resultLabel}</div>}
        </div>
      )}

      {area === 'ads' && (
        <>
          <div className={`mt-[22px] ${GRID}`}>
            {ads.map(a => <AdCard key={a.id} a={a} />)}
            {ads.length === 0 && <p className="text-[13px] text-[#78716C]">No ads for this filter.</p>}
          </div>
          {adsFetched >= limit && (
            <div className="mt-[24px] flex justify-center">
              <button onClick={() => setLimit(l => l + 200)} className="h-[38px] rounded-[10px] border border-[#E6E3DE] bg-white px-[20px] text-[13px] font-medium text-[#1B1A17] transition-colors hover:bg-[#F2F1EE]">Load more</button>
            </div>
          )}
        </>
      )}

      {area === 'products' && view === 'new-add' && (
        <>
          <div className={`mt-[22px] ${GRID}`}>
            {products.map(p => <ProductCard key={p.id} p={p} />)}
            {products.length === 0 && <p className="text-[13px] text-[#78716C]">No products for this filter.</p>}
          </div>
          {productsFetched >= limit && (
            <div className="mt-[24px] flex justify-center">
              <button onClick={() => setLimit(l => l + 200)} className="h-[38px] rounded-[10px] border border-[#E6E3DE] bg-white px-[20px] text-[13px] font-medium text-[#1B1A17] transition-colors hover:bg-[#F2F1EE]">Load more</button>
            </div>
          )}
        </>
      )}

      {area === 'products' && view === 'best-seller' && (
        <div className="mt-[22px] space-y-[36px]">
          {bestSellers.map(g => (
            <section key={g.store.domain}>
              <h3 className="mb-[16px] text-[16px] font-semibold tracking-[-0.01em] text-[#1B1A17]">{g.store.domain}</h3>
              <div className={GRID}>
                {g.items.map(it => <ProductCard key={it.id} p={it} rank={it.rank} rankDelta={it.delta} />)}
              </div>
            </section>
          ))}
          {bestSellers.length === 0 && <p className="text-[13px] text-[#78716C]">No best sellers yet — scan a store first (Setup → Sources).</p>}
        </div>
      )}

      {area === 'ideas' && (
        <>
          <div className={`mt-[22px] ${GRID}`}>
            {presumed.map(p => <ProductCard key={p.id} p={p} badge={{ label: LEVEL_LABELS[p.level], className: LEVEL_BADGE[p.level] }} />)}
            {presumed.length === 0 && <p className="text-[13px] text-[#78716C]">Chưa có sản phẩm nào cho bộ lọc này.</p>}
          </div>
          {presumed.length < presumedTotal && presumed.length >= limit && (
            <div className="mt-[24px] flex justify-center">
              <button onClick={() => setLimit(l => l + 200)} className="h-[38px] rounded-[10px] border border-[#E6E3DE] bg-white px-[20px] text-[13px] font-medium text-[#1B1A17] transition-colors hover:bg-[#F2F1EE]">Load more</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
