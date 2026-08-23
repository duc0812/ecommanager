'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import AdCard, { Ad } from '@/components/spy/AdCard'
import ProductCard, { Product } from '@/components/spy/ProductCard'

type Idea = { id: string; title: string; note: string | null; status: string; createdAt: string }
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
const AREA_TABS: { key: Area; label: string }[] = [
  { key: 'ads', label: 'Ad Library' },
  { key: 'products', label: 'Product Spy' },
  { key: 'ideas', label: 'Ideas' },
]
const AREA_META: Record<Area, { title: string; subtitle: string }> = {
  ads: { title: 'Ad Library', subtitle: 'Creatives from your tracked domains.' },
  products: { title: 'Product Spy', subtitle: 'New products and best sellers across your stores.' },
  ideas: { title: 'Ideas', subtitle: 'Ads and products you saved.' },
}
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-5'

function formatDate(v: string) {
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}

export default function SpyIdeaPage() {
  const router = useRouter()
  const params = useSearchParams()

  const rawArea = params.get('area')
  const area: Area = (['ads', 'products', 'ideas'].includes(rawArea || '') ? rawArea : 'ads') as Area
  const view = params.get('view') || (area === 'products' ? 'new-add' : area === 'ads' ? 'all' : 'ideas')
  const domain = params.get('domain')
  const niche = params.get('niche')
  const type = params.get('type')

  const [ads, setAds] = useState<Ad[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [bestSellers, setBestSellers] = useState<BestSellerGroup[]>([])

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
    const v = nextView ?? (nextArea === 'products' ? 'new-add' : nextArea === 'ads' ? 'all' : 'ideas')
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

  useEffect(() => {
    if (area === 'ads') {
      fetch(`/api/spy/ads?filter=${view}&limit=200&${filterQuery()}`).then(r => r.json()).then(d => setAds(d.ads ?? [])).catch(() => {})
    } else if (area === 'products' && view === 'new-add') {
      fetch(`/api/spy/products?days=30&limit=200&${filterQuery()}`).then(r => r.json()).then(d => setProducts(d.products ?? [])).catch(() => {})
    } else if (area === 'products' && view === 'best-seller') {
      const lim = domain ? 50 : 12
      fetch(`/api/spy/best-sellers?limit=${lim}&${filterQuery()}`).then(r => r.json()).then(d => setBestSellers(d.groups ?? [])).catch(() => {})
    } else if (area === 'ideas') {
      fetch('/api/spy/ideas').then(r => r.json()).then(setIdeas).catch(() => {})
    }
  }, [area, view, filterQuery])

  async function saveAdIdea(a: Ad) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: a.title ?? a.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: a.id, snapshotJson: a }) })
  }
  async function saveProductIdea(p: Product) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: p.title ?? 'Untitled', refType: 'PRODUCT', refProductId: p.id, snapshotJson: p }) })
  }

  const subViews = area === 'ads' ? AD_VIEWS : area === 'products' ? PRODUCT_VIEWS : []
  const meta = AREA_META[area]
  const resultLabel = area === 'ads'
    ? `${ads.length} creatives`
    : area === 'products' && view === 'new-add'
      ? `${products.length} products`
      : area === 'products'
        ? `${bestSellers.reduce((n, g) => n + g.items.length, 0)} products`
        : ''

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
          {resultLabel && <div className="ml-auto font-[family-name:var(--font-plex-mono)] text-[11px] tracking-[0.04em] text-[#78716C]">{resultLabel}</div>}
        </div>
      )}

      {area === 'ads' && (
        <div className={`mt-[22px] ${GRID}`}>
          {ads.map(a => <AdCard key={a.id} a={a} onSave={saveAdIdea} />)}
          {ads.length === 0 && <p className="text-[13px] text-[#78716C]">No ads for this filter.</p>}
        </div>
      )}

      {area === 'products' && view === 'new-add' && (
        <div className={`mt-[22px] ${GRID}`}>
          {products.map(p => <ProductCard key={p.id} p={p} onSave={saveProductIdea} />)}
          {products.length === 0 && <p className="text-[13px] text-[#78716C]">No products for this filter.</p>}
        </div>
      )}

      {area === 'products' && view === 'best-seller' && (
        <div className="mt-[22px] space-y-[36px]">
          {bestSellers.map(g => (
            <section key={g.store.domain}>
              <h3 className="mb-[16px] text-[16px] font-semibold tracking-[-0.01em] text-[#1B1A17]">{g.store.domain}</h3>
              <div className={GRID}>
                {g.items.map(it => <ProductCard key={it.id} p={it} onSave={saveProductIdea} rank={it.rank} rankDelta={it.delta} />)}
              </div>
            </section>
          ))}
          {bestSellers.length === 0 && <p className="text-[13px] text-[#78716C]">No best sellers yet — scan a store first (Setup → Sources).</p>}
        </div>
      )}

      {area === 'ideas' && (
        <ul className="mt-[22px] space-y-2">
          {ideas.map(i => (
            <li key={i.id} className="rounded-[12px] border border-[#E6E3DE] bg-white px-[16px] py-[14px]">
              <p className="text-[14px] font-semibold text-[#1B1A17]">{i.title}</p>
              <p className="mt-1 font-[family-name:var(--font-plex-mono)] text-[11px] text-[#78716C]">{i.status} · {formatDate(i.createdAt)}</p>
            </li>
          ))}
          {ideas.length === 0 && <p className="text-[13px] text-[#78716C]">No ideas saved yet.</p>}
        </ul>
      )}
    </div>
  )
}
