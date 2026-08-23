'use client'
import { useEffect, useState } from 'react'
import type { Ad } from './AdCard'

type Obs = { id: string; isActive: boolean; collationCount: number | null; observedAt: string }
type Detail = {
  ad: { caption: string | null; ctaText: string | null; endDate: string | null; advertiser: { pageName: string | null; pageCategory: string | null; likes: number | null }; observations: Obs[] }
}

const MEDIA_LABEL: Record<string, string> = { video: 'Video', image: 'Image', carousel: 'Carousel', dco: 'DCO' }
const STYLE_LABEL: Record<string, string> = { product: 'Product', collection: 'Collection', homepage: 'Homepage', other: 'Other' }
const CHIP = 'inline-flex h-[20px] items-center rounded-[5px] px-[8px] text-[10.5px] font-medium'

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}

export default function AdDetailModal({ ad, onClose, onSave }: { ad: Ad; onClose: () => void; onSave: (a: Ad) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    fetch(`/api/spy/ads/${ad.id}`).then(r => r.json()).then(setDetail).catch(() => {})
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [ad.id, onClose])

  const s = ad.signals
  const adv = detail?.ad.advertiser

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-[#1B1A17]/50 p-4 backdrop-blur-sm">
      <div onClick={e => e.stopPropagation()} className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-[16px] border border-[#E6E3DE] bg-white shadow-[0_24px_60px_-20px_rgba(27,26,23,0.5)]">
        <button onClick={onClose} aria-label="Close" className="absolute right-[14px] top-[14px] z-10 flex h-[32px] w-[32px] items-center justify-center rounded-full bg-white/85 text-[#57534E] backdrop-blur-sm transition-colors hover:bg-white hover:text-[#1B1A17]">
          <span className="material-symbols-outlined text-[20px]">close</span>
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="relative bg-[#F2F1EE]">
            {ad.mediaUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ad.mediaUrl} alt={ad.title ?? ''} className="max-h-[48vh] w-full object-contain" />
            ) : (
              <div className="flex h-[220px] w-full items-center justify-center text-[#57534E]"><span className="material-symbols-outlined text-[42px]">image_not_supported</span></div>
            )}
            {ad.mediaType && (
              <div className="absolute left-[14px] top-[14px] flex items-center gap-[5px] rounded-[6px] bg-[#1B1A17]/80 px-[8px] py-[4px] text-[10px] font-medium text-white backdrop-blur-sm">
                <span className="h-[5px] w-[5px] rounded-full bg-[#8FD6A4]" />{MEDIA_LABEL[ad.mediaType]}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-[14px] p-[24px]">
            <div>
              <h2 className="text-[20px] font-semibold leading-[1.25] tracking-[-0.02em] text-[#1B1A17]">{ad.title ?? ad.advertiser.pageName ?? 'Ad'}</h2>
              <p className="mt-[6px] text-[12.5px] text-[#57534E]">
                {ad.advertiser.pageName}{adv?.pageCategory ? ` · ${adv.pageCategory}` : ''} · {s.activeDays} active days{typeof adv?.likes === 'number' ? ` · ${adv.likes.toLocaleString('en-US')} likes` : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-[6px]">
              {s.adStyle && <span className={`${CHIP} bg-[#F2F1EE] text-[#78716C]`}>{STYLE_LABEL[s.adStyle]}</span>}
              {s.newProductLaunching && <span className={`${CHIP} bg-[#EDEBFB] text-[#4B45C6]`}>🚀 Launching</span>}
              {s.isNew && <span className={`${CHIP} bg-[#EDEBFB] text-[#4B45C6]`}>New</span>}
              {s.isLongRunning && <span className={`${CHIP} bg-[#E7EDE9] text-[#3F7A57]`}>Long-running</span>}
              {s.isScaling && <span className={`${CHIP} bg-[#EDEBFB] text-[#4B45C6]`}>Scaling</span>}
              {s.isStopped && <span className={`${CHIP} bg-[#F6E7E7] text-[#B3524B]`}>Stopped</span>}
              <span className="ml-auto font-[family-name:var(--font-plex-mono)] text-[10.5px] text-[#57534E]">{formatDate(ad.startDate)}</span>
            </div>

            {ad.body && <p className="whitespace-pre-wrap text-[13.5px] leading-[1.6] text-[#3F3A35]">{ad.body}</p>}
            {detail?.ad.caption && <p className="text-[12.5px] text-[#57534E]">{detail.ad.caption}</p>}

            <div className="flex flex-col gap-[8px] rounded-[12px] border border-[#EFEDE9] bg-[#FAF9F7] p-[14px]">
              {ad.linkUrl && (
                <a href={ad.linkUrl} target="_blank" rel="noreferrer" title={ad.linkUrl} className="flex items-center gap-[6px] text-[#57534E] transition-colors hover:text-[#3F3AC4]">
                  <span className="material-symbols-outlined text-[15px] text-[#57534E]">link</span>
                  <span className="truncate font-[family-name:var(--font-plex-mono)] text-[11.5px]">{ad.linkUrl}</span>
                </a>
              )}
              {s.adStyle === 'product' && ad.productPublishedAt && (
                <p className="font-[family-name:var(--font-plex-mono)] text-[11px] text-[#57534E]">Product uploaded {formatDate(ad.productPublishedAt)}</p>
              )}
              {ad.adLibraryUrl && (
                <a href={ad.adLibraryUrl} target="_blank" rel="noreferrer" className="flex items-center gap-[6px] text-[#57534E] transition-colors hover:text-[#3F3AC4]">
                  <span className="material-symbols-outlined text-[15px] text-[#57534E]">open_in_new</span>
                  <span className="truncate font-[family-name:var(--font-plex-mono)] text-[11.5px]">Ad Library #{ad.adArchiveId}</span>
                </a>
              )}
            </div>

            <div>
              <h3 className="mb-[10px] text-[13px] font-semibold text-[#1B1A17]">Run timeline</h3>
              {!detail ? (
                <p className="text-[12.5px] text-[#78716C]">Loading…</p>
              ) : detail.ad.observations.length === 0 ? (
                <p className="text-[12.5px] text-[#78716C]">No observations yet.</p>
              ) : (
                <ul className="flex flex-col gap-[6px]">
                  {detail.ad.observations.map(o => (
                    <li key={o.id} className="flex items-center gap-[12px] rounded-[8px] bg-[#F7F6F4] px-[12px] py-[8px] text-[12px]">
                      <span className={o.isActive ? 'text-[#3F7A57]' : 'text-[#B3524B]'}>{o.isActive ? 'Active' : 'Inactive'}</span>
                      <span className="text-[#78716C]">collation {o.collationCount ?? '-'}</span>
                      <span className="ml-auto font-[family-name:var(--font-plex-mono)] text-[11px] text-[#57534E]">{formatDate(o.observedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-[8px] border-t border-[#EFEDE9] bg-white px-[24px] py-[14px]">
          <a href={`/tools/spy-idea/ads/${ad.id}`} className="text-[12px] text-[#8A847C] transition-colors hover:text-[#1B1A17]">Open full page ↗</a>
          <div className="ml-auto flex gap-[8px]">
            <button onClick={onClose} className="h-[34px] rounded-[8px] border border-[#E6E3DE] bg-white px-[14px] text-[12.5px] text-[#57534E] transition-colors hover:bg-[#F7F6F4]">Close</button>
            <button onClick={() => onSave(ad)} className="h-[34px] rounded-[8px] bg-[#3F3AC4] px-[14px] text-[12.5px] font-medium text-white transition-colors hover:bg-[#201C8F]">+ Save idea</button>
          </div>
        </div>
      </div>
    </div>
  )
}
