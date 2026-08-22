'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}

type Obs = { id: string; isActive: boolean; collationCount: number | null; observedAt: string }
type AdDetail = {
  ad: { id: string; title: string | null; body: string | null; caption: string | null; ctaText: string | null; linkUrl: string | null; adLibraryUrl: string | null; mediaType: string | null; mediaUrl: string | null; startDate: string | null; endDate: string | null; advertiser: { pageName: string | null; pageCategory: string | null; likes: number | null }; observations: Obs[] }
  signals: { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean }
}

export default function AdDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<AdDetail | null>(null)

  useEffect(() => { fetch(`/api/spy/ads/${id}`).then(r => r.json()).then(setData).catch(() => {}) }, [id])

  async function saveIdea() {
    if (!data) return
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: data.ad.title ?? data.ad.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: data.ad.id, snapshotJson: data.ad }) })
  }

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <a href="/tools/spy-idea" className="text-secondary text-label-sm hover:underline">← Back to Spy</a>
          {!data ? (
            <p className="mt-lg text-body-md text-on-surface-variant">Loading…</p>
          ) : (
            <div className="mt-md max-w-3xl">
              <h2 className="text-display-md font-bold text-primary">{data.ad.title ?? data.ad.advertiser.pageName ?? 'Ad'}</h2>
              <p className="text-body-sm text-on-surface-variant">{data.ad.advertiser.pageName} · {data.ad.advertiser.pageCategory} · {data.signals.activeDays} active days</p>
              <div className="my-md flex flex-wrap gap-xs">
                {data.signals.isNew && <span className="rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">New</span>}
                {data.signals.isLongRunning && <span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">Long-running</span>}
                {data.signals.isScaling && <span className="rounded-full bg-primary/10 px-sm py-xs text-label-sm text-primary">Scaling</span>}
                {data.signals.isStopped && <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">Stopped</span>}
              </div>
              <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
                {data.ad.mediaUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={data.ad.mediaUrl} alt={data.ad.title ?? ''} className="mb-md max-h-96 w-full rounded-lg object-contain" />
                )}
                <p className="whitespace-pre-wrap text-body-md text-primary">{data.ad.body}</p>
                {data.ad.caption && <p className="mt-sm text-body-sm text-on-surface-variant">{data.ad.caption}</p>}
                <div className="mt-md flex gap-md text-label-sm">
                  {data.ad.linkUrl && <a href={data.ad.linkUrl} target="_blank" rel="noreferrer" className="text-secondary hover:underline">Landing page</a>}
                  {data.ad.adLibraryUrl && <a href={data.ad.adLibraryUrl} target="_blank" rel="noreferrer" className="text-secondary hover:underline">Ad Library</a>}
                  <button onClick={saveIdea} className="text-secondary hover:underline">＋ Save IDEA</button>
                </div>
              </div>
              <h3 className="mt-lg mb-sm text-headline-sm text-primary">Run timeline</h3>
              <ul className="space-y-xs">
                {data.ad.observations.map(o => (
                  <li key={o.id} className="flex items-center gap-md rounded-lg bg-surface-container px-md py-sm text-body-sm">
                    <span className={o.isActive ? 'text-on-tertiary-container' : 'text-error'}>{o.isActive ? 'Active' : 'Inactive'}</span>
                    <span className="text-on-surface-variant">collation: {o.collationCount ?? '-'}</span>
                    <span className="ml-auto text-on-surface-variant">{formatDate(o.observedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </main>
      </div>
    </RoleGate>
  )
}
