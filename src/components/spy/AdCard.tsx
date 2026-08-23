'use client'
import { useState } from 'react'
import AdDetailModal from './AdDetailModal'

export type AdSignals = { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean; adStyle: 'product'|'collection'|'homepage'|'other'|null; newProductLaunching: boolean }
export type Ad = { id: string; title: string | null; body: string | null; adArchiveId: string; adLibraryUrl: string | null; linkUrl?: string | null; isActive?: boolean; mediaUrl: string | null; mediaType: 'video'|'image'|'carousel'|'dco'|null; startDate: string | null; productPublishedAt?: string | null; advertiser: { pageName: string | null }; signals: AdSignals }

const MEDIA_LABEL: Record<string, string> = { video: 'Video', image: 'Image', carousel: 'Carousel', dco: 'DCO' }
const STYLE_LABEL: Record<string, string> = { product: 'Product', collection: 'Collection', homepage: 'Homepage', other: 'Other' }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}

export default function AdCard({ a, onSave }: { a: Ad; onSave: (a: Ad) => void }) {
  const s = a.signals
  const [open, setOpen] = useState(false)
  return (
    <>
    <article className="group flex flex-col overflow-hidden rounded-[14px] border border-[#E6E3DE] bg-white transition-all duration-200 hover:-translate-y-0.5 hover:border-[#D6D2CB] hover:shadow-[0_12px_28px_-18px_rgba(27,26,23,0.35)]">
      <div className="relative aspect-[4/5] overflow-hidden bg-[#F2F1EE]">
        {a.mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.mediaUrl} alt={a.title ?? ''} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[#57534E]"><span className="material-symbols-outlined text-[36px]">image_not_supported</span></div>
        )}
        {a.mediaType && (
          <div className="absolute left-[10px] top-[10px] flex items-center gap-[5px] rounded-[6px] bg-[#1B1A17]/80 px-[8px] py-[4px] text-[10px] font-medium text-white backdrop-blur-sm">
            <span className="h-[5px] w-[5px] rounded-full bg-[#8FD6A4]" />{MEDIA_LABEL[a.mediaType]}
          </div>
        )}
        <div className="absolute right-[10px] top-[10px] rounded-[6px] bg-white/90 px-[8px] py-[4px] font-[family-name:var(--font-plex-mono)] font-medium text-[10px] text-[#57534E]">{s.activeDays}d</div>
      </div>

      <div className="flex flex-1 flex-col gap-[10px] p-[16px]">
        <div className="flex flex-wrap items-center gap-[6px]">
          {s.adStyle && <span className="inline-flex h-[20px] items-center rounded-[5px] bg-[#F2F1EE] px-[8px] text-[10.5px] font-medium text-[#78716C]">{STYLE_LABEL[s.adStyle]}</span>}
          {s.newProductLaunching && <span className="inline-flex h-[20px] items-center rounded-[5px] bg-[#EDEBFB] px-[8px] text-[10.5px] font-medium text-[#4B45C6]">🚀 Launching</span>}
          {s.isNew && <span className="inline-flex h-[20px] items-center rounded-[5px] bg-[#EDEBFB] px-[8px] text-[10.5px] font-medium text-[#4B45C6]">New</span>}
          {s.isLongRunning && <span className="inline-flex h-[20px] items-center rounded-[5px] bg-[#E7EDE9] px-[8px] text-[10.5px] font-medium text-[#3F7A57]">Long-running</span>}
          {s.isScaling && <span className="inline-flex h-[20px] items-center rounded-[5px] bg-[#EDEBFB] px-[8px] text-[10.5px] font-medium text-[#4B45C6]">Scaling</span>}
          {s.isStopped && <span className="inline-flex h-[20px] items-center rounded-[5px] bg-[#F6E7E7] px-[8px] text-[10.5px] font-medium text-[#B3524B]">Stopped</span>}
          <span className="ml-auto font-[family-name:var(--font-plex-mono)] font-medium text-[10px] text-[#57534E]">{formatDate(a.startDate)}</span>
        </div>

        <h3 className="line-clamp-2 text-[14.5px] font-semibold leading-[1.3] tracking-[-0.012em] text-[#1B1A17]">{a.title ?? a.advertiser.pageName ?? 'Ad'}</h3>
        {a.body && <p className="line-clamp-2 text-[12.5px] font-medium leading-[1.5] text-[#57534E]">{a.body}</p>}
        {a.advertiser.pageName && <p className="text-[11.5px] font-medium text-[#57534E]">{a.advertiser.pageName}</p>}

        <div className="mt-auto flex flex-col gap-2 border-t border-[#EFEDE9] pt-[12px]">
          {a.linkUrl && (
            <a href={a.linkUrl} target="_blank" rel="noreferrer" title={a.linkUrl} className="flex items-center gap-[6px] text-[#57534E] transition-colors hover:text-[#3F3AC4]">
              <span className="material-symbols-outlined text-[14px] text-[#57534E]">link</span>
              <span className="truncate font-[family-name:var(--font-plex-mono)] font-medium text-[11px]">{a.linkUrl}</span>
            </a>
          )}
          {s.adStyle === 'product' && a.productPublishedAt && (
            <p className="font-[family-name:var(--font-plex-mono)] font-medium text-[10.5px] text-[#57534E]">Uploaded {formatDate(a.productPublishedAt)}</p>
          )}
          <div className="flex items-center gap-2">
            {a.adLibraryUrl ? (
              <a href={a.adLibraryUrl} target="_blank" rel="noreferrer" title={a.adArchiveId} className="truncate font-[family-name:var(--font-plex-mono)] font-medium text-[10.5px] text-[#57534E] hover:text-[#57534E]">#{a.adArchiveId}</a>
            ) : (
              <span className="truncate font-[family-name:var(--font-plex-mono)] font-medium text-[10.5px] text-[#57534E]">#{a.adArchiveId}</span>
            )}
            <div className="ml-auto flex gap-[6px]">
              <button onClick={() => setOpen(true)} className="flex h-[28px] items-center rounded-[7px] border border-[#E6E3DE] bg-white px-[10px] text-[11.5px] text-[#57534E] transition-colors hover:bg-[#F7F6F4] hover:text-[#1B1A17]">Detail</button>
              <button onClick={() => onSave(a)} className="flex h-[28px] items-center rounded-[7px] bg-[#3F3AC4] px-[10px] text-[11.5px] font-medium text-white transition-colors hover:bg-[#201C8F]">+ Save idea</button>
            </div>
          </div>
        </div>
      </div>
    </article>
    {open && <AdDetailModal ad={a} onClose={() => setOpen(false)} onSave={onSave} />}
    </>
  )
}
