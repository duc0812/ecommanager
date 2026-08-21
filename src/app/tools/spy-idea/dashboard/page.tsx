'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Summary = { activeAds: number; newLaunchingAds: number; scalingAds: number; longRunningAds: number }
type Signals = { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean; adStyle: 'product'|'collection'|'homepage'|'other'|null; newProductLaunching: boolean }
type Ad = { id: string; title: string | null; body: string | null; adArchiveId: string; adLibraryUrl: string | null; linkUrl: string | null; isActive: boolean; startDate: string | null; advertiser: { pageName: string | null }; signals: Signals }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">{label}</p>
      <p className="mt-xs text-stats-lg text-primary">{value}</p>
    </div>
  )
}

const STYLE_LABEL: Record<string, string> = { product: 'Product', collection: 'Collection', homepage: 'Homepage', other: 'Other' }

function AdCard({ a, onSave }: { a: Ad; onSave: (a: Ad) => void }) {
  const s = a.signals
  return (
    <article className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
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
      <p className="mt-xs text-body-sm text-on-surface-variant">{a.advertiser.pageName} · {s.activeDays}d · {formatDate(a.startDate)}</p>
      {a.adLibraryUrl && (
        <a href={a.adLibraryUrl} target="_blank" rel="noreferrer" className="mt-xs block truncate text-label-sm text-secondary hover:underline" title={a.adArchiveId}>
          #{a.adArchiveId}
        </a>
      )}
      <div className="mt-sm flex items-center justify-between">
        <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
        <button onClick={() => onSave(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
      </div>
    </article>
  )
}

export default function SpyDashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [allAds, setAllAds] = useState<Ad[]>([])
  const [adFilter, setAdFilter] = useState('active')

  useEffect(() => {
    fetch('/api/spy/dashboard/summary').then(r => r.json()).then(setSummary).catch(() => {})
    fetch('/api/spy/ads?limit=500').then(r => r.json()).then(d => setAllAds(d.ads ?? [])).catch(() => {})
  }, [])

  // Winning = long-running or scaling, always from the full unfiltered set.
  const winning = [...allAds].filter(a => a.signals.isLongRunning || a.signals.isScaling).sort((x, y) => y.signals.activeDays - x.signals.activeDays).slice(0, 20)

  // Feed = full set filtered client-side by chip.
  const feed = allAds.filter(a => {
    if (adFilter === 'active') return a.isActive
    if (adFilter === 'new') return a.signals.isNew
    if (adFilter === 'long-running') return a.signals.isLongRunning
    if (adFilter === 'scaling') return a.signals.isScaling
    if (adFilter === 'stopped') return a.signals.isStopped
    return true
  })

  async function saveIdea(a: Ad) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: a.title ?? a.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: a.id, snapshotJson: a }) })
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
              <Stat label="Active ads" value={summary.activeAds} />
              <Stat label="New Product Launching" value={summary.newLaunchingAds} />
              <Stat label="Scaling ads" value={summary.scalingAds} />
              <Stat label="Long-running ads" value={summary.longRunningAds} />
            </div>
          )}

          <section className="mb-xl">
            <h3 className="mb-md text-headline-sm text-primary">Winning / scaling ads</h3>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {winning.map(a => <AdCard key={a.id} a={a} onSave={saveIdea} />)}
              {winning.length === 0 && <p className="text-body-md text-on-surface-variant">No winning ads yet.</p>}
            </div>
          </section>

          <section className="mb-xl">
            <div className="mb-md flex items-center gap-md">
              <h3 className="text-headline-sm text-primary">Ads</h3>
              <div className="flex flex-wrap gap-xs">
                {['active', 'new', 'long-running', 'scaling', 'stopped', 'all'].map(f => (
                  <button key={f} onClick={() => setAdFilter(f)} className={`rounded-md px-md py-xs text-label-sm capitalize ${adFilter === f ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant'}`}>{f}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {feed.map(a => <AdCard key={a.id} a={a} onSave={saveIdea} />)}
              {feed.length === 0 && <p className="text-body-md text-on-surface-variant">No ads for this filter.</p>}
            </div>
          </section>
        </main>
      </div>
    </RoleGate>
  )
}
