'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Store = { id: string; domain: string; name: string | null; status: string; _count?: { products: number } }
type Product = { id: string; title: string | null; handle: string | null; imageUrl: string | null; priceMin: number | null; priceMax: number | null; firstSeenAt: string; productType: string | null; store: { domain: string } }
type Idea = { id: string; title: string; note: string | null; status: string; createdAt: string }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}
function priceText(min: number | null, max: number | null) {
  if (min == null || max == null) return '-'
  return min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)} - $${max.toFixed(2)}`
}

export default function SpyIdeaPage() {
  const [tab, setTab] = useState<'stores' | 'products' | 'ideas'>('stores')
  const [stores, setStores] = useState<Store[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [domain, setDomain] = useState('')
  const [scanning, setScanning] = useState(false)

  async function loadStores() { setStores(await fetch('/api/spy/stores').then(r => r.json())) }
  async function loadProducts() { const d = await fetch('/api/spy/products?days=30').then(r => r.json()); setProducts(d.products ?? []) }
  async function loadIdeas() { setIdeas(await fetch('/api/spy/ideas').then(r => r.json())) }

  useEffect(() => { loadStores(); loadProducts(); loadIdeas() }, [])

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

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-xl">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
            <h2 className="text-display-md font-bold text-primary">Spy Idea</h2>
          </header>

          <div className="mb-lg inline-flex rounded-lg bg-surface-container p-xs">
            {(['stores','products','ideas'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`rounded-md px-md py-xs text-label-sm capitalize ${tab === t ? 'bg-secondary text-on-secondary' : 'text-on-surface-variant'}`}>
                {t}
              </button>
            ))}
          </div>

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
        </main>
      </div>
    </RoleGate>
  )
}
