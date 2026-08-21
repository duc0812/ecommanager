'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Summary = { newProducts7d: number; activeAds: number; scalingAds: number; trendingNiches: number }
type Product = { id: string; title: string | null; imageUrl: string | null; priceMin: number | null; priceMax: number | null; firstSeenAt: string; productType: string | null; store: { domain: string } }
type AdSignals = { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean }
type Ad = { id: string; title: string | null; body: string | null; advertiser: { pageName: string | null }; signals: AdSignals; startDate: string | null }
type TrendingNiche = { niche: string; newCount: number; prevCount: number; deltaPct: number; topStores: string[] }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}
function priceText(min: number | null, max: number | null) {
  if (min == null || max == null) return '-'
  return min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)} - $${max.toFixed(2)}`
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">{label}</p>
      <p className="mt-xs text-stats-lg text-primary">{value}</p>
    </div>
  )
}

function AdBadges({ s }: { s: AdSignals }) {
  return (
    <div className="mb-xs flex flex-wrap gap-xs">
      {s.isNew && <span className="rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">New</span>}
      {s.isLongRunning && <span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">Long-running</span>}
      {s.isScaling && <span className="rounded-full bg-primary/10 px-sm py-xs text-label-sm text-primary">Scaling</span>}
      {s.isStopped && <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">Stopped</span>}
    </div>
  )
}

export default function SpyDashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [ads, setAds] = useState<Ad[]>([])
  const [niches, setNiches] = useState<TrendingNiche[]>([])
  const [winningAds, setWinningAds] = useState<Ad[]>([])
  const [adFilter, setAdFilter] = useState('')

  async function loadAds() {
    const d = await fetch(`/api/spy/ads${adFilter ? `?filter=${adFilter}` : ''}`).then(r => r.json())
    setAds(d.ads ?? [])
  }

  useEffect(() => {
    fetch('/api/spy/dashboard/summary').then(r => r.json()).then(setSummary).catch(() => {})
    fetch('/api/spy/products?days=30').then(r => r.json()).then(d => setProducts(d.products ?? [])).catch(() => {})
    fetch('/api/spy/trending?days=7').then(r => r.json()).then(d => { setNiches(d.niches ?? []); setWinningAds(d.winningAds ?? []) }).catch(() => {})
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadAds() }, [adFilter])

  async function saveProductIdea(p: Product) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: p.title ?? 'Product', refType: 'PRODUCT', refProductId: p.id, snapshotJson: p }) })
  }
  async function saveAdIdea(a: Ad) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: a.title ?? a.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: a.id, snapshotJson: a }) })
  }

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
            <h2 className="text-display-md font-bold text-primary">Spy Dashboard</h2>
          </header>

          {summary && (
            <div className="mb-xl grid grid-cols-2 gap-lg md:grid-cols-4">
              <Stat label="New products 7d" value={summary.newProducts7d} />
              <Stat label="Active ads" value={summary.activeAds} />
              <Stat label="Scaling ads" value={summary.scalingAds} />
              <Stat label="Trending niches" value={summary.trendingNiches} />
            </div>
          )}

          <section className="mb-xl">
            <h3 className="mb-md text-headline-sm text-primary">Trending niches</h3>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3">
              {niches.map(n => (
                <div key={n.niche} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                  <div className="flex items-center justify-between">
                    <p className="text-label-md font-bold text-primary">{n.niche}</p>
                    <span className={`rounded-full px-sm py-xs text-label-sm ${n.deltaPct >= 0 ? 'bg-on-tertiary-container/15 text-on-tertiary-container' : 'bg-error/10 text-error'}`}>{n.deltaPct >= 0 ? '+' : ''}{n.deltaPct}%</span>
                  </div>
                  <p className="mt-xs text-body-sm text-on-surface-variant">{n.newCount} new (prev {n.prevCount})</p>
                  {n.topStores.length > 0 && <p className="mt-xs text-body-sm text-on-surface-variant">{n.topStores.join(' · ')}</p>}
                </div>
              ))}
              {niches.length === 0 && <p className="text-body-md text-on-surface-variant">No trending niches yet.</p>}
            </div>
          </section>

          <section className="mb-xl">
            <h3 className="mb-md text-headline-sm text-primary">Winning / scaling ads</h3>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {winningAds.map(a => (
                <article key={a.id} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                  <AdBadges s={a.signals} />
                  <p className="line-clamp-2 text-label-md font-bold text-primary">{a.title ?? a.advertiser.pageName ?? 'Ad'}</p>
                  <p className="mt-xs line-clamp-2 text-body-sm text-on-surface-variant">{a.body}</p>
                  <p className="mt-xs text-body-sm text-on-surface-variant">{a.advertiser.pageName} · {a.signals.activeDays}d</p>
                  <div className="mt-sm flex items-center justify-between">
                    <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
                    <button onClick={() => saveAdIdea(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
                  </div>
                </article>
              ))}
              {winningAds.length === 0 && <p className="text-body-md text-on-surface-variant">No winning ads yet.</p>}
            </div>
          </section>

          <section className="mb-xl">
            <div className="mb-md flex items-center gap-md">
              <h3 className="text-headline-sm text-primary">Ads</h3>
              <div className="flex gap-xs">
                {['', 'new', 'long-running', 'scaling', 'stopped'].map(f => (
                  <button key={f} onClick={() => setAdFilter(f)} className={`rounded-md px-md py-xs text-label-sm ${adFilter === f ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant'}`}>{f === '' ? 'All' : f}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {ads.map(a => (
                <article key={a.id} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                  <AdBadges s={a.signals} />
                  <p className="line-clamp-2 text-label-md font-bold text-primary">{a.title ?? a.advertiser.pageName ?? 'Ad'}</p>
                  <p className="mt-xs text-body-sm text-on-surface-variant">{a.advertiser.pageName} · {a.signals.activeDays}d · {formatDate(a.startDate)}</p>
                  <div className="mt-sm flex items-center justify-between">
                    <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
                    <button onClick={() => saveAdIdea(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="mb-xl">
            <h3 className="mb-md text-headline-sm text-primary">New products</h3>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {products.map(p => (
                <article key={p.id} className="overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
                  <div className="aspect-square bg-surface-container-low">
                    {p.imageUrl
                      ? // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.imageUrl} alt={p.title ?? ''} className="h-full w-full object-cover" />
                      : <div className="flex h-full items-center justify-center text-on-surface-variant"><span className="material-symbols-outlined text-[42px]">image_not_supported</span></div>}
                  </div>
                  <div className="p-md">
                    <p className="line-clamp-2 text-label-md font-bold text-primary">{p.title}</p>
                    <p className="mt-xs text-body-sm text-on-surface-variant">{p.store.domain} · {formatDate(p.firstSeenAt)}</p>
                    <p className="text-body-sm text-on-surface-variant">{priceText(p.priceMin, p.priceMax)}</p>
                    <button onClick={() => saveProductIdea(p)} className="mt-sm text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </main>
      </div>
    </RoleGate>
  )
}
