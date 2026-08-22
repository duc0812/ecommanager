'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import SpySectionNav from '@/components/SpySectionNav'
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

  return (
    <>
      <header className="mb-lg">
        <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
        <h2 className="text-display-md font-bold text-primary">Spy</h2>
      </header>

      <SpySectionNav active={area} items={[
        { key: 'ads', label: 'Ad Library', icon: 'library_books', onClick: () => go('ads') },
        { key: 'products', label: 'Product Spy', icon: 'inventory_2', onClick: () => go('products') },
        { key: 'ideas', label: 'Ideas', icon: 'lightbulb', onClick: () => go('ideas') },
      ]} />

      {subViews.length > 0 && (
        <nav className="mb-md flex flex-wrap gap-sm">
          {subViews.map(v => (
            <button key={v.key} onClick={() => pickView(v.key)}
              className={`rounded-md px-md py-xs text-label-sm ${view === v.key ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant'}`}>{v.label}</button>
          ))}
        </nav>
      )}

      {area === 'ads' && (
        <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {ads.map(a => <AdCard key={a.id} a={a} onSave={saveAdIdea} />)}
          {ads.length === 0 && <p className="text-body-md text-on-surface-variant">No ads for this filter.</p>}
        </div>
      )}

      {area === 'products' && view === 'new-add' && (
        <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {products.map(p => <ProductCard key={p.id} p={p} onSave={saveProductIdea} />)}
          {products.length === 0 && <p className="text-body-md text-on-surface-variant">No products for this filter.</p>}
        </div>
      )}

      {area === 'products' && view === 'best-seller' && (
        <div className="space-y-xl">
          {bestSellers.map(g => (
            <section key={g.store.domain}>
              <h3 className="mb-md text-headline-sm text-primary">{g.store.domain}</h3>
              <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {g.items.map(it => <ProductCard key={it.id} p={it} onSave={saveProductIdea} rank={it.rank} rankDelta={it.delta} />)}
              </div>
            </section>
          ))}
          {bestSellers.length === 0 && <p className="text-body-md text-on-surface-variant">No best sellers yet — scan a store first (Setup → Sources).</p>}
        </div>
      )}

      {area === 'ideas' && (
        <ul className="space-y-sm">
          {ideas.map(i => (
            <li key={i.id} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
              <p className="text-label-md text-primary">{i.title}</p>
              <p className="text-body-sm text-on-surface-variant">{i.status} · {formatDate(i.createdAt)}</p>
            </li>
          ))}
          {ideas.length === 0 && <p className="text-body-md text-on-surface-variant">No ideas saved yet.</p>}
        </ul>
      )}
    </>
  )
}
