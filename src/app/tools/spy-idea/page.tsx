'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import SpySectionNav from '@/components/SpySectionNav'

type Store = { id: string; domain: string; name: string | null; status: string; _count?: { products: number } }
type Product = { id: string; title: string | null; handle: string | null; imageUrl: string | null; priceMin: number | null; priceMax: number | null; firstSeenAt: string; productType: string | null; store: { domain: string } }
type Idea = { id: string; title: string; note: string | null; status: string; createdAt: string }
type AdSignals = { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean; adStyle: 'product'|'collection'|'homepage'|'other'|null; newProductLaunching: boolean }
type Ad = { id: string; title: string | null; body: string | null; adArchiveId: string; adLibraryUrl: string | null; mediaUrl: string | null; mediaType: 'video'|'image'|'carousel'|'dco'|null; startDate: string | null; advertiser: { pageName: string | null }; signals: AdSignals }
type AdDomain = { id: string; domain: string; searchTerm: string; country: string; lastScanAt: string | null; pageCount: number; adCount: number; newAdCount: number }
type PageTarget = { id: string; pageUrl: string; label: string | null; lastScanAt: string | null }

const MEDIA_LABEL: Record<string, string> = { video: '🎬 Video', image: '🖼 Image', carousel: '🎠 Carousel', dco: 'DCO' }
const STYLE_LABEL: Record<string, string> = { product: 'Product', collection: 'Collection', homepage: 'Homepage', other: 'Other' }

