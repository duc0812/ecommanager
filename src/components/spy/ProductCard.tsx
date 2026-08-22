'use client'

export type Product = { id: string; title: string | null; handle: string | null; imageUrl: string | null; priceMin: number | null; priceMax: number | null; firstSeenAt: string; productType: string | null; store: { domain: string } }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}
function priceText(min: number | null, max: number | null) {
  if (min == null || max == null) return '-'
  return min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)} - $${max.toFixed(2)}`
}
function TrendBadge({ delta }: { delta?: number | null }) {
  if (delta === null || delta === undefined) return <span className="rounded-full bg-secondary/15 px-sm py-xs text-label-sm text-secondary">NEW</span>
  if (delta > 0) return <span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">▲{delta}</span>
  if (delta < 0) return <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">▼{Math.abs(delta)}</span>
  return <span className="rounded-full bg-surface-container px-sm py-xs text-label-sm text-on-surface-variant">—</span>
}

export default function ProductCard({ p, onSave, rank, rankDelta }: { p: Product; onSave: (p: Product) => void; rank?: number; rankDelta?: number | null }) {
  return (
    <article className="relative overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
      {rank !== undefined && (
        <div className="absolute left-xs top-xs z-10 flex items-center gap-xs">
          <span className="rounded-full bg-primary/85 px-sm py-xs text-label-sm text-on-primary">#{rank}</span>
          <TrendBadge delta={rankDelta} />
        </div>
      )}
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
        <button onClick={() => onSave(p)} className="mt-sm text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
      </div>
    </article>
  )
}
