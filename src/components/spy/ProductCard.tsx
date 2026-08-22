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

export default function ProductCard({ p, onSave }: { p: Product; onSave: (p: Product) => void }) {
  return (
    <article className="overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
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