function AdCard({ a, onSave }: { a: Ad; onSave: (a: Ad) => void }) {
  const s = a.signals
  return (
    <article className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
      <div className="relative mb-sm">
        {a.mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.mediaUrl} alt={a.title ?? ''} className="aspect-square w-full rounded-lg bg-surface-container-low object-contain" />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-surface-container-low text-on-surface-variant"><span className="material-symbols-outlined text-[36px]">image_not_supported</span></div>
        )}
        {a.mediaType && <span className="absolute right-xs top-xs rounded-full bg-primary/80 px-sm py-xs text-label-sm text-on-primary">{MEDIA_LABEL[a.mediaType]}</span>}
      </div>
      <div className="mb-xs flex flex-wrap gap-xs">
        {s.newProductLaunching && <span className="rounded-full bg-secondary/15 px-sm py-xs text-label-sm text-secondary">🚀 New Product Launching</span>}
        {s.adStyle && <span className="rounded-full bg-surface-container px-sm py-xs text-label-sm text-on-surface-variant">{STYLE_LABEL[s.adStyle]}</span>}
        {s.isNew && <span className="rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">New</span>}
        {s.isLongRunning && <span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">Long-running</span>}
        {s.isScaling && <span className="rounded-full bg-primary/10 px-sm py-xs text-label-sm text-primary">Scaling</span>}
        {s.isStopped && <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">Stopped</span>}
      </div>
      <p className="line-clamp-2 text-label-md font-bold text-primary">{a.title ?? a.advertiser.pageName ?? 'Ad'}</p>
      <p className="mt-xs line-clamp-2 text-body-sm text-on-surface-variant">{a.body}</p>
      <p className="mt-xs text-body-sm text-on-surface-variant">{a.advertiser.pageName} · {s.activeDays}d</p>
      {a.adLibraryUrl && <a href={a.adLibraryUrl} target="_blank" rel="noreferrer" className="mt-xs block truncate text-label-sm text-secondary hover:underline" title={a.adArchiveId}>#{a.adArchiveId}</a>}
      <div className="mt-sm flex items-center justify-between">
        <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
        <button onClick={() => onSave(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
      </div>
    </article>
  )
}

function DomainBlock({ domain, onScan, onRemove, onSaveIdea, onChanged }: { domain: AdDomain; onScan: () => void; onRemove: () => void; onSaveIdea: (a: Ad) => void; onChanged: () => void }) {
  const [pages, setPages] = useState<PageTarget[]>([])
  const [ads, setAds] = useState<Ad[]>([])
  const [pageUrl, setPageUrl] = useState('')
  const [term, setTerm] = useState(domain.searchTerm)

  async function load() {
    setPages(await fetch(`/api/spy/pages?adDomainId=${domain.id}`).then(r => r.json()))
    const d = await fetch(`/api/spy/ads?domainId=${domain.id}`).then(r => r.json()); setAds(d.ads ?? [])
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [domain.id])

  async function saveTerm() {
    await fetch('/api/spy/ad-domains', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: domain.id, searchTerm: term }) })
    onChanged()
  }
  async function addPage() {
    if (!pageUrl.trim()) return
    await fetch('/api/spy/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageUrl, adDomainId: domain.id }) })
    setPageUrl(''); load()
  }
  async function scanPage(id: string) {
    await fetch('/api/spy/scan-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: id }) })
    setTimeout(load, 30000)
  }
  async function removePage(id: string) {
    await fetch('/api/spy/pages', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    load()
  }

  return (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <div className="mb-md flex flex-wrap items-center gap-sm">
        <h3 className="text-headline-sm text-primary">{domain.domain}</h3>
        <span className="text-body-sm text-on-surface-variant">{domain.pageCount} pages · {domain.adCount} ads · {domain.newAdCount} new</span>
        <input value={term} onChange={e => setTerm(e.target.value)} className="ml-auto w-48 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-xs text-body-sm" />
        <button onClick={saveTerm} className="rounded-lg bg-surface-container px-md py-xs text-label-sm">Save term</button>
        <button onClick={onScan} className="rounded-lg bg-primary px-md py-xs text-label-sm text-on-primary">Scan domain</button>
        <button onClick={onRemove} className="text-error text-label-sm hover:underline">Xoá</button>
      </div>

      <div className="mb-md">
        <p className="mb-xs text-label-sm uppercase tracking-wider text-on-surface-variant">Fanpages</p>
        <div className="mb-sm flex gap-sm">
          <input value={pageUrl} onChange={e => setPageUrl(e.target.value)} placeholder="https://www.facebook.com/BrandPage"
            className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-sm outline-none focus:border-secondary" />
          <button onClick={addPage} className="rounded-lg bg-secondary px-lg py-sm text-label-sm text-on-secondary">Add fanpage</button>
        </div>
        <ul className="divide-y divide-outline-variant/20">
          {pages.map(p => (
            <li key={p.id} className="flex items-center justify-between py-xs">
              <span className="text-body-sm text-primary">{p.label ?? p.pageUrl}</span>
              <span className="flex items-center gap-md">
                <button onClick={() => scanPage(p.id)} className="text-secondary text-label-sm hover:underline">Scan page</button>
                <button onClick={() => removePage(p.id)} className="text-error text-label-sm hover:underline">Xoá</button>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {ads.map(a => <AdCard key={a.id} a={a} onSave={onSaveIdea} />)}
        {ads.length === 0 && <p className="text-body-md text-on-surface-variant">No ads yet — scan the domain or a fanpage.</p>}
      </div>
    </section>
  )
}

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}
function priceText(min: number | null, max: number | null) {
  if (min == null || max == null) return '-'
  return min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)} - $${max.toFixed(2)}`
}

export default function SpyIdeaPage() {
  const [tab, setTab] = useState<'stores' | 'products' | 'ideas' | 'ads'>('stores')
  const [stores, setStores] = useState<Store[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [adDomains, setAdDomains] = useState<AdDomain[]>([])
  const [newAds, setNewAds] = useState<Ad[]>([])
  const [domain, setDomain] = useState('')
  const [domainInput, setDomainInput] = useState('')
  const [scanning, setScanning] = useState(false)

  async function loadStores() { setStores(await fetch('/api/spy/stores').then(r => r.json())) }
  async function loadProducts() { const d = await fetch('/api/spy/products?days=30').then(r => r.json()); setProducts(d.products ?? []) }
  async function loadIdeas() { setIdeas(await fetch('/api/spy/ideas').then(r => r.json())) }
  async function loadAdDomains() { setAdDomains(await fetch('/api/spy/ad-domains').then(r => r.json())) }
  async function loadNewAds() { const d = await fetch('/api/spy/ads?filter=new').then(r => r.json()); setNewAds(d.ads ?? []) }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadStores(); loadProducts(); loadIdeas(); loadAdDomains(); loadNewAds() }, [])

  async function addStore() {
    if (!domain.trim()) return
    await fetch('/api/spy/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) })
    setDomain(''); loadStores()
  }
  async function removeStore(id: string) {
    await fetch('/api/spy/stores', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    loadStores()
  }
  async function scanAll() {
    setScanning(true)
    try { await fetch('/api/spy/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); await loadProducts(); await loadStores() }
    finally { setScanning(false) }
  }
  async function saveIdea(p: Product) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: p.title ?? 'Untitled', refType: 'PRODUCT', refProductId: p.id, snapshotJson: p }) })
    loadIdeas()
  }
  async function addAdDomain() {
    if (!domainInput.trim()) return
    await fetch('/api/spy/ad-domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: domainInput }) })
    setDomainInput(''); loadAdDomains()
  }
  async function scanDomain(id: string) {
    await fetch('/api/spy/scan-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domainId: id }) })
    setTimeout(() => { loadAdDomains(); loadNewAds() }, 30000)
  }
  async function removeAdDomain(id: string) {
    await fetch('/api/spy/ad-domains', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    loadAdDomains()
  }
  async function saveAdIdea(a: Ad) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: a.title ?? a.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: a.id, snapshotJson: a }) })
    loadIdeas()
  }

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t === 'ads' || t === 'products' || t === 'stores' || t === 'ideas') setTab(t)
  }, [])

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
            <h2 className="text-display-md font-bold text-primary">Spy Idea</h2>
          </header>

          <SpySectionNav
            active={tab}
            items={[
              { key: 'dashboard', label: 'Dashboard', icon: 'space_dashboard', href: '/tools/spy-idea/dashboard' },
              { key: 'ads', label: 'Ad Library', icon: 'library_books', onClick: () => setTab('ads') },
              { key: 'products', label: 'Products', icon: 'inventory_2', onClick: () => setTab('products') },
              { key: 'stores', label: 'Stores', icon: 'storefront', onClick: () => setTab('stores') },
              { key: 'ideas', label: 'Ideas', icon: 'lightbulb', onClick: () => setTab('ideas') },
              { key: 'niches', label: 'Niches', icon: 'sell', href: '/tools/spy-idea/niches' },
            ]}
          />

          {tab === 'stores' && (
            <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
              <div className="mb-md flex gap-sm">
                <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="store.myshopify.com"
                  className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
                <button onClick={addStore} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add store</button>
                <button onClick={scanAll} disabled={scanning} className="rounded-lg bg-primary px-lg py-sm text-label-md text-on-primary disabled:opacity-50">
                  {scanning ? 'Scanning…' : 'Scan now'}
                </button>
              </div>
              <ul className="divide-y divide-outline-variant/20">
                {stores.map(s => (
                  <li key={s.id} className="flex items-center justify-between py-sm">
                    <div><p className="text-label-md text-primary">{s.domain}</p><p className="text-body-sm text-on-surface-variant">{s._count?.products ?? 0} products · {s.status}</p></div>
                    <button onClick={() => removeStore(s.id)} className="text-error text-label-sm hover:underline">Remove</button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tab === 'products' && (
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {products.map(p => (
                <article key={p.id} className="overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
                  <div className="aspect-square bg-surface-container-low">
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.imageUrl} alt={p.title ?? ''} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-on-surface-variant"><span className="material-symbols-outlined text-[42px]">image_not_supported</span></div>
                    )}
                  </div>
                  <div className="p-md">
                    <p className="line-clamp-2 text-label-md font-bold text-primary">{p.title}</p>
                    <p className="mt-xs text-body-sm text-on-surface-variant">{p.store.domain} · {formatDate(p.firstSeenAt)}</p>
                    <p className="text-body-sm text-on-surface-variant">{priceText(p.priceMin, p.priceMax)}</p>
                    <button onClick={() => saveIdea(p)} className="mt-sm text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {tab === 'ideas' && (
            <ul className="space-y-sm">
              {ideas.map(i => (
                <li key={i.id} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                  <p className="text-label-md text-primary">{i.title}</p>
                  <p className="text-body-sm text-on-surface-variant">{i.status} · {formatDate(i.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}

          {tab === 'ads' && (
            <div className="space-y-lg">
              <section>
                <h3 className="mb-md text-headline-sm text-primary">🆕 New Ads (just launched)</h3>
                <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {newAds.map(a => <AdCard key={a.id} a={a} onSave={saveAdIdea} />)}
                  {newAds.length === 0 && <p className="text-body-md text-on-surface-variant">No newly launched ads.</p>}
                </div>
              </section>

              <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
                <div className="flex gap-sm">
                  <input value={domainInput} onChange={e => setDomainInput(e.target.value)} placeholder="familystore.com"
                    className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
                  <button onClick={addAdDomain} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add domain</button>
                </div>
              </section>

              {adDomains.map(d => <DomainBlock key={d.id} domain={d} onScan={() => scanDomain(d.id)} onRemove={() => removeAdDomain(d.id)} onSaveIdea={saveAdIdea} onChanged={loadAdDomains} />)}
            </div>
          )}
        </main>
      </div>
    </RoleGate>
  )
}
