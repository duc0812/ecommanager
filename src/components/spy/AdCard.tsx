'use client'

export type AdSignals = { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean; adStyle: 'product'|'collection'|'homepage'|'other'|null; newProductLaunching: boolean }
export type Ad = { id: string; title: string | null; body: string | null; adArchiveId: string; adLibraryUrl: string | null; linkUrl?: string | null; isActive?: boolean; mediaUrl: string | null; mediaType: 'video'|'image'|'carousel'|'dco'|null; startDate: string | null; productPublishedAt?: string | null; advertiser: { pageName: string | null }; signals: AdSignals }

const MEDIA_LABEL: Record<string, string> = { video: '🎬 Video', image: '🖼 Image', carousel: '🎠 Carousel', dco: 'DCO' }
const STYLE_LABEL: Record<string, string> = { product: 'Product', collection: 'Collection', homepage: 'Homepage', other: 'Other' }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}

export default function AdCard({ a, onSave }: { a: Ad; onSave: (a: Ad) => void }) {
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
      <p className="mt-xs text-body-sm text-on-surface-variant">{a.advertiser.pageName} · {s.activeDays}d · {formatDate(a.startDate)}</p>
      {a.adLibraryUrl && <a href={a.adLibraryUrl} target="_blank" rel="noreferrer" className="mt-xs block truncate text-label-sm text-secondary hover:underline" title={a.adArchiveId}>#{a.adArchiveId}</a>}
      {a.linkUrl && (
        <a href={a.linkUrl} target="_blank" rel="noreferrer" title={a.linkUrl} className="mt-xs block truncate text-label-sm text-secondary hover:underline">🔗 {a.linkUrl}</a>
      )}
      {a.signals.adStyle === 'product' && a.productPublishedAt && (
        <p className="mt-xs text-body-sm text-on-surface-variant">Product uploaded: {formatDate(a.productPublishedAt)}</p>
      )}
      <div className="mt-sm flex items-center justify-between">
        <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
        <button onClick={() => onSave(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
      </div>
    </article>
  )
}
