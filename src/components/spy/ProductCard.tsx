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
  const base = 'inline-flex h-[20px] items-center rounded-[5px] px-[8px] text-[10.5px] font-medium'
  if (delta === null || delta === undefined) return <span className={`${base} bg-[#EDEBFB] text-[#4B45C6]`}>NEW</span>
  if (delta > 0) return <span className={`${base} bg-[#E7EDE9] text-[#3F7A57]`}>▲{delta}</span>
  if (delta < 0) return <span className={`${base} bg-[#F6E7E7] text-[#B3524B]`}>▼{Math.abs(delta)}</span>
  return <span className={`${base} bg-[#F2F1EE] text-[#78716C]`}>—</span>
}

export default function ProductCard({ p, onSave, rank, rankDelta }: { p: Product; onSave: (p: Product) => void; rank?: number; rankDelta?: number | null }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-[14px] border border-[#E6E3DE] bg-white transition-all duration-200 hover:-translate-y-0.5 hover:border-[#D6D2CB] hover:shadow-[0_12px_28px_-18px_rgba(27,26,23,0.35)]">
      {rank !== undefined && (
        <div className="absolute left-[10px] top-[10px] z-10 flex items-center gap-[5px]">
          <span className="rounded-[6px] bg-[#1B1A17]/80 px-[8px] py-[4px] font-[family-name:var(--font-plex-mono)] text-[10px] font-medium text-white backdrop-blur-sm">#{rank}</span>
          <TrendBadge delta={rankDelta} />
        </div>
      )}
      <div className="aspect-[4/5] overflow-hidden bg-[#F2F1EE]">
        {p.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.imageUrl} alt={p.title ?? ''} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[#57534E]"><span className="material-symbols-outlined text-[42px]">image_not_supported</span></div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-[8px] p-[16px]">
        <h3 className="line-clamp-2 text-[14.5px] font-semibold leading-[1.3] tracking-[-0.012em] text-[#1B1A17]">{p.title}</h3>
        <div className="flex items-center gap-[6px] text-[11.5px] text-[#57534E]">
          <span className="truncate font-medium">{p.store.domain}</span>
          <span className="ml-auto font-[family-name:var(--font-plex-mono)] text-[10.5px] text-[#57534E]">{formatDate(p.firstSeenAt)}</span>
        </div>
        <p className="text-[13px] font-semibold text-[#1B1A17]">{priceText(p.priceMin, p.priceMax)}</p>
        <div className="mt-auto flex items-center border-t border-[#EFEDE9] pt-[12px]">
          <button onClick={() => onSave(p)} className="ml-auto flex h-[28px] items-center rounded-[7px] bg-[#3F3AC4] px-[10px] text-[11.5px] font-medium text-white transition-colors hover:bg-[#201C8F]">+ Save idea</button>
        </div>
      </div>
    </article>
  )
}
