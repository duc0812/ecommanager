'use client'
import { useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import SpySectionNav from '@/components/SpySectionNav'
import SpyFilterSidebar, { FiltersData, Selected } from '@/components/spy/SpyFilterSidebar'
import AdCard, { Ad } from '@/components/spy/AdCard'
import ProductCard, { Product } from '@/components/spy/ProductCard'

type Idea = { id: string; title: string; note: string | null; status: string; createdAt: string }
type Area = 'ads' | 'products' | 'ideas'

const AD_VIEWS = [
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

function readParams(): { area: Area; view: string; sel: Selected } {
  const p = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  const area = (['ads', 'products', 'ideas'].includes(p.get('area') || '') ? p.get('area') : 'ads') as Area
  const view = p.get('view') || (area === 'products' ? 'new-add' : 'new')
  return { area, view, sel: { domain: p.get('domain'), niche: p.get('niche'), type: p.get('type') } }
}

function writeParams(area: Area, view: string, sel: Selected) {
  const p = new URLSearchParams()
  p.set('area', area); p.set('view', view)
  if (sel.domain) p.set('domain', sel.domain)
  if (sel.niche) p.set('niche', sel.niche)
  if (sel.type) p.set('type', sel.type)
  window.history.replaceState(null, '', `?${p.toString()}`)
}

export default function SpyIdeaPage() {
  const [filters, setFilters] = useState<FiltersData>({ domains: [], niches: [], productTypes: [] })
  const [area, setArea] = useState<Area>('ads')
  const [view, setView] = useState('new')
  const [sel, setSel] = useState<Selected>({ domain: null, niche: null, type: null })
  const [ads, setAds] = useState<Ad[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [ideas, setIdeas] = useState<Idea[]>([])

  useEffect(() => {
    const init = readParams(); setArea(init.area); setView(init.view); setSel(init.sel)
    fetch('/api/spy/filters').then(r => r.json()).then(setFilters).catch(() => {})
  }, [])

  const filterQuery = useCallback(() => {
    const q = new URLSearchParams()
    if (sel.domain) q.set('domain', sel.domain)
    if (sel.niche) q.set('nicheId', sel.niche)
    if (sel.type) q.set('productTypeId', sel.type)
    return q.toString()
  }, [sel])

  useEffect(() => {
    if (area === 'ads') {
      fetch(`/api/spy/ads?filter=${view}&limit=200&${filterQuery()}`).then(r => r.json()).then(d => setAds(d.ads ?? [])).catch(() => {})
    } else if (area === 'products' && view === 'new-add') {
      fetch(`/api/spy/products?days=30&limit=200&${filterQuery()}`).then(r => r.json()).then(d => setProducts(d.products ?? [])).catch(() => {})
    } else if (area === 'ideas') {
      fetch('/api/spy/ideas').then(r => r.json()).then(setIdeas).catch(() => {})
    }
  }, [area, view, filterQuery])

  function go(nextArea: Area, nextView?: string) {
    const v = nextView ?? (nextArea === 'products' ? 'new-add' : nextArea === 'ads' ? 'new' : 'ideas')
    setArea(nextArea); setView(v); writeParams(nextArea, v, sel)
  }
  function pickView(v: string) { setView(v); writeParams(area, v, sel) }
  function onSelect(dim: 'domain'|'niche'|'type', value: string | null) {
    const next = { ...sel, [dim]: value }; setSel(next); writeParams(area, view, next)
  }

  async function saveAdIdea(a: Ad) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: a.title ?? a.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: a.id, snapshotJson: a }) })
  }
  async function saveProductIdea(p: Product) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: p.title ?? 'Untitled', refType: 'PRODUCT', refProductId: p.id, snapshotJson: p }) })
  }

  const subViews = area === 'ads' ? AD_VIEWS : area === 'products' ? PRODUCT_VIEWS : []

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
            <h2 className="text-display-md font-bold text-primary">Spy</h2>
          </header>

          <SpySectionNav active={area} items={[
            { key: 'ads', label: 'Ad Library', icon: 'library_books', onClick: () => go('ads') },
            { key: 'products', label: 'Product Spy', icon: 'inventory_2', onClick: () => go('products') },
            { key: 'ideas', label: 'Ideas', icon: 'lightbulb', onClick: () => go('ideas') },
          ]} />

          <div className="flex gap-lg">
            <SpyFilterSidebar filters={filters} selected={sel} onSelect={onSelect} />

            <div className="min-w-0 flex-1">
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
                <div className="rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest p-2xl text-center text-on-surface-variant">
                  <span className="material-symbols-outlined text-[44px] text-outline-variant">trending_up</span>
                  <h3 className="mt-sm text-headline-sm text-primary">Best Seller</h3>
                  <p className="mt-xs text-body-md">Coming in Phase C — scrape the store&apos;s best-selling collection.</p>
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
            </div>
          </div>
        </main>
      </div>
    </RoleGate>
  )
}
